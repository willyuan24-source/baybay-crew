import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import { config, neo4jOn } from './config.mjs';
import { emit } from './bus.mjs';

/**
 * The San Francisco knowledge graph (BAYLINK's catalog + Opus Bay's OpenStreetMap city). With NEO4J_* set every tool runs
 * its Cypher on Neo4j Aura; without, the same questions are answered from data/graph.json in memory ("local") so the crew
 * still works offline — the UI says which one answered. An Aura that does not answer is skipped for a minute (local answers).
 *
 * Model: (:Event)-[:AT]->(:Venue)-[:IN]->(:Neighborhood) · (:Venue|:Place|:Offer)-[:NEAR {meters}]->(:Station)
 *        (:Station)-[:ON_LINE {order}]->(:Line) · (:Station)-[:NEXT {line}]->(:Station) · (:Event)-[:IN_CITY]->(:City)
 *        (:Event)-[:OF_CATEGORY]->(:Category) · (:Offer)-[:AT]->(:Place) · (:Opening)-[:IN_CITY]->(:City)
 * Every node also has the label :Entity and a unique `key` = "<Label>:<id>".
 */
const G = JSON.parse(readFileSync(new URL('../data/graph.json', import.meta.url), 'utf8'));
const byKey = new Map(G.nodes.map(n => [n.id, n]));
const out = new Map(), inn = new Map();
for (const r of G.rels) {
  (out.get(r.from) ?? out.set(r.from, []).get(r.from)).push(r);
  (inn.get(r.to) ?? inn.set(r.to, []).get(r.to)).push(r);
}
const outs = (k, type) => (out.get(k) ?? []).filter(r => !type || r.type === type);
const ins = (k, type) => (inn.get(k) ?? []).filter(r => !type || r.type === type);
const P = k => byKey.get(k)?.props ?? {};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // Cypher's string order, so both engines break ties the same way

let driver = null;
// short timeouts: a paused or deleted Aura fails in seconds instead of the driver's default ~30–60 s of retries
if (neo4jOn()) driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), { disableLosslessIntegers: true, connectionTimeout: 5000, connectionAcquisitionTimeout: 6000, maxTransactionRetryTime: 2000 });
export const graphMode = () => (driver ? 'neo4j' : 'local');
export const graphDriver = () => driver;

// circuit breaker: after a failed Aura query, answer locally for the next minute without trying Aura
// (a Cypher error is that one query's problem, not Aura's, so it does not trip it)
const PAUSE_MS = 60_000;
let auraDownUntil = 0;
const auraDown = () => Date.now() < auraDownUntil;
/** Aura is configured and not paused by the breaker: the next query goes to Neo4j. */
export const auraUp = () => !!driver && !auraDown();
const trip = e => { if (!/^Neo\.ClientError\.Statement\./.test(e?.code ?? '')) auraDownUntil = Date.now() + PAUSE_MS; };
const ENGINE = { aura: 'Neo4j Aura', off: 'local graph (Neo4j not configured)', failed: 'local graph (Neo4j query failed)', down: 'local graph (Neo4j unavailable)' };
const READ = () => ({ database: config.neo4j.database || undefined, routing: neo4j.routing.READ });

/** Rows from Aura, or from the local copy — with the label of the engine that actually answered. */
async function answer(cypher, params, local, onError) {
  if (!driver) return { rows: local(), engine: ENGINE.off };
  if (auraDown()) return { rows: local(), engine: ENGINE.down };
  try {
    const res = await driver.executeQuery(cypher, params, READ());
    return { rows: res.records.map(r => r.toObject()), engine: ENGINE.aura };
  } catch (e) {
    trip(e);
    onError?.(e);
    return { rows: local(), engine: ENGINE.failed };
  }
}

async function run(cypher, params, { agent, runId, engines, local }) {
  const t0 = Date.now();
  const { rows, engine } = await answer(cypher, params, local, e => emit({ type: 'room', runId, from: agent, to: [], kind: 'error', text: `Neo4j query failed: ${String(e.message).slice(0, 200)} — answering from the local copy of the graph${auraDown() ? ' for the next minute' : ''}.` }));
  emit({ type: 'cypher', runId, agent, query: cypher.trim(), params, rows: rows.length, ms: Date.now() - t0, engine });
  engines?.add(engine); // ctx.engines: what answered a whole step
  return rows;
}
/** Who answered a step's queries (a Set of engine labels): 'neo4j' only when Aura answered every one, else 'mixed' or 'local'. */
export const answeredBy = engines => { const all = [...(engines ?? [])]; return !all.includes(ENGINE.aura) ? 'local' : all.every(e => e === ENGINE.aura) ? 'neo4j' : 'mixed'; };

// ---------------------------------------------------------------------------------------------------------------
/** 0 = Sunday … 6 = Saturday for a real YYYY-MM-DD calendar date; null for anything else (2026-02-30 does not roll over). */
export const weekdayOf = date => {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '')) ?? [];
  const t = new Date(Date.UTC(+y, m - 1, +d));
  return y && t.getUTCFullYear() === +y && t.getUTCMonth() === m - 1 && t.getUTCDate() === +d ? t.getUTCDay() : null;
};
const onDate = (e, date) => (e.dates?.length ? e.dates.includes(date) : e.startDate <= date && e.endDate >= date);
// the fields both engines search: title, titleEn, summary, summaryEn, audience
const kwText = e => [e.title, e.titleEn, e.summary, e.summaryEn].map(x => x ?? '').concat(e.audience ?? []).join(' ').toLowerCase();
const kwHit = (e, kws) => !kws?.length || kws.some(k => kwText(e).includes(String(k).toLowerCase()));
const byNear = (a, b) => (a.props.meters - b.props.meters) || cmp(P(a.to).id, P(b.to).id);
const lineOf = st => outs(st, 'ON_LINE').map(r => P(r.to)).sort((a, b) => cmp(a.id, b.id))[0] ?? null; // a station's first line (by id)
const transitOf = k => outs(k, 'NEAR').sort(byNear).slice(0, 2).map(r => {
  const l = lineOf(r.to);
  return { station: P(r.to).nameEn, stationZh: P(r.to).name, stationId: P(r.to).id, line: l?.nameEn ?? null, lineZh: l?.name ?? null, meters: r.props.meters };
});
const nearestOf = k => { const t = transitOf(k)[0]; return { stationId: t?.stationId ?? null, station: t?.station ?? null, stationZh: t?.stationZh ?? null, line: t?.line ?? null, lineZh: t?.lineZh ?? null }; };
const hoodOf = k => { const r = outs(k, 'IN')[0]; return r ? { id: P(r.to).id, name: P(r.to).name, nameEn: P(r.to).nameEn } : null; };

export const CYPHER = {
  events: `
MATCH (e:Event)-[:IN_CITY]->(:City {id: 'san-francisco'})
WHERE ($date IN coalesce(e.dates, []) OR (size(coalesce(e.dates, [])) = 0 AND e.startDate <= $date AND e.endDate >= $date))
  AND (NOT $freeOnly OR e.free)
  AND (NOT $family OR NOT e.adultsOnly)
  AND (size($keywords) = 0 OR ANY(k IN $keywords WHERE toLower(reduce(t = coalesce(e.title, '') + ' ' + coalesce(e.titleEn, '') + ' ' + coalesce(e.summary, '') + ' ' + coalesce(e.summaryEn, ''), a IN coalesce(e.audience, []) | t + ' ' + a)) CONTAINS toLower(k)))
OPTIONAL MATCH (e)-[:AT]->(v:Venue)
OPTIONAL MATCH (v)-[:IN]->(h:Neighborhood)
OPTIONAL MATCH (v)-[n:NEAR]->(s:Station)
OPTIONAL MATCH (s)-[:ON_LINE]->(l:Line)
WITH e, v, h, n, s, l ORDER BY l.id
WITH e, v, h, n, s, head(collect(l)) AS l1
WITH e, v, h, n, s, l1 ORDER BY n.meters, s.id
WITH e, v, h, collect({station: s.nameEn, stationZh: s.name, stationId: s.id, line: l1.nameEn, lineZh: l1.name, meters: n.meters})[0..2] AS transit
RETURN e.id AS id, e.title AS title, e.titleEn AS titleEn, e.dateLabel AS dateLabel, e.dateLabelEn AS dateLabelEn,
       e.free AS free, e.costLabel AS costLabel, e.minAge AS minAge, e.familyFriendly AS familyFriendly, e.category AS category,
       e.baylink AS baylink, e.url AS url, v.id AS venueId, v.name AS venue, v.nameEn AS venueEn, h.id AS hoodId, h.name AS hood, h.nameEn AS hoodEn,
       [t IN transit WHERE t.station IS NOT NULL] AS transit, e.summaryEn AS summaryEn, e.summary AS summary
ORDER BY e.free DESC, e.familyFriendly DESC, v.id IS NULL, e.startDate, e.id
LIMIT 14`,
  offers: `
MATCH (o:Offer)
WHERE (o.from IS NULL OR o.from <= $date) AND (o.to IS NULL OR o.to >= $date) AND (o.weekdays IS NULL OR $weekday IN o.weekdays)
OPTIONAL MATCH (o)-[:AT]->(p:Place)
OPTIONAL MATCH (p)-[:IN]->(h1:Neighborhood)
OPTIONAL MATCH (o)-[:IN]->(h2:Neighborhood)
WITH o, p, coalesce(h1, h2) AS h, coalesce(p, o) AS x
OPTIONAL MATCH (x)-[n:NEAR]->(s:Station)
WITH o, p, h, n, s ORDER BY n.meters, s.id
WITH o, p, h, head(collect(s)) AS st
OPTIONAL MATCH (st)-[:ON_LINE]->(l:Line)
WITH o, p, h, st, l ORDER BY l.id
WITH o, p, h, st, head(collect(l)) AS l1
RETURN o.id AS id, o.title AS title, o.titleEn AS titleEn, o.kind AS kind, o.free AS free, o.who AS who, o.whoEn AS whoEn,
       o.requirementEn AS requirementEn, o.baylink AS baylink, p.id AS placeId, p.name AS place, p.nameEn AS placeEn,
       h.id AS hoodId, h.nameEn AS hoodEn, h.name AS hood, st.id AS stationId, st.nameEn AS station, st.name AS stationZh, l1.nameEn AS line, l1.name AS lineZh
ORDER BY (o.from IS NOT NULL OR o.to IS NOT NULL) DESC, o.free DESC, (coalesce(o.whoEn, '') STARTS WITH 'Everyone') DESC, o.id
LIMIT 10`,
  places: `
MATCH (p:Place)-[:IN]->(h:Neighborhood)
WHERE h.id IN $hoodIds AND p.kind IN $kinds
OPTIONAL MATCH (p)-[n:NEAR]->(s:Station)
WITH p, h, n, s ORDER BY n.meters, s.id
WITH p, h, head(collect(s)) AS st
OPTIONAL MATCH (st)-[:ON_LINE]->(l:Line)
WITH p, h, st, l ORDER BY l.id
WITH p, h, st, head(collect(l)) AS l1
RETURN p.id AS id, p.name AS name, p.nameEn AS nameEn, p.kind AS kind, h.id AS hoodId, h.nameEn AS hoodEn, h.name AS hood, p.guide AS guide,
       st.nameEn AS station, st.name AS stationZh, st.id AS stationId, l1.nameEn AS line, l1.name AS lineZh
ORDER BY p.guide IS NULL, [i IN range(0, size($hoodIds) - 1) WHERE $hoodIds[i] = h.id][0], [i IN range(0, size($kinds) - 1) WHERE $kinds[i] = p.kind][0], p.id
LIMIT 10`,
  // places whose whole name is a keyword of the request ("golden gate park", "金门公园"), not one that only holds it
  // ("music" would name a hall across town): guide-linked first, then id
  namedPlaces: `
MATCH (p:Place)-[:IN]->(h:Neighborhood)
WHERE p.kind IN $kinds AND ANY(k IN $keywords WHERE toLower(coalesce(p.nameEn, '')) = toLower(k) OR toLower(coalesce(p.name, '')) = toLower(k))
OPTIONAL MATCH (p)-[n:NEAR]->(s:Station)
WITH p, h, n, s ORDER BY n.meters, s.id
WITH p, h, head(collect(s)) AS st
OPTIONAL MATCH (st)-[:ON_LINE]->(l:Line)
WITH p, h, st, l ORDER BY l.id
WITH p, h, st, head(collect(l)) AS l1
RETURN p.id AS id, p.name AS name, p.nameEn AS nameEn, p.kind AS kind, h.id AS hoodId, h.nameEn AS hoodEn, h.name AS hood, p.guide AS guide,
       st.nameEn AS station, st.name AS stationZh, st.id AS stationId, l1.nameEn AS line, l1.name AS lineZh
ORDER BY p.guide IS NULL, p.id
LIMIT 3`,
  // when San Francisco events that match the keywords run, from $from on (for "not that day, but on …"): one span per
  // event (its start and end) or one per listed date
  eventDates: `
MATCH (e:Event)-[:IN_CITY]->(:City {id: 'san-francisco'})
WHERE (NOT $freeOnly OR e.free)
  AND (NOT $family OR NOT e.adultsOnly)
  AND ANY(k IN $keywords WHERE toLower(reduce(t = coalesce(e.title, '') + ' ' + coalesce(e.titleEn, '') + ' ' + coalesce(e.summary, '') + ' ' + coalesce(e.summaryEn, ''), a IN coalesce(e.audience, []) | t + ' ' + a)) CONTAINS toLower(k))
UNWIND CASE WHEN size(coalesce(e.dates, [])) > 0 THEN [d IN e.dates | [d, d]] ELSE [[e.startDate, e.endDate]] END AS span
WITH span WHERE span[1] >= $from
RETURN DISTINCT span[0] AS start, span[1] AS end
ORDER BY start, end
LIMIT 8`,
  // both platforms of one stop (the F-line lists some twice in a row) count as one stop; common = the lines every station
  // on the way is on (empty when the path changes lines where two share track: Powell–Hyde / Powell–Mason, N / M)
  route: `
MATCH (a:Station {id: $from}), (b:Station {id: $to})
WHERE a <> b
MATCH p = shortestPath((a)-[:NEXT*..60]-(b))
WITH p, reduce(s = [], n IN nodes(p) | CASE WHEN size(s) > 0 AND s[-1].nameEn = n.nameEn THEN s ELSE s + n END) AS ns,
     [n IN nodes(p) | [(n)-[:ON_LINE]->(l:Line) | l.id]] AS onLines
RETURN [n IN ns | n.nameEn] AS stops, [n IN ns | coalesce(n.name, n.nameEn)] AS stopsZh, [r IN relationships(p) | r.line] AS lines,
       size(ns) - 1 AS hops, reduce(c = onLines[0], ls IN onLines | [x IN c WHERE x IN ls]) AS common`,
  event: `MATCH (e:Event {id: $id}) OPTIONAL MATCH (e)-[:AT]->(v:Venue)-[:IN]->(h:Neighborhood) RETURN e {.*} AS e, h.id AS hoodId`,
  offer: `MATCH (o:Offer {id: $id}) RETURN o {.*} AS o`,
  place: `MATCH (p:Place {id: $id}) RETURN p {.*} AS p`,
};

export async function findEvents({ date, freeOnly = false, family = false, keywords = [] }, ctx) {
  const params = { date, freeOnly, family, keywords };
  const hasVenue = e => outs(`Event:${e.id}`, 'AT').length ? 0 : 1;
  return run(CYPHER.events, params, { ...ctx, local: () => G.nodes.filter(n => n.label === 'Event' && n.props.city === 'San Francisco').map(n => n.props)
    .filter(e => onDate(e, date) && (!freeOnly || e.free) && (!family || !e.adultsOnly) && kwHit(e, keywords))
    .sort((a, b) => (b.free - a.free) || (b.familyFriendly - a.familyFriendly) || (hasVenue(a) - hasVenue(b)) || cmp(a.startDate, b.startDate) || cmp(a.id, b.id)).slice(0, 14)
    .map(e => {
      const k = `Event:${e.id}`, at = outs(k, 'AT')[0], v = at ? P(at.to) : null, h = at ? hoodOf(at.to) : null;
      return { id: e.id, title: e.title, titleEn: e.titleEn, dateLabel: e.dateLabel, dateLabelEn: e.dateLabelEn, free: e.free, costLabel: e.costLabel, minAge: e.minAge, familyFriendly: e.familyFriendly, category: e.category, baylink: e.baylink, url: e.url, venueId: v?.id ?? null, venue: v?.name ?? null, venueEn: v?.nameEn ?? null, hoodId: h?.id ?? null, hood: h?.name ?? null, hoodEn: h?.nameEn ?? null, transit: at ? transitOf(at.to) : [], summaryEn: e.summaryEn, summary: e.summary };
    }) });
}

// the offers only for this date first (the Scout keeps five), then free ones, then the ones free for everyone
const everyone = o => (/^Everyone/.test(o.whoEn ?? '') ? 1 : 0);
export async function findOffers({ date }, ctx) {
  const weekday = weekdayOf(date);
  return run(CYPHER.offers, { date, weekday }, { ...ctx, local: () => G.nodes.filter(n => n.label === 'Offer').map(n => n.props)
    .filter(o => (!o.from || o.from <= date) && (!o.to || o.to >= date) && (!o.weekdays || o.weekdays.includes(weekday)))
    .sort((a, b) => (!!(b.from || b.to) - !!(a.from || a.to)) || (!!b.free - !!a.free) || (everyone(b) - everyone(a)) || cmp(a.id, b.id)).slice(0, 10)
    .map(o => {
      const k = `Offer:${o.id}`, at = outs(k, 'AT')[0], p = at ? P(at.to) : null, h = at ? hoodOf(at.to) : hoodOf(k);
      return { id: o.id, title: o.title, titleEn: o.titleEn, kind: o.kind ?? null, free: o.free, who: o.who, whoEn: o.whoEn, requirementEn: o.requirementEn, baylink: o.baylink, placeId: p?.id ?? null, place: p?.name ?? null, placeEn: p?.nameEn ?? null, hoodId: h?.id ?? null, hoodEn: h?.nameEn ?? null, hood: h?.name ?? null, ...nearestOf(at ? at.to : k) };
    }) });
}

// guide-linked places first, then the neighbourhood's order in hoodIds (the top events' first), then the kind in this order
// (generic 'attraction' POIs last), then the id — the same order in both engines
export const PLACE_KINDS = ['museum', 'park', 'garden', 'viewpoint', 'landmark', 'beach', 'historic', 'peak', 'plaza', 'attraction'];
export async function findPlaces({ hoodIds, kinds = PLACE_KINDS }, ctx) {
  return run(CYPHER.places, { hoodIds, kinds }, { ...ctx, local: () => {
    const rows = [];
    for (const hid of new Set(hoodIds)) for (const r of ins(`Neighborhood:${hid}`, 'IN')) {
      const p = byKey.get(r.from);
      if (p?.label !== 'Place' || !kinds.includes(p.props.kind)) continue;
      rows.push({ id: p.props.id, name: p.props.name, nameEn: p.props.nameEn, kind: p.props.kind, hoodId: P(r.to).id, hoodEn: P(r.to).nameEn, hood: P(r.to).name, guide: p.props.guide, ...nearestOf(r.from) });
    }
    return rows.sort((a, b) => (!a.guide - !b.guide) || (hoodIds.indexOf(a.hoodId) - hoodIds.indexOf(b.hoodId)) || (kinds.indexOf(a.kind) - kinds.indexOf(b.kind)) || cmp(a.id, b.id)).slice(0, 10);
  } });
}

/** Places whose whole name is a keyword of the request (at most 3), in the shape of findPlaces. */
export async function findPlacesNamed({ keywords, kinds = PLACE_KINDS }, ctx) {
  const kws = keywords.map(k => String(k).toLowerCase());
  return run(CYPHER.namedPlaces, { keywords, kinds }, { ...ctx, local: () => {
    const rows = [];
    for (const p of G.nodes) {
      if (p.label !== 'Place' || !kinds.includes(p.props.kind) || !kws.some(k => (p.props.nameEn ?? '').toLowerCase() === k || (p.props.name ?? '').toLowerCase() === k)) continue;
      for (const r of outs(p.id, 'IN')) rows.push({ id: p.props.id, name: p.props.name, nameEn: p.props.nameEn, kind: p.props.kind, hoodId: P(r.to).id, hoodEn: P(r.to).nameEn, hood: P(r.to).name, guide: p.props.guide, ...nearestOf(p.id) });
    }
    return rows.sort((a, b) => (!a.guide - !b.guide) || cmp(a.id, b.id)).slice(0, 3);
  } });
}

/** When San Francisco events matching the keywords and filters run, ending on or after `from`: [{start, end}] (YYYY-MM-DD),
 *  one per event span or listed date, sorted, at most 8. */
export async function findEventDates({ keywords, freeOnly = false, family = false, from }, ctx) {
  return run(CYPHER.eventDates, { keywords, freeOnly, family, from }, { ...ctx, local: () => {
    const spans = G.nodes.filter(n => n.label === 'Event' && n.props.city === 'San Francisco').map(n => n.props)
      .filter(e => (!freeOnly || e.free) && (!family || !e.adultsOnly) && keywords.length && kwHit(e, keywords))
      .flatMap(e => (e.dates?.length ? e.dates.map(d => [d, d]) : [[e.startDate, e.endDate]])).filter(([, end]) => end >= from);
    return [...new Map(spans.map(([start, end]) => [`${start}|${end}`, { start, end }])).values()].sort((a, b) => cmp(a.start, b.start) || cmp(a.end, b.end)).slice(0, 8);
  } });
}

export async function route({ from, to }, ctx) {
  return run(CYPHER.route, { from, to }, { ...ctx, local: () => {
    const start = `Station:${from}`, goal = `Station:${to}`;
    if (start === goal) return [];
    const prev = new Map([[start, null]]); const q = [start];
    while (q.length) {
      const k = q.shift(); if (k === goal) break;
      for (const r of [...outs(k, 'NEXT'), ...ins(k, 'NEXT')]) { const n = r.from === k ? r.to : r.from; if (!prev.has(n)) { prev.set(n, { k, line: r.props?.line }); q.push(n); } }
    }
    if (!prev.has(goal)) return [];
    const path = [], lines = []; let k = goal;
    while (k) { path.unshift(k); const p = prev.get(k); if (p) lines.unshift(p.line); k = p?.k ?? null; }
    const ns = path.filter((x, i) => !i || P(x).nameEn !== P(path[i - 1]).nameEn);
    const common = path.map(x => outs(x, 'ON_LINE').map(r => P(r.to).id)).reduce((c, ls) => c.filter(x => ls.includes(x)));
    return [{ stops: ns.map(x => P(x).nameEn), stopsZh: ns.map(x => P(x).name ?? P(x).nameEn), lines, hops: ns.length - 1, common }];
  } });
}

export async function getEvent(id, ctx) {
  const rows = await run(CYPHER.event, { id }, { ...ctx, local: () => { const n = byKey.get(`Event:${id}`); if (!n) return []; const at = outs(n.id, 'AT')[0]; return [{ e: n.props, hoodId: at ? hoodOf(at.to)?.id ?? null : null }]; } });
  return rows[0] ?? null;
}
export async function getOffer(id, ctx) {
  const rows = await run(CYPHER.offer, { id }, { ...ctx, local: () => { const n = byKey.get(`Offer:${id}`); return n ? [{ o: n.props }] : []; } });
  return rows[0]?.o ?? null;
}
export async function getPlace(id, ctx) {
  const rows = await run(CYPHER.place, { id }, { ...ctx, local: () => { const n = byKey.get(`Place:${id}`); return n ? [{ p: n.props }] : []; } });
  return rows[0]?.p ?? null;
}

// --- the visualisation ------------------------------------------------------------------------------------------
const VIS_TYPES = new Set(['AT', 'IN', 'NEAR', 'ON_LINE', 'IS_PLACE', 'OF_CATEGORY']);
const labelOf = n => { const p = n.props; return String(p.nameEn ?? p.titleEn ?? p.name ?? p.title ?? p.id).slice(0, 38); };
const titleOf = n => { const p = n.props; return [p.title ?? p.name, p.titleEn ?? p.nameEn, p.dateLabelEn, p.costLabel].filter(Boolean).join('\n'); };

/** The neighbourhood of `keys` (events / offers / places / stations): their venues, neighbourhoods, stations, lines. */
export function subgraph(keys, { depth = 2, max = 90 } = {}) {
  const seen = new Set(), edges = [];
  let frontier = keys.filter(k => byKey.has(k));
  frontier.forEach(k => seen.add(k));
  for (let d = 0; d < depth && seen.size < max; d++) {
    const next = [];
    for (const k of frontier) for (const r of [...outs(k), ...ins(k)]) {
      if (!VIS_TYPES.has(r.type)) continue;
      const other = r.from === k ? r.to : r.from;
      const lbl = byKey.get(other)?.label;
      if (d > 0 && (lbl === 'Event' || lbl === 'Place' || lbl === 'Category')) continue; // keep the picture readable
      if (!seen.has(other)) { if (seen.size >= max) continue; seen.add(other); next.push(other); }
      edges.push({ from: r.from, to: r.to, label: r.type });
    }
    frontier = next;
  }
  const uniq = new Map(edges.filter(e => seen.has(e.from) && seen.has(e.to)).map(e => [`${e.from}|${e.to}|${e.label}`, e]));
  return { nodes: [...seen].map(k => byKey.get(k)).map(n => ({ id: n.id, label: labelOf(n), kind: n.label, title: titleOf(n) })), edges: [...uniq.values()] };
}

export function overview() {
  const sfEvents = G.nodes.filter(n => n.label === 'Event' && n.props.city === 'San Francisco' && outs(n.id, 'AT').length).slice(0, 26).map(n => n.id);
  const lines = G.nodes.filter(n => n.label === 'Line').map(n => n.id);
  return subgraph([...sfEvents, ...lines], { depth: 2, max: 140 });
}

// data/graph.json repeats a few relationship rows; Neo4j's MERGE keeps one per pair and type, and so does this count
const RELS = new Set(G.rels.map(r => `${r.from}|${r.type}|${r.to}`)).size;
export function stats() {
  const labels = {};
  for (const n of G.nodes) labels[n.label] = (labels[n.label] ?? 0) + 1;
  return { nodes: G.nodes.length, rels: RELS, labels };
}

// the catalog snapshot's date and the first / last day with a San Francisco event in it
const SF_DAYS = G.nodes.filter(n => n.label === 'Event' && n.props.city === 'San Francisco').flatMap(n => [...(n.props.dates ?? []), n.props.startDate, n.props.endDate]).filter(Boolean).sort();
const RANGE = { snapshot: new Date(G.exported).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), firstEvent: SF_DAYS[0] ?? null, lastEvent: SF_DAYS.at(-1) ?? null };
export const dataRange = () => ({ ...RANGE });

/** Live counts on Aura (only this project's :Entity nodes and the relationships between them); null when not configured. */
export async function neo4jStats() {
  if (!driver) return null;
  if (auraDown()) return { error: 'Neo4j did not answer a moment ago — using the local copy of the graph for now' };
  try {
    const r = await driver.executeQuery('MATCH (n:Entity) WITH count(n) AS nodes OPTIONAL MATCH (:Entity)-[r]->(:Entity) RETURN nodes, count(r) AS rels', {}, READ());
    const { nodes, rels } = r.records[0].toObject();
    return { nodes: Number(nodes), rels: Number(rels) };
  } catch (e) { trip(e); return { error: String(e.message).slice(0, 160) }; }
}

// --- the dashboard: three graph questions -------------------------------------------------------------------------
// `dated` panels count events from today on; once today is past the snapshot's last event they show the whole snapshot
export const DASHBOARD = [
  {
    title: 'Free San Francisco events by neighbourhood', titleZh: '按街区统计的免费旧金山活动', dated: true,
    cypher: `MATCH (e:Event {free: true})-[:AT]->(:Venue)-[:IN]->(h:Neighborhood)
WHERE e.endDate >= $today
RETURN h.nameEn AS neighborhood, count(e) AS freeEvents, collect(e.titleEn)[0..3] AS examples
ORDER BY freeEvents DESC, neighborhood LIMIT 8`,
    columns: ['neighborhood', 'freeEvents', 'examples'],
    local: today => { const m = new Map(); for (const n of G.nodes) { if (n.label !== 'Event' || !n.props.free || n.props.endDate < today) continue; const at = outs(n.id, 'AT')[0]; const h = at && hoodOf(at.to); if (!h) continue; const e = m.get(h.nameEn) ?? { neighborhood: h.nameEn, freeEvents: 0, examples: [] }; e.freeEvents++; if (e.examples.length < 3) e.examples.push(n.props.titleEn); m.set(h.nameEn, e); } return [...m.values()].sort((a, b) => (b.freeEvents - a.freeEvents) || cmp(a.neighborhood, b.neighborhood)).slice(0, 8); },
  },
  {
    title: 'Transit hubs: stations with the most attractions within 700 m', titleZh: '交通枢纽：700 米内景点最多的车站',
    cypher: `MATCH (s:Station)<-[n:NEAR]-(x)
WHERE x:Place OR x:Venue
WITH s, count(x) AS nearby
MATCH (s)-[:ON_LINE]->(l:Line)
RETURN s.nameEn AS station, nearby, collect(DISTINCT l.nameEn) AS lines
ORDER BY nearby DESC, station LIMIT 8`,
    columns: ['station', 'nearby', 'lines'],
    local: () => G.nodes.filter(n => n.label === 'Station').map(n => ({ station: n.props.nameEn, nearby: ins(n.id, 'NEAR').filter(r => /^(Place|Venue):/.test(r.from)).length, lines: [...new Set(outs(n.id, 'ON_LINE').map(r => P(r.to).nameEn))] })).sort((a, b) => (b.nearby - a.nearby) || cmp(a.station, b.station)).slice(0, 8),
  },
  {
    title: 'Family-friendly events you can reach on each line', titleZh: '每条线路能到的亲子友好活动', dated: true,
    cypher: `MATCH (l:Line)<-[:ON_LINE]-(s:Station)<-[:NEAR]-(v:Venue)<-[:AT]-(e:Event)
WHERE e.familyFriendly AND NOT e.adultsOnly AND e.endDate >= $today
RETURN l.nameEn AS line, count(DISTINCT e) AS events, collect(DISTINCT e.titleEn)[0..3] AS examples
ORDER BY events DESC, line`,
    columns: ['line', 'events', 'examples'],
    local: today => G.nodes.filter(n => n.label === 'Line').map(l => {
      const evs = new Set();
      for (const r of ins(l.id, 'ON_LINE')) for (const nr of ins(r.from, 'NEAR')) if (nr.from.startsWith('Venue:')) for (const ar of ins(nr.from, 'AT')) { const e = P(ar.from); if (e.familyFriendly && !e.adultsOnly && e.endDate >= today) evs.add(e.titleEn); }
      return { line: l.props.nameEn, events: evs.size, examples: [...evs].slice(0, 3) };
    }).filter(r => r.events).sort((a, b) => (b.events - a.events) || cmp(a.line, b.line)),
  },
];

export async function dashboard(today) {
  const asOf = RANGE.lastEvent && today > RANGE.lastEvent ? RANGE.snapshot : today;
  const queries = [];
  for (const q of DASHBOARD) {
    const { rows, engine } = await answer(q.cypher, { today: asOf }, () => q.local(asOf));
    const when = !q.dated ? ['', ''] : asOf === today ? [' (from today)', '（今天起）'] : [` (catalog snapshot of ${asOf})`, `（${asOf} 的目录快照）`];
    queries.push({ title: q.title + when[0], titleZh: q.titleZh + when[1], cypher: q.cypher, columns: q.columns, engine, rows: rows.map(r => q.columns.map(c => Array.isArray(r[c]) ? r[c].join(', ') : r[c])) });
  }
  return { engine: driver && queries.every(q => q.engine === ENGINE.aura) ? 'neo4j' : 'local', asOf, queries };
}
