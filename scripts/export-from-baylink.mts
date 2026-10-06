/**
 * BAYLINK → knowledge graph export. Needs a checkout of BAYLINK (https://github.com/willyuan24-source/baylink-web) with its
 * dependencies installed, so its data and TypeScript modules resolve; run it with that checkout's tsx:
 *
 *   cd <baylink-web checkout> && node node_modules/tsx/dist/cli.mjs <baybay-crew>/scripts/export-from-baylink.mts
 *
 * The checkout is BAYLINK_DIR, else the first argument, else the current directory.
 * Writes data/graph.json next to this script (../data/graph.json): nodes + relationships, ready for src/load-neo4j.mjs.
 * Sources (all real, all already published on https://www.baylink.us; counts as of the 2026-09-29 export):
 *   public/planner-catalog.json          267 Bay Area events (dates, cost, age limits, official links) + planner places
 *   public/opus-bay/sf/v1/places.json    1033 San Francisco places from OpenStreetMap (incl. 72 neighbourhoods)
 *   public/opus-bay/sf/v1/transit*.json  cable cars, the F-line, Muni N / M, with their stops (lines with an OpenStreetMap
 *                                        route relation only: the game's sightseeing loop is not a real line)
 *   public/opus-bay/sf/v1/live.json      BAYLINK's verified free / reduced museum, park and transit offers
 *   src/opus-bay/realsf/eventVenues.ts   where each San Francisco catalog event happens (OSM-checked venue points)
 *   src/data/autumn-release-openings.json new shops and restaurants (autumn 2026)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BAYLINK = resolve(process.env.BAYLINK_DIR || process.argv[2] || process.cwd());
const OUT = fileURLToPath(new URL('../data/graph.json', import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(resolve(BAYLINK, p), 'utf8'));
const mod = (p: string) => import(pathToFileURL(resolve(BAYLINK, p)).href);
type Venue = { id: string; name: { zh: string; en: string }; x: number; z: number; sourceUrl?: string; placeId?: string; events: string[] };
const { unproject } = await mod('src/opus-bay/core/geo.ts');
const { EVENT_VENUES } = (await mod('src/opus-bay/realsf/eventVenues.ts')) as { EVENT_VENUES: Venue[] };
const { loadLocale, translateText } = await mod('src/i18n/locale.ts');
await loadLocale('en');
const en = (zh: string) => { try { return translateText(zh, 'en'); } catch { return zh; } };
// links as published, minus ad-click / campaign tracking parameters
const TRACKING = /^(utm_|mc_|sjrn|_ga$|_gl$|gclid$|gbraid$|wbraid$|dclid$|fbclid$|msclkid$|yclid$|igshid$|mkt_tok$|_hsenc$|_hsmi$)/i;
const cleanUrl = (u: unknown) => {
  if (typeof u !== 'string' || !/^https?:\/\/[^?]*\?/.test(u)) return u;
  try { const x = new URL(u); const ks = [...x.searchParams.keys()].filter(k => TRACKING.test(k)); if (!ks.length) return u; ks.forEach(k => x.searchParams.delete(k)); return x.href; } catch { return u; }
};

type Props = Record<string, unknown>;
const nodes = new Map<string, { id: string; label: string; props: Props }>();
const rels: { from: string; to: string; type: string; props?: Props }[] = [];
const node = (label: string, id: string, props: Props) => { const key = `${label}:${id}`; if (!nodes.has(key)) nodes.set(key, { id: key, label, props: { id, ...props } }); return key; };
const rel = (from: string, type: string, to: string, props?: Props) => { if (from && to && from !== to) rels.push({ from, to, type, props }); };
const ll = (x: number, z: number) => { const g = unproject({ x, z }); return { lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6) }; };
const U_PER_M = 0.14;

// --- places, neighbourhoods -------------------------------------------------------------------------------------
const places = read('public/opus-bay/sf/v1/places.json').places as { id: string; name: { zh: string; en: string }; kind: string; x: number; z: number; plannerId?: string; guideSlug?: string; sourceUrl?: string }[];
const hoods = places.filter(p => p.kind === 'neighbourhood');
const hoodAt = (x: number, z: number) => {
  let best: typeof hoods[number] | null = null, bd = Infinity;
  for (const h of hoods) { const d = Math.hypot(h.x - x, h.z - z); if (d < bd) { bd = d; best = h; } }
  return best && bd < 2500 * U_PER_M ? best : null;
};
for (const h of hoods) node('Neighborhood', h.id, { name: h.name.zh, nameEn: h.name.en, ...ll(h.x, h.z), x: h.x, z: h.z });
const sfCity = node('City', 'san-francisco', { name: '旧金山', nameEn: 'San Francisco' });
for (const h of hoods) rel(`Neighborhood:${h.id}`, 'IN_CITY', sfCity);

// --- transit: lines, stations, NEXT ------------------------------------------------------------------------------
type Stop = { id: string; name: { zh: string; en: string }; x: number; z: number };
const lines = [...read('public/opus-bay/sf/v1/transit.json').lines, ...read('public/opus-bay/sf/v1/transit-w4.json').lines] as { id: string; kind: string; name: { zh: string; en: string }; color: string; osmRelation?: number; stops: Stop[] }[];
const stations: (Stop & { key: string })[] = [];
const seenLine = new Set<string>();
for (const l of lines) {
  // real lines only: the game's sightseeing loop (sf-loop) has no OpenStreetMap route relation
  if (seenLine.has(l.id) || l.id === 'sf-loop' || !l.osmRelation) continue; seenLine.add(l.id);
  const lk = node('Line', l.id, { name: l.name.zh, nameEn: l.name.en, kind: l.kind, color: l.color });
  let prev: string | null = null;
  l.stops.forEach((s, i) => {
    // one Station per physical stop (a stop shared by lines keeps the first id)
    let st = stations.find(o => Math.hypot(o.x - s.x, o.z - s.z) < 3);
    if (!st) { st = { ...s, key: node('Station', s.id, { name: s.name.zh, nameEn: s.name.en, ...ll(s.x, s.z), x: s.x, z: s.z }) }; stations.push(st); const h = hoodAt(s.x, s.z); if (h) rel(st.key, 'IN', `Neighborhood:${h.id}`); }
    rel(st.key, 'ON_LINE', lk, { order: i + 1 });
    if (prev) rel(prev, 'NEXT', st.key, { line: l.id });
    prev = st.key;
  });
}
const nearStations = (key: string, x: number, z: number, max = 2, withinM = 700) => {
  stations.map(s => ({ s, d: Math.hypot(s.x - x, s.z - z) / U_PER_M })).filter(o => o.d <= withinM).sort((a, b) => a.d - b.d).slice(0, max)
    .forEach(o => rel(key, 'NEAR', o.s.key, { meters: Math.round(o.d) }));
};

// attraction-ish places (skip bare streets / water)
const KEEP = new Set(['bridge', 'island', 'landmark', 'skyscraper', 'park', 'museum', 'waterfront', 'plaza', 'civic', 'stadium', 'historic', 'garden', 'beach', 'trail', 'hill', 'tower', 'zoo', 'attraction', 'viewpoint', 'peak', 'campus']);
for (const p of places) {
  if (!KEEP.has(p.kind)) continue;
  const k = node('Place', p.id, { name: p.name.zh, nameEn: p.name.en, kind: p.kind, ...ll(p.x, p.z), x: p.x, z: p.z, guide: p.guideSlug ? `https://www.baylink.us/guides/${p.guideSlug}` : null, osm: cleanUrl(p.sourceUrl) ?? null });
  const h = hoodAt(p.x, p.z); if (h) rel(k, 'IN', `Neighborhood:${h.id}`);
  nearStations(k, p.x, p.z);
}

// --- events -----------------------------------------------------------------------------------------------------
const catalog = read('public/planner-catalog.json');
const venueOf = new Map<string, Venue>();
for (const v of EVENT_VENUES) for (const id of v.events) venueOf.set(id, v);
for (const v of EVENT_VENUES) {
  const k = node('Venue', v.id, { name: v.name.zh, nameEn: v.name.en, ...ll(v.x, v.z), x: v.x, z: v.z, osm: cleanUrl(v.sourceUrl) });
  const h = hoodAt(v.x, v.z); if (h) rel(k, 'IN', `Neighborhood:${h.id}`);
  if (v.placeId && nodes.has(`Place:${v.placeId}`)) rel(k, 'IS_PLACE', `Place:${v.placeId}`);
  nearStations(k, v.x, v.z);
}
const cities = new Map<string, string>();
for (const e of catalog.events as Props[]) {
  const id = String(e.id);
  const planning = (e.planning ?? {}) as Props;
  const minAge = typeof planning.minAge === 'number' ? planning.minAge : null;
  const audience = (e.audience as string[] | undefined) ?? [];
  const k = node('Event', id, {
    title: e.title, titleEn: en(String(e.title)), startDate: e.startDate, endDate: e.endDate,
    dates: (e.occurrenceDates as string[] | undefined) ?? [], dateLabel: e.dateLabel, dateLabelEn: en(String(e.dateLabel ?? '')),
    category: e.category, cost: e.cost, costLabel: e.costLabel, admissionUsd: planning.admissionUsd ?? null,
    free: e.cost === 'free' || planning.admissionUsd === 0, minAge, adultsOnly: minAge !== null && minAge >= 18,
    familyFriendly: minAge === null && /亲子|孩子|儿童|家庭|family|kids/i.test(`${audience.join(' ')} ${e.summary ?? ''} ${e.title}`),
    reservation: planning.reservation ?? null, setting: planning.setting ?? null,
    summary: e.summary, summaryEn: en(String(e.summary ?? '')), audience, venueText: e.venue, city: e.city,
    url: cleanUrl(e.officialUrl) ?? null, baylink: `https://www.baylink.us/events/${id}`, verifiedAt: e.verifiedAt ?? null,
  });
  const city = String(e.city ?? 'Bay Area');
  if (!cities.has(city)) cities.set(city, city === 'San Francisco' ? sfCity : node('City', city.toLowerCase().replace(/[^a-z0-9]+/g, '-'), { name: city, nameEn: city }));
  rel(k, 'IN_CITY', cities.get(city)!);
  rel(k, 'OF_CATEGORY', node('Category', String(e.category ?? 'other'), { name: String(e.category ?? 'other') }));
  const v = venueOf.get(id);
  if (v) rel(k, 'AT', `Venue:${v.id}`);
}

// --- offers (BAYLINK's verified free / reduced admissions) --------------------------------------------------------
for (const o of read('public/opus-bay/sf/v1/live.json').offers as Props[]) {
  const t = o.title as { zh: string; en: string }, who = o.who as { zh: string; en: string }, req = o.requirement as { zh: string; en: string };
  const k = node('Offer', String(o.id), { title: t.zh, titleEn: t.en, free: !!o.free, from: o.from ?? null, to: o.to ?? null, weekdays: o.weekdays ?? null, who: who?.zh, whoEn: who?.en, requirement: req?.zh, requirementEn: req?.en, baylink: `https://www.baylink.us${o.href}`, url: cleanUrl((o.source as Props)?.url) ?? null, kind: o.kind });
  const p = o.place as { id?: string; x?: number; z?: number } | undefined;
  if (p?.id && nodes.has(`Place:${p.id}`)) rel(k, 'AT', `Place:${p.id}`);
  else if (p && typeof p.x === 'number' && typeof p.z === 'number') { const h = hoodAt(p.x, p.z); if (h) rel(k, 'IN', `Neighborhood:${h.id}`); nearStations(k, p.x, p.z); }
}

// --- new openings --------------------------------------------------------------------------------------------------
for (const o of read('src/data/autumn-release-openings.json') as Props[]) {
  const city = String(o.city ?? 'Bay Area');
  const k = node('Opening', String(o.id), { name: o.name, category: o.category, status: o.status, address: o.address ?? null, dateLabel: o.dateLabel, summary: o.summary, url: cleanUrl(o.officialUrl) ?? null, city });
  if (!cities.has(city)) cities.set(city, city === 'San Francisco' ? sfCity : node('City', city.toLowerCase().replace(/[^a-z0-9]+/g, '-'), { name: city, nameEn: city }));
  rel(k, 'IN_CITY', cities.get(city)!);
}

mkdirSync(resolve(OUT, '..'), { recursive: true });
const out = { exported: new Date().toISOString(), source: 'BAYLINK (https://www.baylink.us) catalog + Opus Bay San Francisco data (OpenStreetMap)', nodes: [...nodes.values()], rels };
writeFileSync(OUT, JSON.stringify(out));
const count = (l: string) => out.nodes.filter(n => n.label === l).length;
const unique = new Set(rels.map(r => `${r.from}|${r.type}|${r.to}`)).size;
console.log(`${OUT}: nodes ${out.nodes.length} rels ${rels.length} (${unique} unique)`, ['Event', 'Venue', 'Place', 'Neighborhood', 'Station', 'Line', 'Offer', 'Opening', 'City', 'Category'].map(l => `${l} ${count(l)}`).join(' · '));
