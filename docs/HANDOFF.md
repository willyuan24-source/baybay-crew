# BAYBAY Crew — project handoff

🏆 **Winner — Best Use of Neo4j** ($500 Neo4j Aura credits), The AI Conference Hack Day 2026 (Pier 48, San Francisco,
2026-09-29, 57 projects). Built in ~3 hours (12:30–15:13 PDT) on top of BAYLINK (https://www.baylink.us).

This document is the full picture of the project for whoever continues it: what it is, how every part works, where each
file is, how to run it, what is weak, and what to build next. The owner-only details (accounts, local paths, how the
demo machine was set up) live in `HANDOFF.local.md`, which is git-ignored.

---

## 1. What it is

**One line:** four AI agents coordinate in a Band room to plan a real day out in San Francisco from a Neo4j knowledge graph
of BAYLINK's verified local catalog, reasoning with open models on Crusoe — and a Checker agent re-verifies every stop
against the graph (and can veto the plan) before a human sees it.

**Problem:** travel chatbots invent events, get dates wrong and send families to 21+ shows. **Answer:** split the job so
every fact comes from a graph of real, dated data and every plan is checked before it is shown.

**User flow:** type a request in Chinese or English ("A free Saturday with kids, reachable by Muni" / "这周六带小孩，免费、坐公交能到"),
pick a date → ~15–35 s later a 3–5 stop, time-ordered plan with FREE pills, transit hints, "✓ verified" ticks and links to
real BAYLINK pages; the whole agent conversation, the Crusoe calls, the Cypher queries and the plan's subgraph are shown
live next to it.

## 2. Architecture

```
Visitor (web UI or @BAYBAY in the Band room)
   │ request
   ▼
┌──────────────── Band room (the ONLY channel between agents) ─────────────────┐
│ BAYBAY ──@Scout──▶ Scout ──@Planner──▶ Planner ──@Checker──▶ Checker          │
│    ▲                                       ▲                    │             │
│    └──────────────@BAYBAY (approved)───────┼────────────────────┘             │
│                                            └──@Planner (fix these, ≤3 rounds)─┘
└───────────────────────────────────────────────────────────────────────────────┘
 Scout / Planner / Checker ──Cypher──▶ Neo4j Aura (1,594 nodes · 3,053 rels)
 Scout / Planner / Checker ──chat────▶ Crusoe Managed Inference (one open model each)
 server (SSE) ──▶ web UI: plan card · Band trace · graph · dashboard · Cypher log
```

### 2.1 The agents (`src/agents.mjs`)

| agent | trigger (a Band message to it) | does | sends |
|---|---|---|---|
| **BAYBAY** (host) | the UI's request, or a human `@BAYBAY …` in the room; later the Checker's verdict | starts a run; delivers the final plan to the UI | `@Scout` request · `task` event "plan delivered" |
| **Scout** | `@Scout` from BAYBAY | Crusoe (DeepSeek-V4-Flash) turns the text into filters `{freeOnly, family, keywords[], interests, pace}`; runs `findEvents` (widens if < 3 hits: drop keywords, then drop free-only), `findOffers`, `findPlaces` in the neighbourhoods found; trims to ≤ 10 events / 5 offers / 6 places; emits the candidates' subgraph | `@Planner` + payload `{runId, request, filters, candidates}` |
| **Planner** | `@Planner` from Scout (round 1) or Checker (round n) | Crusoe (DeepSeek-V4-Pro) picks 3–5 stops **only by candidate id**, in time order, with a "why"; then for each consecutive pair `shortestPath` over station `NEXT` relations gives a transit hint | `@Checker` + payload `{…, plan, round}` |
| **Checker** | `@Checker` from Planner | **graph checks** (authoritative): every stop id exists; event happens on the date (`dates[]` or start/end); not 21+ when `family`; free when `freeOnly`; offer valid on the date; place was a candidate; no duplicates; times ascending. **Model review** (Crusoe Gemma 4 31B, a different model): judges fit (pace, travel, constraints) and may return `fixes` on round 1 | issues or fixes and round < 3 → `@Planner` "Round n rejected, please fix: …" (the **veto**) · else `@BAYBAY` approved (or approved with a note) |

`MAX_ROUNDS = 3`. The whole state of a run travels in the Band messages (a human line + a fenced JSON payload), so the
room is the source of truth and the audit log. Every agent also posts `thought`, `tool_call`, `tool_result`, `task` events.

### 2.2 Band transport (`src/room.mjs`)

- REST only (`@band-ai/rest-client`, `BandClient`), one client per agent (each agent's own API key).
- On start: `getAgentMe()` for each agent (id / name / handle); use `BAND_ROOM_ID` or BAYBAY creates a room
  (`createAgentChat`) and adds the other three (`addAgentChatParticipant`).
- Each agent polls `getAgentNextMessage(room)` every 800 ms → `markAgentMessageProcessing` → handler →
  `markAgentMessageProcessed` (or `markAgentMessageFailed`). Messages from itself are ignored.
- Send = `createAgentChatMessage(room, {message: {content, mentions: [{id, name, handle}]}})`; events =
  `createAgentChatEvent(room, {event: {content, message_type}})`.
- **Delete test:** agents act only on what Band delivers, so deleting the room stops the crew.
- Fallback `LocalRoom` (same API, in-process) when the four agent keys are missing — labelled "local" in the UI.

### 2.3 Crusoe (`src/llm.mjs`, `src/config.mjs`)

- OpenAI-compatible: `new OpenAI({ baseURL: 'https://api.inference.crusoecloud.com/v1', apiKey })`.
- One model per agent (env-overridable): Scout `deepseek-ai/Deepseek-V4-Flash`, Planner `deepseek-ai/DeepSeek-V4-Pro`,
  Checker `google/gemma-4-31b-it`. Model IDs are **case-sensitive and must match `/v1/models`** (docs differ).
- `chat()` retries 429/5xx twice, strips `<think>…</think>`, extracts the first valid JSON object, and on failure uses a
  rule-based fallback (never presented as Crusoe). Every call emits `{provider, model, ms, tokens}` to the UI.
- Benchmarks on 2026-09-29 (same JSON-extraction prompt): DeepSeek-V4-Flash 0.6 s, DeepSeek-V4-Pro 0.8 s, Qwen3.8-27B 0.8 s
  (reasoning), Gemma 4 1.1 s, GLM-5.3 1.9 s, Kimi-K2.6 2.8 s (reasoning; a full plan took ~45 s / ~6k tokens, hence
  replaced), gpt-oss-120b 4.4 s, Nemotron-3.5-Lightning returned empty content at 600 max tokens (all spent reasoning).

### 2.4 Neo4j (`src/graph.mjs`, `src/load-neo4j.mjs`, `data/graph.json`)

**Model** (every node also has label `:Entity` and unique `key = "<Label>:<id>"`):

```
(:Event)-[:AT]->(:Venue)-[:IN]->(:Neighborhood)-[:IN_CITY]->(:City)
(:Venue|:Place|:Offer)-[:NEAR {meters}]->(:Station)-[:ON_LINE {order}]->(:Line)
(:Station)-[:NEXT {line}]->(:Station)     (:Event)-[:OF_CATEGORY]->(:Category)
(:Event)-[:IN_CITY]->(:City)   (:Offer)-[:AT]->(:Place)   (:Venue)-[:IS_PLACE]->(:Place)   (:Opening)-[:IN_CITY]->(:City)
```

**Counts:** Event 267 · Place 957 · Station 161 · Neighborhood 72 · City 64 · Opening 31 · Venue 18 · Offer 13 · Line 7 ·
Category 4 (1,594 nodes); NEAR 931 · IN 1,097 · IN_CITY 370 · OF_CATEGORY 267 · ON_LINE 184 · NEXT 170 · AT 49 · IS_PLACE 6
(3,074 in the JSON, 3,053 after MERGE de-duplication in Aura).

**Event properties:** title / titleEn, startDate, endDate, `dates[]` (occurrences), dateLabel(En), category, cost,
costLabel, admissionUsd, `free`, `minAge`, `adultsOnly`, `familyFriendly`, reservation, setting, summary(En), audience,
venueText, city, url (official), baylink (`https://www.baylink.us/events/<id>`), verifiedAt.

**Queries (all parameterized, READ routing):**
- `events` — SF events on `$date` with `$freeOnly`, `$family`, `$keywords` (zh + en), joined to venue → neighbourhood →
  nearest 2 stations with lines; ordered free first, family first, with a venue first; LIMIT 14.
- `offers` — offers valid on `$date` and `$weekday`, with place / neighbourhood.
- `places` — places of 10 kinds in `$hoodIds`, nearest station, guide-linked first.
- `route` — `shortestPath((a:Station)-[:NEXT*..60]-(b:Station))` → stops, lines, hops.
- `event` / `offer` — re-read one node for the Checker.
- **Dashboard** (3 graph questions): free events by neighbourhood · stations with the most attractions within 700 m ·
  family-friendly events reachable on each line.
- `subgraph(keys)` builds the vis-network picture (2 hops over AT / IN / NEAR / ON_LINE / IS_PLACE / OF_CATEGORY).

**Local fallback:** without `NEO4J_*` every tool answers the same question from `data/graph.json` in memory (the UI says
"local graph"). **Loader:** `npm run load` — constraint on `:Entity(key)`, an index per label, deletes `:Entity` nodes,
then batched `UNWIND … MERGE` (500 nodes / 1,000 rels per batch); idempotent.

**Where the data comes from** (`scripts/export-from-baylink.mts`, run inside a BAYLINK checkout with its `tsx`):
`public/planner-catalog.json` (267 events, verified 2026-09-29), `public/opus-bay/sf/v1/places.json` (OpenStreetMap places
incl. 72 neighbourhoods), `public/opus-bay/sf/v1/transit.json` + `transit-w4.json` (cable cars, F-line, Muni N / M,
sightseeing loop), `public/opus-bay/sf/v1/live.json` (verified free / reduced offers), `src/opus-bay/realsf/eventVenues.ts`
(OSM-checked venue points), `src/data/autumn-release-openings.json`. Neighbourhood = nearest OSM neighbourhood centroid
within 2.5 km; NEAR = the 2 nearest stations within 700 m; English text through the site's translation layer.

### 2.5 Server and UI (`src/server.mjs`, `public/index.html`)

- Plain `node:http`, port 8787 (`PORT`). Logs unhandled rejections instead of exiting.
- API: `GET /api/status` (sponsor pills) · `POST /api/ask {text, lang, date}` → `{runId}` · `GET /api/stream` (SSE:
  `room`, `llm`, `cypher`, `graph`, `plan`, `status`, `error`, `done`) · `GET /api/graph/overview` · `GET /api/dashboard` ·
  static files from `public/` (incl. `/demo/slides.html#title|arch|end`).
- UI (one file, vanilla JS + vis-network from unpkg): top bar with three live sponsor pills and 中文 / EN; left = ask box,
  4 example chips, the plan card; middle = Band room trace (agent colours, @chips, Crusoe badge per LLM call, thinking
  indicator, stats strip); right = Graph / Dashboard / Cypher log tabs. Works at 390 px.

## 3. Run it

```bash
npm install
cp .env.example .env    # Crusoe key · Neo4j URI/user/password · 4 Band agent ids + keys · optional BAND_ROOM_ID
npm run check           # one line per sponsor: key present, service answering
npm run load            # load data/graph.json into Neo4j Aura (idempotent)
npm start               # http://localhost:8787
```

Without keys it still runs end to end (local graph, in-process room, rule-based reasoning), clearly labelled.
Band setup: create 4 External agents (BAYBAY / Scout / Planner / Checker), copy each Agent UUID + API key; create a
Session with all four (and yourself) and put its id in `BAND_ROOM_ID` so you can watch the run in Band.

## 4. Demo assets (`demo/`)

- `baybay-crew-walkthrough.mp4` (2:50, narrated, English subtitles burned in; `.en.srt` beside it): problem → stack →
  live run with a Checker veto → result + dashboard → the Band room (veto, then approval) → the code → close.
- `baybay-crew-demo.mp4` (1:46): the short cut. `screenshot.png`, `band-room.jpg`.
- `record.mjs`: records slides + a real run with headless Chrome over CDP (`Page.startScreencast`), frames + timestamps →
  ffmpeg. `slides.html` (title / architecture / end; also served at `/demo/slides.html`).
- `DEMO-SCRIPT.md` (3-minute recording script), `SPEAKER-NOTES.md` (opening + live close), `SUBMISSION.md` (pitch texts).
- Narration was generated with Higgsfield (Seed Audio, voice "Ainsley"); the videos were assembled with ffmpeg.

## 5. Results and how it compared

Winners: Crusoe overall 1st Thermal Crusoe, 2nd Safe Scribe, 3rd Deja · **Neo4j Best Use: BAYBAY Crew** · Neo4j Best
Technical: CertAIn · Neo4j Most Creative: LineSignal · DuploCloud Best Agent: Harmony · Plaud: SiteSync · Vultr: SYNTH.

What the judges could see as our edge: **real data** (most entries used synthetic data or ticked Neo4j without real
queries), the graph as the **referee** (every stop re-verified, plans vetoed), transit via `shortestPath`, and a one-screen
view of graph + queries + agent trace. Where stronger entries beat us: deployment, tests and measured numbers (accuracy,
cost per run), runtime recruitment / humans in the Band room, more sponsors meaningfully used.

## 6. Known gaps (honest)

- Local only (no deploy, auth or rate limit); ~15–35 s per plan; results vary run to run.
- Pipeline with fixed roles + one feedback loop; no runtime recruitment, no human in the room; Band messages carry wide
  JSON blocks; polling (800 ms), not websockets.
- Cypher is basic: no GDS algorithms, no vector index / GraphRAG, no text-to-Cypher.
- Data: only 18 SF venues with coordinates (≈ 38 of 59 SF events placed), a few candidates per day; no opening hours or
  travel times; the transit graph is rail / cable car / loop only (no buses); catalog snapshot of 2026-09-29.
- The Checker verifies facts, not experience (hours, walking distance, zig-zags rely on the reviewer model).
- No tests, no eval set.

## 7. What to build next (suggested order)

1. **Deploy** (Render / Vultr) with a public URL, a request limit and cost guard; keep `.env` secrets in the host.
2. **Data:** all Bay Area venues with coordinates; opening hours; GTFS (Muni + BART) as `(:Stop)-[:NEXT {minutes}]->`
   for real travel times; refresh from BAYLINK's catalog automatically.
3. **Neo4j depth** (use the $500 Aura credits): vector index on event summaries for semantic search (GraphRAG),
   GDS (PageRank for hubs, Louvain for "day zones", weighted shortest path by minutes), validated text-to-Cypher for
   free-form questions.
4. **Checker:** hours and travel-time checks, a score per plan, an eval set (50 requests) with accuracy / latency / cost.
5. **Band depth:** runtime recruitment (e.g. a Food or Weather specialist joins only when needed), a human approval step
   in the room, visibility boundaries, collapsible payloads, websockets.
6. **Product:** a "BAYBAY 帮我排一天" feature on baylink.us (saved plans, share card) and in Opus Bay 3D (BAYBAY walks the plan).

## 8. File map

| path | what |
|---|---|
| `src/agents.mjs` | the four agents, prompts, fallbacks, veto loop |
| `src/room.mjs` | Band REST transport + local room |
| `src/graph.mjs` | Cypher tools, local engine, subgraph, dashboard |
| `src/llm.mjs` · `src/config.mjs` | Crusoe client, per-agent models, env |
| `src/server.mjs` · `src/bus.mjs` | HTTP + SSE, event bus |
| `src/load-neo4j.mjs` · `src/check.mjs` | Aura loader, sponsor checks |
| `public/index.html` | the UI |
| `data/graph.json` | the exported graph (958 KB) |
| `scripts/export-from-baylink.mts` | the exporter (needs a BAYLINK checkout) |
| `demo/` · `DEMO-SCRIPT.md` · `SPEAKER-NOTES.md` · `SUBMISSION.md` | videos, recorder, slides, scripts |

Data © BAYLINK (catalog) and OpenStreetMap contributors (ODbL) for places, venues and transit.
