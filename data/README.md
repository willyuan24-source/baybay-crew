# data/graph.json

The knowledge graph the crew plans from: a snapshot of **2026-09-29** exported from [BAYLINK](https://www.baylink.us)
with [`scripts/export-from-baylink.mts`](../scripts/export-from-baylink.mts). `npm run load` loads it into Neo4j;
`src/graph.mjs` also reads it into memory and answers the same queries from it when Neo4j is not configured or not
answering.

## Format

One JSON object:

```
{ "exported": "<ISO time of the export>", "source": "…",
  "nodes": [{ "id": "<Label>:<id>", "label": "<Label>", "props": { "id": "<id>", … } }],
  "rels":  [{ "from": "<node id>", "to": "<node id>", "type": "<TYPE>", "props": { … } }] }
```

The node `id` becomes the unique `key` of the node in Neo4j, where every node also gets the label `:Entity`. Only `NEAR`
(`meters`), `ON_LINE` (`order`) and `NEXT` (`line`) relationships have `props`.

## Contents

1,577 nodes: Place 957 · Event 267 · Station 145 · Neighborhood 72 · City 64 · Opening 31 · Venue 18 · Offer 13 · Line 6 ·
Category 4.

2,915 relationship rows: IN 1,081 · NEAR 819 · IN_CITY 370 · OF_CATEGORY 267 · ON_LINE 168 · NEXT 155 · AT 49 ·
IS_PLACE 6. 21 rows repeat a pair already linked by the same type (14 `NEXT` rows on track two lines share, 7 `ON_LINE`
rows where the F line lists a stop twice in a row); Neo4j's `MERGE` keeps one, so Neo4j holds 2,894 relationships.

- **Events** (267 in the Bay Area; the 59 in San Francisco run from 2026-09-26 to 2026-10-31): BAYLINK's verified catalog
  (verified 2026-09-28 / 29): titles and summaries in Chinese and English, dates, cost, minimum age, the official link and
  the BAYLINK page.
- **Offers** (13): BAYLINK's verified free / reduced admissions at San Francisco museums and parks (and free Muni for
  riders 18 and under), with their dates or weekdays.
- **Openings** (31): new shops and restaurants (autumn 2026) from BAYLINK.
- **Places, venues, neighbourhoods, stations and lines**: San Francisco places, the 18 venues where San Francisco catalog
  events happen (38 of the 59 events are placed at one), neighbourhoods and six rail / cable-car lines with their stops,
  from OpenStreetMap through BAYLINK's map data; `NEAR` links a place, venue or offer to its 2 nearest stations within
  700 m.

Changed in this repo since the export: the made-up "SF Sightseeing Loop" (a route from BAYLINK's 3D city game with no
OpenStreetMap route relation) was removed with its 16 stops, and `NEAR` was recomputed over the remaining stations;
ad-click tracking parameters were removed from official links, and one dead link was dropped. The exporter now skips the
loop and strips tracking parameters too (it does not check links), and a re-export pulls BAYLINK's catalog as it is that
day, so the counts above will change.

## Sources and terms

The [MIT License](../LICENSE) of this repo covers the code. **It does not cover this data.**

- The event catalog (events, offers, openings: titles, summaries, dates, prices, age limits, links) is © BAYLINK
  (https://www.baylink.us), shared here so the demo runs.
- Places, venues, neighbourhoods, stations and lines are derived from OpenStreetMap: © OpenStreetMap contributors,
  available under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
  (https://www.openstreetmap.org/copyright).
