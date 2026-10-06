import { emit } from './bus.mjs';
import { chat } from './llm.mjs';
import { PLACE_KINDS, answeredBy, auraUp, dataRange, findEventDates, findEvents, findOffers, findPlaces, findPlacesNamed, getEvent, getOffer, getPlace, route, subgraph } from './graph.mjs';

/**
 * The crew. Each agent only acts on a message Band delivers to it; everything it needs travels in that message's JSON
 * payload (request, candidates, plan, issues, vetoes), so the Band room is the single source of truth for the run.
 *
 *   BAYBAY   host    the visitor's request → @Scout; the Checker's verdict → the final plan for the visitor
 *   Scout    graph   Crusoe turns the request into filters → Cypher on Neo4j (events on that date, offers, places near
 *                    them, transit) → @Planner with the candidates
 *   Planner  plan    Crusoe picks and orders 3–5 stops (only from the candidates) → shortest transit paths between
 *                    stops from the graph → @Checker
 *   Checker  verify  every stop re-read from the graph (events: date, city, age limit, free, hours; offers: dates, weekday,
 *                    free, free hours, "with a child"; places: in the graph), times in order + a second open
 *                    model's review;
 *                    wrong → back to @Planner (up to 3 drafts, at most 2 vetoes); right → @BAYBAY
 */
const MAX_ROUNDS = 3;
const t = (lang, zh, en) => (lang === 'en' ? en : zh);
const uniq = xs => [...new Set(xs)];
const str = x => (typeof x === 'string' ? x.trim() : '');
const neo = () => auraUp(); // the tool name: the next query goes to Aura (not configured or paused → the local copy)
// 'Neo4j' in a trace text only when Aura answered every query of the step (ctx.engines), else the local copy (or partly)
const via = ctx => answeredBy(ctx.engines);
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;

export function startCrew(room) {
  const runs = new Map();

  // ---------------------------------------------------------------------------------------------- BAYBAY (host)
  async function ask({ text, lang = 'zh', date }, runId) {
    runs.set(runId, { t0: Date.now() });
    if (runs.size > 200) runs.delete(runs.keys().next().value); // runs that never finished
    emit({ type: 'room', runId, from: 'User', to: ['BAYBAY'], kind: 'message', text });
    await room.send('BAYBAY', t(lang, `新请求：「${text}」（${date}）。请从图谱里找候选。`, `New request: "${text}" (${date}). Please pull candidates from the graph.`), ['Scout'], { runId, request: { text, lang, date } }, runId);
  }

  room.join('BAYBAY', async msg => {
    const p = msg.payload ?? {};
    if (msg.from === 'Checker' && Array.isArray(p.plan?.stops) && p.checker) {
      const runId = p.runId;
      emit({ type: 'plan', runId, plan: { ...p.plan, checker: p.checker } });
      await room.event('BAYBAY', 'task', summary(p.plan, p.checker, p.request?.lang ?? 'zh'), runId);
      emit({ type: 'done', runId, ms: Date.now() - (runs.get(runId)?.t0 ?? Date.now()) });
      runs.delete(runId);
      return;
    }
    // a human typing in the Band room ("@BAYBAY a rainy day with kids on 10/17") starts a run too
    if (msg.from === 'User' && !p.runId && msg.text) {
      const runId = `band-${newId()}`, text = msg.text.slice(0, 500);
      emit({ type: 'run', runId, text });
      await ask({ text, lang: /[一-鿿]/.test(text) ? 'zh' : 'en', date: dateIn(text) ?? nextSaturday() }, runId);
    }
  });

  // ---------------------------------------------------------------------------------------------- Scout (graph)
  room.join('Scout', async msg => {
    if (msg.from !== 'BAYBAY') return;
    const { runId, request } = msg.payload ?? {};
    if (!request?.text || !request?.date) return;
    const ctx = { agent: 'Scout', runId, engines: new Set() };
    const lang = request.lang;
    const filters = await chat({
      ...ctx, lang, json: true,
      system: 'You turn a San Francisco day-out request into search filters for a knowledge graph of real events, museum/park offers and places. Reply with ONE JSON object only.',
      user: `Request: ${request.text}\nDate: ${request.date}\nReturn {"freeOnly": bool (true only if they ask for free / cheap), "family": bool (kids, family, all ages), "keywords": [up to 4 short keywords that must appear in an event title, in English AND Chinese, e.g. "halloween","万圣节" — [] if the request is general], "places": [places or landmarks the visitor names, in English AND Chinese, e.g. "Golden Gate Park","金门公园" — [] if none], "interests": [short English tags], "pace": "relaxed"|"packed"}`,
      fallback: () => ruleFilters(request.text),
    });
    const f = { freeOnly: filters.freeOnly === true, family: filters.family === true, keywords: Array.isArray(filters.keywords) ? filters.keywords.map(str).filter(Boolean).slice(0, 6) : [] };
    await room.event('Scout', 'thought', `filters ${JSON.stringify({ date: request.date, ...f, interests: Array.isArray(filters.interests) ? filters.interests.map(str).filter(Boolean) : [] })}`, runId);
    const { snapshot, lastEvent } = dataRange();
    const past = !!lastEvent && request.date > lastEvent; // no events that day: nothing to widen
    // the web UI plans for the date picked; a date written in the text (Band-room runs use it) is only pointed out
    const said = dateIn(request.text);
    if (said && said !== request.date) await room.event('Scout', 'thought', t(lang, `请求里写的是 ${md(said)}，但行程按选的日期 ${md(request.date)} 排；要排那一天，请把日期改成 ${md(said)}。`, `The request mentions ${md(said)}, but the plan is for the date picked, ${md(request.date)}; pick ${md(said)} to plan that day.`), runId);
    if (past) await room.event('Scout', 'thought', t(lang, `${request.date} 在图谱里最后一个活动（${lastEvent}）之后：BAYLINK 目录是 ${snapshot} 的快照，那天没有活动，行程只用优惠和景点。`, `${request.date} is after the last event in the graph (${lastEvent}): the BAYLINK catalog is a snapshot of ${snapshot}, so there are no events that day and the plan uses offers and places only.`), runId);

    await room.event('Scout', 'tool_call', `${neo() ? 'neo4j' : 'localGraph'}.findEvents(${JSON.stringify({ date: request.date, ...f })})`, runId);
    let events = await findEvents({ date: request.date, ...f }, ctx);
    if (!past && events.length < 3 && f.keywords.length) {
      // when matching events do run, from today on ("Halloween" asked for 10/10: 10/17, 10/23, 10/24, 10/31)
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const other = (await findEventDates({ keywords: f.keywords, freeOnly: f.freeOnly, family: f.family, from: today }, ctx))
        .filter(r => !(r.start <= request.date && r.end >= request.date)).map(r => (r.start === r.end ? md(r.start) : `${md(r.start)}–${md(r.end)}`));
      await room.event('Scout', 'thought', t(lang, `关键词命中太少，放宽到当天所有活动${other.length ? `（关键词活动在 ${other.join('、')}）` : ''}`, `few keyword hits — widening to every event that day${other.length ? ` (keyword events on ${other.join(', ')})` : ''}`), runId);
      events = [...events, ...(await findEvents({ date: request.date, freeOnly: f.freeOnly, family: f.family, keywords: [] }, ctx)).filter(e => !events.some(x => x.id === e.id))];
    }
    if (!past && events.length < 3 && f.freeOnly) { await room.event('Scout', 'thought', t(lang, '免费活动太少，把收费活动也列为备选', 'few free events — including paid ones as backups'), runId); events = [...events, ...(await findEvents({ date: request.date, freeOnly: false, family: f.family, keywords: [] }, ctx)).filter(e => !events.some(x => x.id === e.id))]; }
    // offers come date-specific first, then free first; a stop needs a place, so a citywide pass (free Muni) is not one
    const offers = (await findOffers({ date: request.date }, ctx)).filter(o => o.kind !== 'transit' && o.hoodId && (!f.freeOnly || o.free));
    // the graph has no prices for places: a free day skips the kind that usually charges (museums, galleries) unless it is
    // all there is, and so does an outdoor day
    const outdoor = /outdoor|outside|park|garden|hike|picnic|户外|公园|花园|徒步|野餐/i.test(request.text);
    const kinds = f.freeOnly || outdoor ? PLACE_KINDS.filter(k => k !== 'museum') : PLACE_KINDS;
    // a place the request names ("Golden Gate Park"), wherever the day's events are; a kind word ("museum") names none
    const asked = Array.isArray(filters.places) ? filters.places.map(str).filter(Boolean).slice(0, 4) : [];
    const placeWords = uniq([...f.keywords, ...asked, ...ruleFilters(request.text).keywords]).filter(k => !GENERIC.has(k.toLowerCase()) && (/[一-鿿]/.test(k) ? k.length >= 3 : k.length >= 4));
    const named = placeWords.length ? await findPlacesNamed({ keywords: placeWords, kinds }, ctx) : [];
    // places near the stops the plan can use first: on a free day the paid backups' neighbourhoods come last
    const usable = f.freeOnly ? events.filter(e => e.free) : events;
    const hoodIds = uniq([...named.slice(0, 2).map(p => p.hoodId), ...usable.map(e => e.hoodId), ...offers.map(o => o.hoodId), ...events.map(e => e.hoodId)].filter(Boolean)).slice(0, 5);
    let places = hoodIds.length && kinds !== PLACE_KINDS ? await findPlaces({ hoodIds, kinds }, ctx) : [];
    if (hoodIds.length && !places.length) places = await findPlaces({ hoodIds }, ctx);
    places = [...named, ...places.filter(p => !named.some(x => x.id === p.id))];
    const zh = lang !== 'en'; // the graph's Chinese station and line names ("市政中心站", "M 线"); street corners have none

    const candidates = {
      events: events.slice(0, 10).map(e => { const tr = e.transit?.[0]; return { id: e.id, name: lang === 'en' ? e.titleEn : e.title, when: lang === 'en' ? e.dateLabelEn : e.dateLabel, free: e.free, family: e.familyFriendly, category: e.category, minAge: e.minAge, venue: lang === 'en' ? e.venueEn : e.venue, hood: lang === 'en' ? e.hoodEn : e.hood, hoodId: e.hoodId, station: tr?.stationId ?? null, stationName: (zh && tr?.stationZh) || tr?.station || null, line: (zh && tr?.lineZh) || tr?.line || null, url: e.baylink }; }),
      // an offer's free hours when its terms name them (the Tea Garden: 09:00–10:00), and whom it needs besides everyone
      offers: offers.slice(0, 5).map(o => { const w = windowOf(o.requirementEn), need = needOf(o.whoEn); return { id: o.id, name: lang === 'en' ? o.titleEn : o.title, free: o.free, who: lang === 'en' ? o.whoEn : o.who, ...(need ? { needs: need } : {}), ...(w ? { hours: `${hhmm(w.from)}–${hhmm(w.to)}` } : {}), hood: lang === 'en' ? o.hoodEn : o.hood, hoodId: o.hoodId, placeId: o.placeId ?? null, station: o.stationId ?? null, stationName: (zh && o.stationZh) || o.station || null, line: (zh && o.lineZh) || o.line || null, url: o.baylink }; }),
      places: places.slice(0, 6).map(p => ({ id: p.id, name: lang === 'en' ? p.nameEn : p.name, kind: p.kind, hood: lang === 'en' ? p.hoodEn : p.hood, hoodId: p.hoodId ?? null, station: p.stationId ?? null, stationName: (zh && p.stationZh) || p.station || null, line: (zh && p.lineZh) || p.line || null, url: p.guide })),
    };
    const hoods = uniq([...candidates.events, ...candidates.offers, ...candidates.places].map(x => x.hood).filter(Boolean)).slice(0, 8).join(', ') || '—';
    await room.event('Scout', 'tool_result', t(lang, `${candidates.events.length} 个活动 · ${candidates.offers.length} 个优惠 · ${candidates.places.length} 个景点 · 街区：${hoods}`, `${candidates.events.length} events · ${candidates.offers.length} offers · ${candidates.places.length} places · neighbourhoods ${hoods}`), runId);
    const keys = [...candidates.events.map(e => `Event:${e.id}`), ...candidates.offers.map(o => `Offer:${o.id}`), ...candidates.places.map(p => `Place:${p.id}`)];
    emit({ type: 'graph', runId, ...subgraph(keys, { depth: 2, max: 110 }) });
    await room.send('Scout', t(lang, `找到 ${candidates.events.length} 个当天的活动、${candidates.offers.length} 个优惠、${candidates.places.length} 个附近景点（${{ neo4j: '都来自 Neo4j 图谱', mixed: '部分来自本地图谱副本', local: '都来自本地图谱副本' }[via(ctx)]}）。请排行程。`, `Found ${candidates.events.length} events that day, ${candidates.offers.length} offers and ${candidates.places.length} places nearby (${{ neo4j: 'all from the Neo4j graph', mixed: 'partly from the local copy of the graph', local: 'all from the local copy of the graph' }[via(ctx)]}). Please build the day.`), ['Planner'], { runId, request, filters: f, candidates }, runId);
  });

  // ---------------------------------------------------------------------------------------------- Planner
  room.join('Planner', async msg => {
    if (msg.from !== 'Scout' && msg.from !== 'Checker') return;
    const { runId, request, candidates, filters, previous, vetoes = [] } = msg.payload ?? {};
    if (!request?.text || !request?.date || !['events', 'offers', 'places'].every(k => Array.isArray(candidates?.[k]))) return;
    const round = Number(msg.payload.round) || 1;
    const issues = Array.isArray(msg.payload.issues) ? msg.payload.issues.map(String) : [];
    const rejected = Array.isArray(msg.payload.rejected) ? msg.payload.rejected.map(String) : [];
    const ctx = { agent: 'Planner', runId };
    const lang = request.lang;
    if (issues.length) await room.event('Planner', 'thought', t(lang, `第 ${round} 轮：按 Checker 的意见修改（${issues.length} 条）`, `Round ${round}: fixing ${issues.length} issue(s) from Checker`), runId);
    const plan = await chat({
      ...ctx, lang, json: true, maxTokens: 5000,
      system: `You are Planner, a San Francisco local who plans a realistic, relaxed day out. Use ONLY the candidates given (never invent a place or event). Write in ${lang === 'en' ? 'English' : 'Simplified Chinese'}. Reply with ONE JSON object only.`,
      user: `Visitor: ${request.text}\nDate: ${request.date}\nFilters: ${JSON.stringify(filters ?? {})}\n${issues.length ? `Your last plan was ${JSON.stringify(previous ?? [])}. Checker found these problems in it — fix every one:\n- ${issues.join('\n- ')}\n` : ''}${rejected.length ? `Never use these candidate ids again (they failed the graph check): ${rejected.join(', ')}\n` : ''}Candidates:\n${JSON.stringify(candidates)}\n\nReturn {"title": "short catchy title", "stops": [{"time": "HH:MM", "kind": "event"|"offer"|"place", "id": "<candidate id>", "name": "...", "why": "one warm sentence, why it fits this visitor"}], "notes": ["1-3 practical tips"]}. 3 to 5 stops, in time order, keep neighbourhoods close together, respect each event's hours (the "when" text) and each offer's "hours" (its free hours), use an offer with "needs" only when the visitor meets it ("child": adults who bring a child), prefer free stops when asked. EVERY stop's "id" must be the id of one candidate — never add a neighbourhood, a meal or a walk as its own stop; if the visitor wants food or a break, mention it in the "why" of a nearby candidate stop instead. In "why" and "notes" name a transit line only if it is a candidate's "line" — never invent bus routes, transfers or opening hours.`,
      // a reply without stops to use (a wrapper object, "stops" not a list) is no plan: the rule-based one stands in
      usable: p => Array.isArray(p.stops) && p.stops.some(s => s && typeof s === 'object' && !Array.isArray(s) && (s.id || s.name)),
      fallback: () => rulePlan(candidates, request, filters, rejected),
    });
    const byId = new Map([...candidates.events.map(e => [e.id, { ...e, kind: 'event' }]), ...candidates.offers.map(o => [o.id, { ...o, kind: 'offer' }]), ...candidates.places.map(p => [p.id, { ...p, kind: 'place' }])]);
    const stops = (Array.isArray(plan.stops) ? plan.stops : []).filter(s => s && typeof s === 'object' && !Array.isArray(s)).slice(0, 6).map(s => {
      // only a candidate's id is kept: anything else reaches the Checker without an id and is sent back
      const c = byId.get(s.id) ?? [...byId.values()].find(x => s.name && x.name === s.name);
      const at = toMin(s.time);
      return { time: at == null ? str(s.time) : hhmm(at), kind: c?.kind ?? (['event', 'offer', 'place'].includes(s.kind) ? s.kind : 'place'), id: c?.id ?? null, name: c?.name ?? str(s.name), venue: c?.venue ?? null, neighborhood: c?.hood ?? null, hoodId: c?.hoodId ?? null, station: c?.station ?? null, stationName: c?.stationName ?? null, line: c?.line ?? null, why: str(s.why), free: c ? (c.free ?? null) : null, who: c?.who ?? null, url: c?.url ?? null, transit: null, verified: false };
    });
    // transit between consecutive stops: the shortest path over the graph's NEXT relationships
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1].station, b = stops[i].station;
      if (!a || !b || a === b) continue;
      const r = (await route({ from: a, to: b }, ctx))[0];
      // only a ride on one line: the path may change lines where two share track (Powell–Hyde / Powell–Mason, N / M), and a
      // hint never names a change, so those stops keep "near <station>"
      if (!(r?.hops > 0 && r.common?.length && r.stops[0] !== r.stops.at(-1))) continue;
      const names = lang === 'en' ? r.stops : (r.stopsZh ?? r.stops);
      stops[i].transit = t(lang, `从 ${names[0]} 坐 ${r.hops} 站到 ${names.at(-1)}`, `${r.hops} stops from ${names[0]} to ${names.at(-1)}`);
    }
    const draft = { title: str(plan.title) || t(lang, '旧金山的一天', 'A day in San Francisco'), date: request.date, stops, notes: Array.isArray(plan.notes) ? plan.notes.map(str).filter(Boolean).slice(0, 3) : [] };
    await room.send('Planner', t(lang, `草稿（第 ${round} 轮）：${stops.map(s => `${s.time} ${s.name}`).join(' → ')}。请核对。`, `Draft (round ${round}): ${stops.map(s => `${s.time} ${s.name}`).join(' → ')}. Please verify.`), ['Checker'], { runId, request, candidates, filters, plan: draft, round, vetoes, rejected }, runId);
  });

  // ---------------------------------------------------------------------------------------------- Checker
  room.join('Checker', async msg => {
    if (msg.from !== 'Planner') return;
    const { runId, request, candidates, plan, filters } = msg.payload ?? {};
    if (!request?.date || !Array.isArray(plan?.stops)) return;
    const round = Number(msg.payload.round) || 1;
    const vetoes = Array.isArray(msg.payload.vetoes) ? msg.payload.vetoes.filter(v => Array.isArray(v?.issues)) : [];
    const ctx = { agent: 'Checker', runId, engines: new Set() };
    const lang = request.lang, date = request.date;
    const stops = plan.stops.filter(s => s && typeof s === 'object');
    const issues = [], bad = new Set();
    if (stops.length < 2) issues.push(t(lang, '站点太少（至少 2 个）', 'too few stops (at least 2)'));
    const seen = new Set();
    for (const s of stops) {
      if (!s.id) { issues.push(t(lang, `「${s.name}」不在候选里`, `"${s.name}" is not one of the candidates`)); continue; }
      const dup = seen.has(s.id); // the repeat is never ✓ (the stop itself may be fine, so its id is not rejected)
      if (dup) issues.push(t(lang, `「${s.name}」重复了`, `"${s.name}" appears twice`));
      seen.add(s.id);
      if (s.kind === 'event') {
        const e = (await getEvent(s.id, ctx))?.e;
        if (!e) { issues.push(t(lang, `图谱里没有活动 ${s.id}`, `no event ${s.id} in the graph`)); bad.add(s.id); continue; }
        const on = e.dates?.length ? e.dates.includes(date) : e.startDate <= date && e.endDate >= date;
        const inSf = e.city === 'San Francisco', kidsOk = !(filters?.family && (e.adultsOnly || e.minAge >= 18)), freeOk = !(filters?.freeOnly && !e.free);
        if (!on) issues.push(t(lang, `「${s.name}」在 ${date} 不举办（${e.dateLabel}）`, `"${s.name}" is not on ${date} (${e.dateLabelEn})`));
        if (!inSf) issues.push(t(lang, `「${s.name}」不在旧金山（${e.city ?? '?'}）`, `"${s.name}" is not in San Francisco (${e.city ?? 'unknown city'})`));
        if (!kidsOk) issues.push(t(lang, `「${s.name}」限 ${e.minAge ?? 18}+，不适合带孩子`, `"${s.name}" is ${e.minAge ?? 18}+ only — not for kids`));
        if (!freeOk) issues.push(t(lang, `「${s.name}」不是免费的（${e.costLabel}）`, `"${s.name}" is not free (${e.admissionUsd > 0 ? `$${e.admissionUsd}` : { mixed: 'partly paid', unknown: 'price not verified' }[e.cost] ?? 'paid'})`));
        s.free = !!e.free; s.verified = on && inSf && kidsOk && freeOk;
        if (!s.verified) bad.add(s.id);
        // the hours, when the label is one span or one start time ("10/3 · 11:00–16:00", "10/10 · 17:30")
        const h = /^[^·]*·\s*(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?\s*$/.exec(e.dateLabelEn ?? ''), at = toMin(s.time);
        if (on && h && at != null) {
          const from = h[1] * 60 + +h[2], to = h[3] ? h[3] * 60 + +h[4] : null;
          // a span: be there while it runs; a start time: arrive within the hour before it
          const fits = to != null ? at >= from && at < (to > from ? to : 1440) : at >= from - 60 && at <= from;
          // outside its hours: not ✓, but the event stays usable at another time (its id is not rejected)
          if (!fits) { issues.push(t(lang, `「${s.name}」排在 ${s.time}，不在活动时间内（${e.dateLabel}）`, `"${s.name}" at ${s.time} is outside its hours (${e.dateLabelEn})`)); s.verified = false; }
        }
      } else if (s.kind === 'offer') {
        const o = await getOffer(s.id, ctx);
        if (!o) { issues.push(t(lang, `图谱里没有优惠 ${s.id}`, `no offer ${s.id} in the graph`)); bad.add(s.id); continue; }
        const wd = weekdayOf(date);
        const dated = (!o.from || o.from <= date) && (!o.to || o.to >= date), dayOk = !o.weekdays || o.weekdays.includes(wd), freeOk = !(filters?.freeOnly && !o.free);
        const whoOk = !(needOf(o.whoEn) === 'child' && !filters?.family); // "with a child": adults alone do not qualify
        if (!dated) issues.push(t(lang, `「${s.name}」在 ${date} 不适用`, `"${s.name}" does not apply on ${date}`));
        else if (!dayOk) issues.push(t(lang, `「${s.name}」${WEEKDAYS[wd][1]}不适用`, `"${s.name}" does not apply on a ${WEEKDAYS[wd][0]}`));
        if (!freeOk) issues.push(t(lang, `「${s.name}」不是免费的`, `"${s.name}" is not free`));
        if (!whoOk) issues.push(t(lang, `「${s.name}」只适用于带孩子的大人`, `"${s.name}" is only for adults who bring a child`));
        s.free = !!o.free; s.verified = dated && dayOk && freeOk && whoOk;
        if (!s.verified) bad.add(s.id);
        // the free hours its terms name (the Tea Garden: 09:00–10:00): outside them it is not free (not ✓, id not rejected)
        const w = windowOf(o.requirementEn), at = toMin(s.time);
        if (w && at != null && !(at >= w.from && at < w.to)) { issues.push(t(lang, `「${s.name}」排在 ${s.time}，不在优惠时段内（${hhmm(w.from)}–${hhmm(w.to)}）`, `"${s.name}" at ${s.time} is outside its offer hours (${hhmm(w.from)}–${hhmm(w.to)})`)); s.verified = false; }
      } else {
        s.verified = !!(await getPlace(s.id, ctx));
        if (!s.verified) { issues.push(t(lang, `「${s.name}」不是图谱里的景点`, `"${s.name}" is not a place in the graph`)); bad.add(s.id); }
        else if (filters?.freeOnly) s.priceUnknown = true; // the graph has no prices for places: say so, never pass it as free
      }
      if (dup) s.verified = false;
    }
    for (const s of stops) if (toMin(s.time) == null) issues.push(t(lang, `「${s.name}」的时间看不懂（${s.time || '空'}）`, `"${s.name}" has no valid time (${s.time || 'empty'})`));
    const mins = stops.map(s => toMin(s.time)).filter(x => x != null);
    if (mins.some((x, i) => i && x < mins[i - 1])) issues.push(t(lang, '时间顺序不对', 'stops are not in time order'));
    const where = { neo4j: t(lang, ' Neo4j ', 'Neo4j'), mixed: t(lang, ' Neo4j（部分为本地图谱副本）', 'Neo4j (partly the local copy of the graph)'), local: t(lang, '本地图谱副本', 'the local copy of the graph') }[via(ctx)];
    await room.event('Checker', 'tool_result', issues.length ? t(lang, `图谱核对：${issues.length} 个问题\n- ${issues.join('\n- ')}`, `graph check: ${issues.length} issue(s)\n- ${issues.join('\n- ')}`) : t(lang, `图谱核对：${stops.length} 站全部对照${where}核实`, `graph check: all ${stops.length} stops verified against ${where}`), runId);

    // a second, different open model reviews the plan with the graph's facts in hand; on round 1 it may send the plan
    // back once for pace / fit (the graph checks above always decide the facts); after that its review is final
    const canFix = round === 1;
    const facts = stops.map(s => ({ time: s.time, name: s.name, kind: s.kind, neighborhood: s.neighborhood, free: s.priceUnknown ? 'unknown' : s.free, ...(s.who ? { who: s.who } : {}), verifiedOnDate: s.kind === 'place' ? null : s.verified, transit: s.transit ?? (s.line ? `near ${s.stationName} (${s.line})` : null) }));
    const review = await chat({
      ...ctx, lang, json: true, maxTokens: 1500,
      system: `You are Checker, a careful reviewer of San Francisco day plans. The facts given (free, dates) were already verified in the knowledge graph — never question them (free "unknown": the graph has no price for that place). Judge only the fit: pace, travel between neighbourhoods, the visitor's constraints (kids, budget, interests). Mention only the stops, neighbourhoods and transit given in the plan — never name other places, bus routes or lines. Write in ${lang === 'en' ? 'English' : 'Simplified Chinese'}. Reply with ONE JSON object only.`,
      user: `Visitor: ${request.text}\nDate: ${date}\nPlan (verified facts): ${JSON.stringify(facts)}\nGraph issues found: ${issues.length ? issues.join('; ') : 'none'}\n\n${canFix ? 'Return {"approve": bool, "fixes": [0-2 short, concrete changes the Planner can make with its candidate list (drop, swap or reorder stops, change a time), only if they clearly improve the day for this visitor — never ask for a meal stop, a new place or a bus route], "verdict": "1-2 friendly sentences for the visitor"}' : 'This is the final review: the plan can no longer change. Do not say you suggested, changed or added anything, and write to the visitor, not to the Planner; if something is weak, give the visitor one practical tip instead. Return {"approve": bool, "verdict": "1-2 friendly sentences for the visitor"}'}`,
      fallback: () => ({ approve: !issues.length, fixes: [], verdict: issues.length ? t(lang, '有几处和图谱对不上（规则检查，没有模型复核）。', 'Some stops do not match the graph (rule-based check, no model review).') : t(lang, '行程和图谱一致（规则检查，没有模型复核）。', 'The plan matches the graph (rule-based check, no model review).') }),
    });
    const verdict = str(review.verdict) || (issues.length ? t(lang, '有几处和图谱对不上。', 'Some stops do not match the graph.') : t(lang, '行程和图谱一致。', 'The plan matches the graph.'));
    const fixes = canFix && review.approve === false && Array.isArray(review.fixes) ? review.fixes.map(str).filter(Boolean).slice(0, 2) : [];
    await room.event('Checker', 'thought', `${verdict}${fixes.length ? `\n→ ${fixes.join(' / ')}` : ''}`.slice(0, 700), runId);
    const rejected = uniq([...(Array.isArray(msg.payload.rejected) ? msg.payload.rejected.map(String) : []), ...bad]);

    if ((issues.length || fixes.length) && round < MAX_ROUNDS) {
      const all = uniq([...issues, ...fixes]);
      const veto = { round, issues, suggestions: fixes.filter(x => !issues.includes(x)), draft: draftOf(stops) };
      await room.send('Checker', t(lang, `第 ${round} 轮没通过，请修改：${all.join('；')}`, `Round ${round} rejected, please fix: ${all.join('; ')}`), ['Planner'], { runId, request, candidates, filters, issues: all, round: round + 1, previous: stops.map(s => ({ time: s.time, id: s.id, name: s.name })), vetoes: [...vetoes, veto], rejected }, runId);
      return;
    }
    const approved = issues.length === 0;
    const noted = approved && review.approve === false;
    const review_ = noted ? t(lang, `图谱事实全部核对通过。小贴士：${verdict}`, `All graph facts verified. Tip: ${verdict}`) : verdict;
    // fixed: the graph issues of earlier vetoes (re-checked every round); the review's pace / fit suggestions are never
    // called fixed (nothing re-checks them) — only whether the next draft changed at all
    const fixed = uniq(vetoes.flatMap(v => v.issues.map(String))).filter(x => !issues.includes(x));
    const suggested = [], notApplied = [];
    vetoes.forEach((v, i) => { const xs = Array.isArray(v.suggestions) ? v.suggestions.map(String) : []; if (xs.length) ((vetoes[i + 1]?.draft ?? draftOf(stops)) === v.draft ? notApplied : suggested).push(...xs); });
    await room.send('Checker', approved ? t(lang, `核准 ✓（第 ${round} 轮）。${review_}`, `Approved ✓ (round ${round}). ${review_}`) : t(lang, `${round} 轮后仍有 ${issues.length} 个问题，交给 BAYBAY 标注说明。`, `Still ${issues.length} issue(s) after ${round} rounds — handing to BAYBAY with notes.`),
      ['BAYBAY'], { runId, request, plan: { ...plan, stops: stops.map(({ hoodId, station, stationName, line, ...s }) => ({ ...s, transit: s.transit ?? (line ? t(lang, `附近：${stationName}（${line}）`, `near ${stationName} (${line})`) : null) })) }, checker: { approved, issues: approved ? [] : issues, fixed, suggested: uniq(suggested), notApplied: uniq(notApplied), rounds: round, review: review_ } }, runId);
  });

  return { ask };
}

// the delivered plan as a visitor reads it (a room event, so a human in the Band room gets it too)
function summary(plan, c, lang) {
  const stops = plan.stops.filter(Boolean).map(s => `${s.time ?? ''} ${s.name ?? ''}${s.free === true ? t(lang, '（免费）', ' (FREE)') : ''}${s.why ? ` — ${s.why}` : ''}`.trim());
  const issues = Array.isArray(c.issues) ? c.issues : [];
  const verdict = c.approved ? t(lang, `✓ Checker 核准（${c.rounds} 轮）。${c.review ?? ''}`, `✓ Approved by Checker (${c.rounds} ${c.rounds === 1 ? 'round' : 'rounds'}). ${c.review ?? ''}`) : t(lang, `✗ ${c.rounds} 轮后 Checker 仍未通过：${issues.join('；')}`, `✗ Not approved by Checker after ${c.rounds} rounds: ${issues.join('; ')}`);
  return [t(lang, `行程已交给访客：${plan.title ?? ''}（${plan.date ?? ''}）`, `Plan delivered to the visitor: ${plan.title ?? ''} (${plan.date ?? ''})`), ...stops, verdict.trim()].join('\n');
}

// ---------------------------------------------------------------------------------------------- dates and times
const WEEKDAYS = [['Sunday', '周日'], ['Monday', '周一'], ['Tuesday', '周二'], ['Wednesday', '周三'], ['Thursday', '周四'], ['Friday', '周五'], ['Saturday', '周六']];
const weekdayOf = date => new Date(`${date}T12:00:00-07:00`).getUTCDay(); // the same rule as graph.mjs
const realDate = s => { const [y, m, d] = String(s).split('-').map(Number); const u = new Date(Date.UTC(y, m - 1, d)); return /^\d{4}-\d{2}-\d{2}$/.test(s) && u.getUTCFullYear() === y && u.getUTCMonth() === m - 1 && u.getUTCDate() === d; };
// "9:30", "09:30", "1:00 PM" → minutes after midnight; anything else → null
const toMin = x => {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*(?:([ap])\.?\s*m\.?)?\s*$/i.exec(String(x ?? ''));
  if (!m) return null;
  let h = +m[1];
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); }
  return h < 24 ? h * 60 + +m[2] : null;
};
const md = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`; // 2026-10-31 → 10/31
// the first "HH:MM–HH:MM" in an offer's terms (or a candidate's "hours"), in minutes; null when it names none
const windowOf = s => { const m = /(\d{1,2}):([0-5]\d)\s*[–-]\s*(\d{1,2}):([0-5]\d)/.exec(String(s ?? '')); return m ? { from: m[1] * 60 + +m[2], to: m[3] * 60 + +m[4] } : null; };
// whom an offer needs besides "Everyone": 'child' (adults with a child) or 'eligibility' (residency, a benefits card); null for all
const needOf = whoEn => (!whoEn || /^Everyone/i.test(whoEn) ? null : /child/i.test(whoEn) ? 'child' : 'eligibility');
// keywords that name a kind of place, not a place
const GENERIC = new Set([...PLACE_KINDS, 'museums', 'parks', 'gardens', 'beaches', 'outdoor', 'outdoors']);
const draftOf = stops => stops.map(s => `${s.time} ${s.id ?? s.name}`).join(' · '); // a draft's stops and times, to see whether it changed
const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** A date written in a Band message: YYYY-MM-DD, or M/D (in 2026, the catalog's year); null when there is none. */
function dateIn(text) {
  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(text), md = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/.exec(text);
  return [iso && iso.slice(1).join('-'), md && `2026-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`].find(s => s && realDate(s)) ?? null;
}

/** An event's hours on `date` from its "when" text: the first time after that date or weekday when the text names it,
 *  else its first time — {start, end} in minutes (end null without a span), or null when the text has no time. */
function hoursOn(when, date) {
  const s = String(when ?? ''), body = s.slice(s.indexOf(' · ') + 1);
  const md = new RegExp(`(?<![\\d/])${+date.slice(5, 7)}/${+date.slice(8, 10)}(?![\\d/])`).exec(body)?.index;
  const at = [md, ...WEEKDAYS[weekdayOf(date)].map(w => body.indexOf(w))].filter(i => i >= 0);
  const re = /(\d{1,2}):([0-5]\d)(?:\s*[–-]\s*(\d{1,2}):([0-5]\d))?/;
  const m = (at.length ? re.exec(body.slice(Math.min(...at))) : null) ?? re.exec(body);
  return m ? { start: m[1] * 60 + +m[2], end: m[3] ? m[3] * 60 + +m[4] : null } : null;
}

/** The coming Saturday in San Francisco (today when it is Saturday there), as YYYY-MM-DD. */
export function nextSaturday(from = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(from).map(x => [x.type, x.value]));
  const d = new Date(Date.UTC(+p.year, p.month - 1, +p.day));
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------- fallbacks (no Crusoe key)
function ruleFilters(text) {
  const s = String(text).toLowerCase();
  const keywords = [];
  if (/halloween|万圣|南瓜|pumpkin/.test(s)) keywords.push('halloween', '万圣', 'pumpkin', '南瓜');
  if (/music|音乐|concert/.test(s)) keywords.push('music', '音乐');
  if (/market|市集/.test(s)) keywords.push('market', '市集');
  if (/golden gate park|金门公园/.test(s)) keywords.push('golden gate park', '金门公园');
  if (/museum|博物馆/.test(s)) keywords.push('museum', '博物馆');
  const family = /kid|child|family|孩子|小孩|亲子|儿童/.test(s) && !/\b(no|without)\s+(kids|children)\b|不带(孩子|小孩)|没有(孩子|小孩)/.test(s);
  return { freeOnly: /free|免费|cheap|便宜/.test(s), family, keywords, interests: [], pace: 'relaxed' };
}

// up to 2 events at their own hours, 1 offer (inside its free hours when it names them) and places (at least 1, more to
// fill the day) in the free slots, by time; it honours the filters (on a family day only the events the graph marks
// family-friendly, or a daytime food / outdoors event such as a farmers market — never an evening meetup or a
// conference — and offers "with a child" only then), never uses an offer that needs residency or a benefits card, and
// never reuses a candidate the Checker rejected
function rulePlan(c, { lang, date }, f, rejected = []) {
  const kws = (f?.keywords ?? []).map(k => String(k).toLowerCase());
  const hits = x => kws.filter(k => `${x.name} ${x.kind ?? ''} ${x.venue ?? ''}`.toLowerCase().includes(k)).length;
  const rank = xs => xs.filter(x => !rejected.includes(x.id)).sort((a, b) => hits(b) - hits(a));
  const fits = x => !f?.freeOnly || x.free;
  const events = [], taken = [];
  for (const e of rank(c.events.filter(e => fits(e) && !(f?.family && e.minAge >= 18)))) {
    if (events.length === 2) break;
    // within its hours (from 10:00 when it opens earlier), 90 min or more from the other event; a start time is fixed
    const h = hoursOn(e.when, date);
    if (f?.family && e.family === false && !(['food', 'outdoors'].includes(e.category) && h && h.start < 17 * 60)) continue;
    const first = h && (h.end != null ? Math.max(h.start, Math.min(600, h.end - 60)) : h.start), last = h?.end != null ? Math.max(first, h.end - 60) : first;
    const at = h ? [0, 90, 180, 270].map(d => first + d).find(x => x <= last && taken.every(y => Math.abs(x - y) >= 90)) : null;
    if (at === undefined) continue;
    events.push({ kind: 'event', id: e.id, name: e.name, at });
    if (at != null) taken.push(at);
  }
  const offers = [];
  for (const o of rank(c.offers.filter(o => fits(o) && (!o.needs || (o.needs === 'child' && f?.family))))) {
    const w = windowOf(o.hours);
    const at = w ? Array.from({ length: Math.ceil((w.to - w.from) / 30) }, (_, i) => w.from + i * 30).find(x => taken.every(y => Math.abs(x - y) >= 90)) : null;
    if (at === undefined) continue; // no free slot inside its hours
    offers.push({ kind: 'offer', id: o.id, name: o.name, placeId: o.placeId, at });
    if (at != null) taken.push(at);
    break;
  }
  const places = rank(c.places.filter(p => !offers.some(o => o.placeId === p.id))).slice(0, Math.max(1, 4 - events.length - offers.length)).map(p => ({ kind: 'place', id: p.id, name: p.name, at: null }));
  const picks = [...events, ...offers, ...places];
  for (const p of picks) if (p.at == null) { p.at = [600, 750, 870, 990, 1110].find(x => taken.every(y => Math.abs(x - y) >= 90)) ?? Math.min(1380, Math.max(...taken) + 90); taken.push(p.at); }
  const why = t(lang, '按你的日期从图谱里挑的。', 'Picked from the graph for your date.');
  return { title: t(lang, '真实旧金山的一天', 'A real San Francisco day'), stops: picks.sort((a, b) => a.at - b.at).map(({ at, placeId, ...p }) => ({ ...p, time: hhmm(at), why })), notes: [] };
}
