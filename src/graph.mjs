import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import { config, neo4jOn } from './config.mjs';
import { emit } from './bus.mjs';

/**
 * The San Francisco knowledge graph (BAYLINK's catalog + Opus Bay's OpenStreetMap city). With NEO4J_* set every tool runs
 * its Cypher on Neo4j Aura; without, the same questions are answered from data/graph.json in memory ("local") so the crew
 * still works offline — the UI says which one answered.
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

let driver = null;
if (neo4jOn()) driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), { disableLosslessIntegers: true });
export const graphMode = () => (driver ? 'neo4j' : 'local');
export const graphDriver = () => driver;

async function run(cypher, params, { agent, runId, local }) {
  const t0 = Date.now();
  let rows;
  if (driver) {
    try {
      const res = await driver.executeQuery(cypher, params, { database: config.neo4j.database || undefined, routing: neo4j.routing.READ });
      rows = res.records.map(r => r.toObject());
    } catch (e) {
      emit({ type: 'room', runId, from: agent, to: [], kind: 'error', text: `Neo4j query failed: ${String(e.message).slice(0, 200)} — answering from the local copy of the graph.` });
      rows = local();
    }
  } else rows = local();
  emit({ type: 'cypher', runId, agent, query: cypher.trim(), params, rows: rows.length, ms: Date.now() - t0, engine: driver ? 'Neo4j Aura' : 'local graph (Neo4j not configured)' });
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------
const weekdayOf = date => new Date(`${date}T12:00:00-07:00`).getUTCDay();
const onDate = (e, date) => (e.dates?.length ? e.dates.includes(date) : e.startDate <= date && e.endDate >= date);
const kwHit = (e, kws) => !kws?.length || kws.some(k => `${e.title} ${e.titleEn} ${e.summary ?? ''} ${e.summaryEn ?? ''} ${(e.audience ?? []).join(' ')}`.toLowerCase().includes(String(k).toLowerCase()));
const transitOf = k => outs(k, 'NEAR').sort((a, b) => a.props.meters - b.props.meters).slice(0, 2).map(r => {
  const line = outs(r.to, 'ON_LINE')[0];
  return { station: P(r.to).nameEn, stationZh: P(r.to).name, stationId: P(r.to).id, line: line ? P(line.to).nameEn : null, lineZh: line ? P(line.to).name : null, meters: r.props.meters };
});
const hoodOf = k => { const r = outs(k, 'IN')[0]; return r ? { id: P(r.to).id, name: P(r.to).name, nameEn: P(r.to).nameEn } : null; };

export const CYPHER = {
  events: `
MATCH (e:Event)-[:IN_CITY]->(:City {id: 'san-francisco'})
WHERE ($date IN e.dates OR (size(e.dates) = 0 AND e.startDate <= $date AND e.endDate >= $date))
  AND (NOT $freeOnly OR e.free)
  AND (NOT $family OR NOT e.adultsOnly)
  AND (size($keywords) = 0 OR ANY(k IN $keywords WHERE toLower(e.title + ' ' + e.titleEn + ' ' + coalesce(e.summaryEn, '')) CONTAINS toLower(k)))
OPTIONAL MATCH (e)-[:AT]->(v:Venue)
OPTIONAL MATCH (v)-[:IN]->(h:Neighborhood)
OPTIONAL MATCH (v)-[n:NEAR]->(s:Station)-[:ON_LINE]->(l:Line)
WITH e, v, h, n, s, l ORDER BY n.meters
WITH e, v, h, collect(DISTINCT {station: s.nameEn, stationZh: s.name, stationId: s.id, line: l.nameEn, lineZh: l.name, meters: n.meters})[0..2] AS transit
RETURN e.id AS id, e.title AS title, e.titleEn AS titleEn, e.dateLabel AS dateLabel, e.dateLabelEn AS dateLabelEn,
       e.free AS free, e.costLabel AS costLabel, e.minAge AS minAge, e.familyFriendly AS familyFriendly, e.category AS category,
       e.baylink AS baylink, e.url AS url, v.id AS venueId, v.name AS venue, v.nameEn AS venueEn, h.id AS hoodId, h.name AS hood, h.nameEn AS hoodEn,
       [t IN transit WHERE t.station IS NOT NULL] AS transit, e.summaryEn AS summaryEn, e.summary AS summary
ORDER BY e.free DESC, e.familyFriendly DESC, v.id IS NULL
LIMIT 14`,
  offers: `
MATCH (o:Offer)
WHERE (o.from IS NULL OR o.from <= $date) AND (o.to IS NULL OR o.to >= $date) AND (o.weekdays IS NULL OR $weekday IN o.weekdays)
OPTIONAL MATCH (o)-[:AT]->(p:Place)
OPTIONAL MATCH (p)-[:IN]->(h1:Neighborhood)
OPTIONAL MATCH (o)-[:IN]->(h2:Neighborhood)
RETURN o.id AS id, o.title AS title, o.titleEn AS titleEn, o.free AS free, o.who AS who, o.whoEn AS whoEn,
       o.requirementEn AS requirementEn, o.baylink AS baylink, p.name AS place, p.nameEn AS placeEn,
       coalesce(h1.id, h2.id) AS hoodId, coalesce(h1.nameEn, h2.nameEn) AS hoodEn, coalesce(h1.name, h2.name) AS hood
LIMIT 10`,
  places: `
MATCH (p:Place)-[:IN]->(h:Neighborhood)
WHERE h.id IN $hoodIds AND p.kind IN $kinds
OPTIONAL MATCH (p)-[n:NEAR]->(s:Station)
WITH p, h, n, s ORDER BY n.meters
WITH p, h, head(collect(s.nameEn)) AS station
RETURN p.id AS id, p.name AS name, p.nameEn AS nameEn, p.kind AS kind, h.nameEn AS hoodEn, h.name AS hood, p.guide AS guide, station
ORDER BY p.guide IS NULL, p.kind
LIMIT 10`,
  route: `
MATCH (a:Station {id: $from}), (b:Station {id: $to})
MATCH p = shortestPath((a)-[:NEXT*..60]-(b))
RETURN [n IN nodes(p) | n.nameEn] AS stops, [r IN relationships(p) | r.line] AS lines, length(p) AS hops`,
  event: `MATCH (e:Event {id: $id}) OPTIONAL MATCH (e)-[:AT]->(v:Venue)-[:IN]->(h:Neighborhood) RETURN e {.*} AS e, h.id AS hoodId`,
  offer: `MATCH (o:Offer {id: $id}) RETURN o {.*} AS o`,
};

export async function findEvents({ date, freeOnly = false, family = false, keywords = [] }, ctx) {
  const params = { date, freeOnly, family, keywords };
  return run(CYPHER.events, params, { ...ctx, local: () => G.nodes.filter(n => n.label === 'Event' && n.props.city === 'San Francisco').map(n => n.props)
    .filter(e => onDate(e, date) && (!freeOnly || e.free) && (!family || !e.adultsOnly) && kwHit(e, keywords))
    .map(e => {
      const k = `Event:${e.id}`, at = outs(k, 'AT')[0], v = at ? P(at.to) : null, h = at ? hoodOf(at.to) : null;
      return { id: e.id, title: e.title, titleEn: e.titleEn, dateLabel: e.dateLabel, dateLabelEn: e.dateLabelEn, free: e.free, costLabel: e.costLabel, minAge: e.minAge, familyFriendly: e.familyFriendly, category: e.category, baylink: e.baylink, url: e.url, venueId: v?.id ?? null, venue: v?.name ?? null, venueEn: v?.nameEn ?? null, hoodId: h?.id ?? null, hood: h?.name ?? null, hoodEn: h?.nameEn ?? null, transit: at ? transitOf(at.to) : [], summaryEn: e.summaryEn, summary: e.summary };
    })
    .sort((a, b) => (b.free - a.free) || (b.familyFriendly - a.familyFriendly) || ((a.venueId ? 0 : 1) - (b.venueId ? 0 : 1))).slice(0, 14) });
}

export async function findOffers({ date }, ctx) {
  const weekday = weekdayOf(date);
  return run(CYPHER.offers, { date, weekday }, { ...ctx, local: () => G.nodes.filter(n => n.label === 'Offer').map(n => n.props)
    .filter(o => (!o.from || o.from <= date) && (!o.to || o.to >= date) && (!o.weekdays || o.weekdays.includes(weekday)))
    .map(o => {
      const k = `Offer:${o.id}`, at = outs(k, 'AT')[0], p = at ? P(at.to) : null, h = at ? hoodOf(at.to) : hoodOf(k);
      return { id: o.id, title: o.title, titleEn: o.titleEn, free: o.free, who: o.who, whoEn: o.whoEn, requirementEn: o.requirementEn, baylink: o.baylink, place: p?.name ?? null, placeEn: p?.nameEn ?? null, hoodId: h?.id ?? null, hoodEn: h?.nameEn ?? null, hood: h?.name ?? null };
    }).slice(0, 10) });
}

const PLACE_KINDS = ['museum', 'park', 'garden', 'viewpoint', 'landmark', 'attraction', 'plaza', 'beach', 'historic', 'peak'];
export async function findPlaces({ hoodIds, kinds = PLACE_KINDS }, ctx) {
  return run(CYPHER.places, { hoodIds, kinds }, { ...ctx, local: () => {
    const rows = [];
    for (const hid of hoodIds) for (const r of ins(`Neighborhood:${hid}`, 'IN')) {
      const p = byKey.get(r.from);
      if (p?.label !== 'Place' || !kinds.includes(p.props.kind)) continue;
      const st = outs(r.from, 'NEAR').sort((a, b) => a.props.meters - b.props.meters)[0];
      rows.push({ id: p.props.id, name: p.props.name, nameEn: p.props.nameEn, kind: p.props.kind, hoodEn: P(r.to).nameEn, hood: P(r.to).name, guide: p.props.guide, station: st ? P(st.to).nameEn : null });
    }
    return rows.sort((a, b) => (a.guide ? 0 : 1) - (b.guide ? 0 : 1)).slice(0, 10);
  } });
}

export async function route({ from, to }, ctx) {
  return run(CYPHER.route, { from, to }, { ...ctx, local: () => {
    const start = `Station:${from}`, goal = `Station:${to}`;
    const prev = new Map([[start, null]]); const q = [start];
    while (q.length) {
      const k = q.shift(); if (k === goal) break;
      for (const r of [...outs(k, 'NEXT'), ...ins(k, 'NEXT')]) { const n = r.from === k ? r.to : r.from; if (!prev.has(n)) { prev.set(n, { k, line: r.props?.line }); q.push(n); } }
    }
    if (!prev.has(goal)) return [];
    const stops = [], lines = []; let k = goal;
    while (k) { stops.unshift(P(k).nameEn); const p = prev.get(k); if (p) lines.unshift(p.line); k = p?.k ?? null; }
    return [{ stops, lines, hops: stops.length - 1 }];
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

export function stats() {
  const labels = {};
  for (const n of G.nodes) labels[n.label] = (labels[n.label] ?? 0) + 1;
  return { nodes: G.nodes.length, rels: G.rels.length, labels };
}

export async function neo4jStats() {
  if (!driver) return null;
  try {
    const r = await driver.executeQuery('MATCH (n:Entity) WITH count(n) AS nodes CALL { MATCH ()-[r]->() RETURN count(r) AS rels } RETURN nodes, rels', {}, { database: config.neo4j.database || undefined });
    return r.records[0].toObject();
  } catch (e) { return { error: String(e.message).slice(0, 160) }; }
}

// --- the dashboard: three graph questions -------------------------------------------------------------------------
export const DASHBOARD = [
  {
    title: 'Free San Francisco events by neighbourhood (from today)', titleZh: '按街区统计的免费旧金山活动（今天起）',
    cypher: `MATCH (e:Event {free: true})-[:AT]->(:Venue)-[:IN]->(h:Neighborhood)
WHERE e.endDate >= $today
RETURN h.nameEn AS neighborhood, count(e) AS freeEvents, collect(e.titleEn)[0..3] AS examples
ORDER BY freeEvents DESC LIMIT 8`,
    columns: ['neighborhood', 'freeEvents', 'examples'],
    local: today => { const m = new Map(); for (const n of G.nodes) { if (n.label !== 'Event' || !n.props.free || n.props.endDate < today) continue; const at = outs(n.id, 'AT')[0]; const h = at && hoodOf(at.to); if (!h) continue; const e = m.get(h.nameEn) ?? { neighborhood: h.nameEn, freeEvents: 0, examples: [] }; e.freeEvents++; if (e.examples.length < 3) e.examples.push(n.props.titleEn); m.set(h.nameEn, e); } return [...m.values()].sort((a, b) => b.freeEvents - a.freeEvents).slice(0, 8); },
  },
  {
    title: 'Transit hubs: stations with the most attractions within 700 m', titleZh: '交通枢纽：700 米内景点最多的车站',
    cypher: `MATCH (s:Station)<-[n:NEAR]-(x)
WHERE x:Place OR x:Venue
WITH s, count(x) AS nearby
MATCH (s)-[:ON_LINE]->(l:Line)
RETURN s.nameEn AS station, nearby, collect(DISTINCT l.nameEn) AS lines
ORDER BY nearby DESC LIMIT 8`,
    columns: ['station', 'nearby', 'lines'],
    local: () => G.nodes.filter(n => n.label === 'Station').map(n => ({ station: n.props.nameEn, nearby: ins(n.id, 'NEAR').filter(r => /^(Place|Venue):/.test(r.from)).length, lines: [...new Set(outs(n.id, 'ON_LINE').map(r => P(r.to).nameEn))] })).sort((a, b) => b.nearby - a.nearby).slice(0, 8),
  },
  {
    title: 'Family-friendly events you can reach on each line', titleZh: '每条线路能到的亲子友好活动',
    cypher: `MATCH (l:Line)<-[:ON_LINE]-(s:Station)<-[:NEAR]-(v:Venue)<-[:AT]-(e:Event)
WHERE NOT e.adultsOnly AND (e.familyFriendly OR e.free) AND e.endDate >= $today
RETURN l.nameEn AS line, count(DISTINCT e) AS events, collect(DISTINCT e.titleEn)[0..3] AS examples
ORDER BY events DESC`,
    columns: ['line', 'events', 'examples'],
    local: today => G.nodes.filter(n => n.label === 'Line').map(l => {
      const evs = new Set();
      for (const r of ins(l.id, 'ON_LINE')) for (const nr of ins(r.from, 'NEAR')) if (nr.from.startsWith('Venue:')) for (const ar of ins(nr.from, 'AT')) { const e = P(ar.from); if (!e.adultsOnly && (e.familyFriendly || e.free) && e.endDate >= today) evs.add(e.titleEn); }
      return { line: l.props.nameEn, events: evs.size, examples: [...evs].slice(0, 3) };
    }).filter(r => r.events).sort((a, b) => b.events - a.events),
  },
];

export async function dashboard(today) {
  const queries = [];
  for (const q of DASHBOARD) {
    let rows;
    if (driver) {
      try { rows = (await driver.executeQuery(q.cypher, { today }, { database: config.neo4j.database || undefined, routing: neo4j.routing.READ })).records.map(r => r.toObject()); }
      catch { rows = q.local(today); }
    } else rows = q.local(today);
    queries.push({ title: q.title, titleZh: q.titleZh, cypher: q.cypher, columns: q.columns, rows: rows.map(r => q.columns.map(c => Array.isArray(r[c]) ? r[c].join(', ') : r[c])) });
  }
  return { engine: graphMode(), queries };
}
