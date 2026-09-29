import { config } from './config.mjs';
import { emit } from './bus.mjs';
import { chat } from './llm.mjs';
import { findEvents, findOffers, findPlaces, getEvent, getOffer, route, subgraph } from './graph.mjs';

/**
 * The crew. Each agent only acts on a message Band delivers to it; everything it needs travels in that message's JSON
 * payload (request, candidates, plan, issues), so the Band room is the single source of truth for the run.
 *
 *   BAYBAY   host    the visitor's request → @Scout; the Checker's verdict → the final plan for the visitor
 *   Scout    graph   Crusoe turns the request into filters → Cypher on Neo4j (events on that date, offers, places near
 *                    them, transit) → @Planner with the candidates
 *   Planner  plan    Crusoe picks and orders 3–5 stops (only from the candidates) → shortest transit paths between
 *                    stops from the graph → @Checker
 *   Checker  verify  every stop re-read from the graph (date, free, age limits, validity) + a second open model's review;
 *                    wrong → back to @Planner (max 2 rounds); right → @BAYBAY
 */
const MAX_ROUNDS = 2;
const t = (lang, zh, en) => (lang === 'en' ? en : zh);

export function startCrew(room) {
  const runs = new Map();

  // ---------------------------------------------------------------------------------------------- BAYBAY (host)
  async function ask({ text, lang = 'zh', date }, runId) {
    runs.set(runId, { t0: Date.now() });
    emit({ type: 'room', runId, from: 'User', to: ['BAYBAY'], kind: 'message', text });
    await room.send('BAYBAY', t(lang, `新请求：「${text}」（${date}）。请从图谱里找候选。`, `New request: "${text}" (${date}). Please pull candidates from the graph.`), ['Scout'], { runId, request: { text, lang, date } }, runId);
  }

  room.join('BAYBAY', async msg => {
    const p = msg.payload ?? {};
    if (msg.from === 'Checker' && p.plan) {
      const runId = p.runId;
      emit({ type: 'plan', runId, plan: { ...p.plan, checker: p.checker } });
      const lang = p.request?.lang ?? 'zh';
      await room.event('BAYBAY', 'task', t(lang, `行程已交给访客：${p.plan.stops.length} 站，${p.checker.approved ? 'Checker 已核准' : '有未解决的问题'}（${p.checker.rounds} 轮）。`, `Plan delivered to the visitor: ${p.plan.stops.length} stops, ${p.checker.approved ? 'approved by Checker' : 'with open issues'} (${p.checker.rounds} round(s)).`), runId);
      emit({ type: 'done', runId, ms: Date.now() - (runs.get(runId)?.t0 ?? Date.now()) });
      return;
    }
    // a human typing in the Band room ("@BAYBAY a rainy Sunday with kids") starts a run too
    if (!p.runId && msg.text) {
      const runId = `band-${Date.now().toString(36)}`;
      emit({ type: 'run', runId, text: msg.text });
      await ask({ text: msg.text, lang: /[一-鿿]/.test(msg.text) ? 'zh' : 'en', date: nextSaturday() }, runId);
    }
  });

  // ---------------------------------------------------------------------------------------------- Scout (graph)
  room.join('Scout', async msg => {
    const { runId, request } = msg.payload ?? {};
    if (!request) return;
    const ctx = { agent: 'Scout', runId };
    const lang = request.lang;
    const filters = await chat({
      ...ctx, json: true,
      system: 'You turn a San Francisco day-out request into search filters for a knowledge graph of real events, museum/park offers and places. Reply with ONE JSON object only.',
      user: `Request: ${request.text}\nDate: ${request.date}\nReturn {"freeOnly": bool (true only if they ask for free / cheap), "family": bool (kids, family, all ages), "keywords": [up to 4 short keywords that must appear in an event title, in English AND Chinese, e.g. "halloween","万圣节" — [] if the request is general], "interests": [short English tags], "pace": "relaxed"|"packed"}`,
      fallback: () => ruleFilters(request.text),
    });
    const f = { freeOnly: !!filters.freeOnly, family: !!filters.family, keywords: Array.isArray(filters.keywords) ? filters.keywords.slice(0, 6).map(String) : [] };
    await room.event('Scout', 'thought', `filters ${JSON.stringify({ date: request.date, ...f, interests: filters.interests ?? [] })}`, runId);

    await room.event('Scout', 'tool_call', `neo4j.findEvents(${JSON.stringify({ date: request.date, ...f })})`, runId);
    let events = await findEvents({ date: request.date, ...f }, ctx);
    if (events.length < 3 && f.keywords.length) { await room.event('Scout', 'thought', 'few keyword hits — widening to every event that day', runId); events = [...events, ...(await findEvents({ date: request.date, freeOnly: f.freeOnly, family: f.family, keywords: [] }, ctx)).filter(e => !events.some(x => x.id === e.id))]; }
    if (events.length < 3 && f.freeOnly) { await room.event('Scout', 'thought', 'few free events — including paid ones as backups', runId); events = [...events, ...(await findEvents({ date: request.date, freeOnly: false, family: f.family, keywords: [] }, ctx)).filter(e => !events.some(x => x.id === e.id))]; }
    const offers = await findOffers({ date: request.date }, ctx);
    const hoodIds = [...new Set([...events.map(e => e.hoodId), ...offers.map(o => o.hoodId)].filter(Boolean))].slice(0, 5);
    const places = hoodIds.length ? await findPlaces({ hoodIds: hoodIds.length ? hoodIds : ['osm-n-mission'] }, ctx) : [];
    await room.event('Scout', 'tool_result', `${events.length} events · ${offers.length} offers · ${places.length} places · neighbourhoods ${[...new Set([...events, ...offers].filter(x => x.hoodId).map(x => x.hoodEn))].join(', ') || '—'}`, runId);

    const candidates = {
      events: events.slice(0, 10).map(e => ({ id: e.id, name: lang === 'en' ? e.titleEn : e.title, when: lang === 'en' ? e.dateLabelEn : e.dateLabel, free: e.free, family: e.familyFriendly, minAge: e.minAge, venue: lang === 'en' ? e.venueEn : e.venue, hood: lang === 'en' ? e.hoodEn : e.hood, hoodId: e.hoodId, station: e.transit?.[0]?.stationId ?? null, stationName: e.transit?.[0]?.station ?? null, line: e.transit?.[0]?.line ?? null, url: e.baylink })),
      offers: offers.slice(0, 5).map(o => ({ id: o.id, name: lang === 'en' ? o.titleEn : o.title, free: o.free, who: lang === 'en' ? o.whoEn : o.who, hood: lang === 'en' ? o.hoodEn : o.hood, hoodId: o.hoodId, url: o.baylink })),
      places: places.slice(0, 6).map(p => ({ id: p.id, name: lang === 'en' ? p.nameEn : p.name, kind: p.kind, hood: lang === 'en' ? p.hoodEn : p.hood, station: p.station, url: p.guide })),
    };
    const keys = [...candidates.events.map(e => `Event:${e.id}`), ...candidates.offers.map(o => `Offer:${o.id}`), ...candidates.places.map(p => `Place:${p.id}`)];
    emit({ type: 'graph', runId, ...subgraph(keys, { depth: 2, max: 110 }) });
    await room.send('Scout', t(lang, `找到 ${candidates.events.length} 个当天的活动、${candidates.offers.length} 个优惠、${candidates.places.length} 个附近景点（都来自 Neo4j 图谱）。请排行程。`, `Found ${candidates.events.length} events that day, ${candidates.offers.length} offers and ${candidates.places.length} places nearby (all from the Neo4j graph). Please build the day.`), ['Planner'], { runId, request, filters: f, candidates }, runId);
  });

  // ---------------------------------------------------------------------------------------------- Planner
  room.join('Planner', async msg => {
    const { runId, request, candidates, issues = [], round = 1, filters, previous } = msg.payload ?? {};
    if (!request || !candidates) return;
    const ctx = { agent: 'Planner', runId };
    const lang = request.lang;
    if (issues.length) await room.event('Planner', 'thought', t(lang, `第 ${round} 轮：按 Checker 的意见修改（${issues.length} 条）`, `Round ${round}: fixing ${issues.length} issue(s) from Checker`), runId);
    const plan = await chat({
      ...ctx, json: true, maxTokens: 5000,
      system: `You are Planner, a San Francisco local who plans a realistic, relaxed day out. Use ONLY the candidates given (never invent a place or event). Write in ${lang === 'en' ? 'English' : 'Simplified Chinese'}. Reply with ONE JSON object only.`,
      user: `Visitor: ${request.text}\nDate: ${request.date}\nFilters: ${JSON.stringify(filters ?? {})}\n${issues.length ? `Your last plan was ${JSON.stringify(previous ?? [])}. Checker found these problems in it — fix every one:\n- ${issues.join('\n- ')}\n` : ''}Candidates:\n${JSON.stringify(candidates)}\n\nReturn {"title": "short catchy title", "stops": [{"time": "HH:MM", "kind": "event"|"offer"|"place", "id": "<candidate id>", "name": "...", "why": "one warm sentence, why it fits this visitor"}], "notes": ["1-3 practical tips"]}. 3 to 5 stops, in time order, keep neighbourhoods close together, respect each event's hours (the "when" text), prefer free stops when asked.`,
      fallback: () => rulePlan(candidates, lang),
    });
    const byId = new Map([...candidates.events.map(e => [e.id, { ...e, kind: 'event' }]), ...candidates.offers.map(o => [o.id, { ...o, kind: 'offer' }]), ...candidates.places.map(p => [p.id, { ...p, kind: 'place' }])]);
    const stops = (Array.isArray(plan.stops) ? plan.stops : []).slice(0, 6).map(s => {
      const c = byId.get(s.id) ?? [...byId.values()].find(x => x.name === s.name);
      return { time: String(s.time ?? ''), kind: c?.kind ?? s.kind ?? 'place', id: c?.id ?? s.id ?? null, name: c?.name ?? s.name, venue: c?.venue ?? null, neighborhood: c?.hood ?? null, hoodId: c?.hoodId ?? null, station: c?.station ?? null, stationName: c?.stationName ?? null, line: c?.line ?? null, why: s.why ?? '', free: c ? (c.free ?? null) : null, url: c?.url ?? null, transit: null, verified: false };
    });
    // transit between consecutive stops: the shortest path over the graph's NEXT relationships
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1].station, b = stops[i].station;
      if (!a || !b || a === b) continue;
      const r = (await route({ from: a, to: b }, ctx))[0];
      if (r?.hops) stops[i].transit = t(lang, `从 ${r.stops[0]} 坐 ${r.hops} 站到 ${r.stops.at(-1)}`, `${r.hops} stops from ${r.stops[0]} to ${r.stops.at(-1)}`);
    }
    const draft = { title: String(plan.title ?? t(lang, '旧金山的一天', 'A day in San Francisco')), date: request.date, stops, notes: Array.isArray(plan.notes) ? plan.notes.slice(0, 3).map(String) : [] };
    await room.send('Planner', t(lang, `草稿（第 ${round} 轮）：${stops.map(s => `${s.time} ${s.name}`).join(' → ')}。请核对。`, `Draft (round ${round}): ${stops.map(s => `${s.time} ${s.name}`).join(' → ')}. Please verify.`), ['Checker'], { runId, request, candidates, filters, plan: draft, round }, runId);
  });

  // ---------------------------------------------------------------------------------------------- Checker
  room.join('Checker', async msg => {
    const { runId, request, candidates, plan, round = 1, filters } = msg.payload ?? {};
    if (!plan || !request) return;
    const ctx = { agent: 'Checker', runId };
    const lang = request.lang;
    const issues = [];
    if (plan.stops.length < 2) issues.push(t(lang, '站点太少（至少 2 个）', 'too few stops (at least 2)'));
    const seen = new Set();
    for (const s of plan.stops) {
      if (!s.id) { issues.push(t(lang, `「${s.name}」不在候选里`, `"${s.name}" is not one of the candidates`)); continue; }
      if (seen.has(s.id)) issues.push(t(lang, `「${s.name}」重复了`, `"${s.name}" appears twice`));
      seen.add(s.id);
      if (s.kind === 'event') {
        const row = await getEvent(s.id, ctx);
        const e = row?.e;
        if (!e) { issues.push(t(lang, `图谱里没有活动 ${s.id}`, `no event ${s.id} in the graph`)); continue; }
        const on = e.dates?.length ? e.dates.includes(request.date) : e.startDate <= request.date && e.endDate >= request.date;
        if (!on) issues.push(t(lang, `「${s.name}」在 ${request.date} 不举办（${e.dateLabel}）`, `"${s.name}" is not on ${request.date} (${e.dateLabelEn})`));
        if (filters?.family && e.adultsOnly) issues.push(t(lang, `「${s.name}」限 ${e.minAge}+，不适合带孩子`, `"${s.name}" is ${e.minAge}+ only — not for kids`));
        if (filters?.freeOnly && !e.free) issues.push(t(lang, `「${s.name}」不是免费的（${e.costLabel}）`, `"${s.name}" is not free (${e.costLabel})`));
        s.free = !!e.free; s.verified = on && !(filters?.family && e.adultsOnly);
      } else if (s.kind === 'offer') {
        const o = await getOffer(s.id, ctx);
        if (!o) { issues.push(t(lang, `图谱里没有优惠 ${s.id}`, `no offer ${s.id} in the graph`)); continue; }
        const ok = (!o.from || o.from <= request.date) && (!o.to || o.to >= request.date);
        if (!ok) issues.push(t(lang, `「${s.name}」在 ${request.date} 不适用`, `"${s.name}" does not apply on ${request.date}`));
        s.free = !!o.free; s.verified = ok;
      } else {
        s.verified = !!candidates?.places?.some(p => p.id === s.id);
        if (!s.verified) issues.push(t(lang, `「${s.name}」不是图谱里的景点`, `"${s.name}" is not a place in the graph`));
      }
    }
    const times = plan.stops.map(s => s.time).filter(Boolean);
    if (times.some((x, i) => i && x < times[i - 1])) issues.push(t(lang, '时间顺序不对', 'stops are not in time order'));
    await room.event('Checker', 'tool_result', issues.length ? `graph check: ${issues.length} issue(s)\n- ${issues.join('\n- ')}` : `graph check: all ${plan.stops.length} stops verified against Neo4j`, runId);

    // a second, different open model reviews the plan with the graph's facts in hand; on round 1 it may send the plan
    // back once for pace / fit (the graph checks above always decide the facts)
    const facts = plan.stops.map(s => ({ time: s.time, name: s.name, kind: s.kind, neighborhood: s.neighborhood, free: s.free, verifiedOnDate: s.verified, transit: s.transit ?? (s.line ? `near ${s.stationName} (${s.line})` : null) }));
    const review = await chat({
      ...ctx, json: true, maxTokens: 1500,
      system: `You are Checker, a careful reviewer of San Francisco day plans. The facts given (free, dates) were already verified in a Neo4j graph — never question them. Judge only the fit: pace, travel between neighbourhoods, the visitor's constraints (kids, budget, interests). Write in ${lang === 'en' ? 'English' : 'Simplified Chinese'}. Reply with ONE JSON object only.`,
      user: `Visitor: ${request.text}\nDate: ${request.date}\nPlan (verified facts): ${JSON.stringify(facts)}\nGraph issues found: ${issues.length ? issues.join('; ') : 'none'}\n\nReturn {"approve": bool, "fixes": [0-2 short, concrete changes the Planner must make, only if they clearly improve the day for this visitor], "verdict": "1-2 friendly sentences for the visitor"}`,
      fallback: () => ({ approve: !issues.length, fixes: [], verdict: issues.length ? t(lang, '有几处和图谱对不上，需要修改。', 'A few stops do not match the graph; please revise.') : t(lang, '行程和图谱一致，节奏合适。', 'The plan matches the graph and the pace works.') }),
    });
    const verdict = String(review?.verdict ?? '').trim() || t(lang, '行程和图谱一致。', 'The plan matches the graph.');
    const fixes = round === 1 && review?.approve === false && Array.isArray(review?.fixes) ? review.fixes.slice(0, 2).map(String).filter(Boolean) : [];
    await room.event('Checker', 'thought', `${verdict}${fixes.length ? `\n→ ${fixes.join(' / ')}` : ''}`.slice(0, 700), runId);

    if ((issues.length || fixes.length) && round < MAX_ROUNDS) {
      const all = [...issues, ...fixes];
      await room.send('Checker', t(lang, `第 ${round} 轮没通过，请修改：${all.join('；')}`, `Round ${round} rejected, please fix: ${all.join('; ')}`), ['Planner'], { runId, request, candidates, filters, issues: all, round: round + 1, previous: plan.stops.map(s => ({ time: s.time, id: s.id, name: s.name })) }, runId);
      return;
    }
    const approved = issues.length === 0;
    const noted = approved && review?.approve === false;
    const review_ = noted ? t(lang, `图谱事实全部核对通过。建议：${verdict}`, `All graph facts verified. Note: ${verdict}`) : verdict;
    await room.send('Checker', approved ? t(lang, `核准 ✓（第 ${round} 轮）。${review_}`, `Approved ✓ (round ${round}). ${review_}`) : t(lang, `${MAX_ROUNDS} 轮后仍有问题，交给 BAYBAY 标注说明。`, `Still ${issues.length} issue(s) after ${MAX_ROUNDS} rounds — handing to BAYBAY with notes.`),
      ['BAYBAY'], { runId, request, plan: { ...plan, stops: plan.stops.map(({ hoodId, station, stationName, line, ...s }) => ({ ...s, transit: s.transit ?? (line ? t(lang, `附近：${stationName}（${line}）`, `near ${stationName} (${line})`) : null) })) }, checker: { approved, issues, rounds: round, review: review_ } }, runId);
  });

  return { ask };
}

// ---------------------------------------------------------------------------------------------- fallbacks (no Crusoe key)
function ruleFilters(text) {
  const s = text.toLowerCase();
  const keywords = [];
  if (/halloween|万圣|南瓜|pumpkin/.test(s)) keywords.push('halloween', '万圣', 'pumpkin', '南瓜');
  if (/music|音乐|concert/.test(s)) keywords.push('music', '音乐');
  if (/market|市集/.test(s)) keywords.push('market', '市集');
  return { freeOnly: /free|免费|cheap|便宜/.test(s), family: /kid|child|family|孩子|小孩|亲子|儿童/.test(s), keywords, interests: [], pace: 'relaxed' };
}
function rulePlan(c, lang) {
  const pick = [...c.events.slice(0, 2).map(e => ({ kind: 'event', id: e.id, name: e.name })), ...c.offers.slice(0, 1).map(o => ({ kind: 'offer', id: o.id, name: o.name })), ...c.places.slice(0, 1).map(p => ({ kind: 'place', id: p.id, name: p.name }))];
  const times = ['10:00', '12:30', '14:30', '16:30'];
  return { title: lang === 'en' ? 'A real San Francisco day' : '真实旧金山的一天', stops: pick.map((p, i) => ({ ...p, time: times[i], why: lang === 'en' ? 'Picked from the graph for your date.' : '按你的日期从图谱里挑的。' })), notes: [] };
}
export function nextSaturday(from = new Date()) {
  const d = new Date(from.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}
