# BAYBAY Crew — project handoff

🏆 **Winner — Best Use of Neo4j** ($500 Neo4j Aura credits), The AI Conference Hack Day 2026 (Pier 48, San Francisco,
2026-09-29, 57 projects). Built in about 3 hours (start ≈ 12:30, first commit 13:03, submitted 15:13 PDT) on top of
BAYLINK (https://www.baylink.us).

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
pick a date → ~15–35 s later a time-ordered plan (the prompt asks for 3–5 stops; the code keeps up to 6, needs ≥ 2) with
FREE pills, transit hints, "✓ verified" ticks and links to real BAYLINK pages; the whole agent conversation, the Crusoe
calls, the Cypher queries and the subgraph of Scout's candidates are shown live next to it. The UI language follows the
中文 / EN toggle (saved in localStorage), not the request text.

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
| **Scout** | `@Scout` from BAYBAY | Crusoe (DeepSeek-V4-Flash) turns the text into filters; the prompt asks for `{freeOnly, family, keywords[], interests, pace}` but only `freeOnly`, `family` and `keywords` (≤ 6) are used (`interests` only shows in a thought, `pace` is dropped); runs `findEvents` (widens if < 3 hits: drop keywords, then drop free-only), `findOffers`, `findPlaces` in ≤ 5 neighbourhoods found; trims to ≤ 10 events / 5 offers / 6 places; emits the candidates' subgraph | `@Planner` + payload `{runId, request, filters, candidates}` |
| **Planner** | `@Planner` from Scout (round 1) or Checker (round n) | Crusoe (DeepSeek-V4-Pro) picks stops by candidate id (falls back to an exact name match), in time order, with a "why"; then for consecutive stops that both carry a station **id** `shortestPath` over `NEXT` gives a transit hint — in practice only **event→event** pairs (places carry a station *name*, offers none) | `@Checker` + payload `{…, plan, round}` |
| **Checker** | `@Checker` from Planner | **graph checks** (authoritative): **events** re-read from the graph — happens on the date (`dates[]` or start/end), not adults-only (minAge ≥ 18) when `family`, free when `freeOnly`; **offers** re-read — valid from/to (weekdays not re-checked); **places** — only checked to be one of the candidates; no duplicates; times ascending (string compare). Free-text `why` / `notes` are not checked. **Model review** (Crusoe Gemma 4 31B, a different model): judges fit (pace, travel, constraints) and may return `fixes` on round 1 only | issues or fixes and round < 3 → `@Planner` "Round n rejected, please fix: …" (the **veto**) · else `@BAYBAY` approved / approved with a note / "Still N issue(s) after 3 rounds" (delivered with `approved: false`) |

`MAX_ROUNDS = 3` (up to 3 drafts, at most 2 vetoes; the header comment in `agents.mjs` still says 2 — stale). The whole
state of a run travels in the Band messages (a human line + a fenced JSON payload), so the room is the source of truth.
Room events: Scout posts `thought`, `tool_call`, `tool_result`; Planner a `thought` on revision rounds (its `route()` calls
are not posted); Checker `tool_result` + `thought`; BAYBAY `task`. Crusoe / Neo4j failure notices go to the UI only.
LLM settings: temperature 0.3; max_tokens Scout 1,400 · Planner 5,000 · Checker 1,500.

### 2.2 Band transport (`src/room.mjs`)

- REST only (`@band-ai/rest-client`, `BandClient`), one client per agent (each agent's own API key).
- On start: `getAgentMe()` for each agent (id / name / handle); use `BAND_ROOM_ID` or BAYBAY creates a room
  (`createAgentChat`) and adds the other three (`addAgentChatParticipant`).
- Each agent polls `getAgentNextMessage(room)` every 800 ms → `markAgentMessageProcessing` → handler →
  `markAgentMessageProcessed` (or `markAgentMessageFailed`). Messages from itself are ignored.
- Send = `createAgentChatMessage(room, {message: {content, mentions: [{id, name, handle}]}})`; events =
  `createAgentChatEvent(room, {event: {content, message_type}})`.
- **Delete test:** agents act only on what Band delivers, so deleting the room stops the crew.
- Fallback `LocalRoom` (same API, in-process) when any of the 8 values (4 `*_AGENT_ID` + 4 `*_API_KEY`) is missing, or when
  `BandRoom.start()` throws — labelled "local" in the UI either way.
- Without `BAND_ROOM_ID` every restart creates a new room (not saved, and the human is not added): set it.
- Runs started by a human `@BAYBAY` in Band get a `band-…` run id and the server's default date; the web UI only shows the
  run it started itself, and the human in Band gets only a "plan delivered" event, not a readable plan.
- Only `@band-ai/rest-client` is used; `@band-ai/sdk` is installed but not imported.

### 2.3 Crusoe (`src/llm.mjs`, `src/config.mjs`)

- OpenAI-compatible: `new OpenAI({ baseURL: 'https://api.inference.crusoecloud.com/v1', apiKey })`.
- One model per agent (env-overridable): Scout `deepseek-ai/Deepseek-V4-Flash`, Planner `deepseek-ai/DeepSeek-V4-Pro`,
  Checker `google/gemma-4-31b-it`. Model IDs are **case-sensitive and must match `/v1/models`** (docs differ).
- `chat()` retries 429/5xx twice (1.2 s, 2.4 s; network errors without a status are not retried), strips
  `<think>…</think>` and extracts the first valid JSON object. On an HTTP failure it uses a rule-based fallback labelled
  "Crusoe (failed → fallback)". **Caveat:** when Crusoe answers but no JSON can be extracted, the badge already says
  "Crusoe" and the rule-based result is used silently (fix: emit a second `llm` event or relabel). Every call emits
  `{provider, model, ms, tokens}` to the UI.
- Env: `CRUSOE_API_KEY`, `CRUSOE_BASE_URL`, `CRUSOE_SCOUT_MODEL` / `CRUSOE_PLANNER_MODEL` / `CRUSOE_CHECKER_MODEL`, and
  `CRUSOE_MODEL` (default Kimi-K2.6: only the fallback model, the one `npm run check` tests and the one the startup log
  prints — not one of the three agents' models).
- Benchmarks on 2026-09-29 (same JSON-extraction prompt): DeepSeek-V4-Flash 0.6 s, DeepSeek-V4-Pro 0.8 s, Qwen3.8-27B 0.8 s
  (reasoning), Gemma 4 1.1 s, GLM-5.3 1.9 s, Kimi-K2.6 2.8 s (reasoning; a full plan took ~45 s / ~6k tokens, hence
  replaced), gpt-oss-120b 4.4 s, Nemotron-3.5-Lightning returned empty content at 600 max tokens (all spent reasoning).

### 2.4 Neo4j (`src/graph.mjs`, `src/load-neo4j.mjs`, `data/graph.json`)

**Model** (every node also has label `:Entity` and unique `key = "<Label>:<id>"`):

```
(:Event)-[:AT]->(:Venue)-[:IN]->(:Neighborhood)-[:IN_CITY]->(:City)
(:Place|:Station|:Offer)-[:IN]->(:Neighborhood)        IN = Place 917 · Station 161 · Venue 18 · Offer 1
(:Venue|:Place|:Offer)-[:NEAR {meters}]->(:Station)-[:ON_LINE {order}]->(:Line)
(:Station)-[:NEXT {line}]->(:Station)     (:Event)-[:OF_CATEGORY]->(:Category)
(:Event)-[:IN_CITY]->(:City)   (:Offer)-[:AT]->(:Place)   (:Venue)-[:IS_PLACE]->(:Place)   (:Opening)-[:IN_CITY]->(:City)
```

Opening and Category nodes are loaded but no agent or dashboard query uses them (Category only appears in the picture).

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
- `subgraph(keys)` builds the vis-network picture (2 hops over AT / IN / NEAR / ON_LINE / IS_PLACE / OF_CATEGORY) of
  **Scout's candidates** (the chosen stops are not redrawn); the picture, the overview and the graph walks are always built
  from `data/graph.json` in memory, not from Aura.

**Local fallback:** without `NEO4J_*` every tool answers the same question from `data/graph.json` in memory; the UI pill
then reads "Neo4j · offline" (red). When Aura is configured but one query fails, that query alone falls back to the local
JSON and an error line goes to the trace. The two engines differ slightly: Aura's keyword match looks at title + titleEn +
summaryEn (local also at the Chinese summary and audience), and Aura's "nearest 2 stations" can be one station on two lines.
**Loader:** `npm run load` — constraint on `:Entity(key)`, an index per label, deletes `:Entity` nodes,
then batched `UNWIND … MERGE` (500 nodes / 1,000 rels per batch); idempotent.

**Where the data comes from** (`scripts/export-from-baylink.mts`, run inside a BAYLINK checkout with its `tsx`; the import
paths and the output path are absolute paths of the original machine — edit them first):
`public/planner-catalog.json` (267 events, verified 2026-09-28/29; exported 2026-09-29), `public/opus-bay/sf/v1/places.json` (OpenStreetMap places
incl. 72 neighbourhoods), `public/opus-bay/sf/v1/transit.json` + `transit-w4.json` (cable cars, F-line, Muni N / M,
sightseeing loop), `public/opus-bay/sf/v1/live.json` (verified free / reduced offers), `src/opus-bay/realsf/eventVenues.ts`
(OSM-checked venue points), `src/data/autumn-release-openings.json`. Neighbourhood = nearest OSM neighbourhood centroid
within 2.5 km; NEAR = the 2 nearest stations within 700 m; English text through the site's translation layer.

### 2.5 Server and UI (`src/server.mjs`, `public/index.html`)

- Plain `node:http`, port 8787 (`PORT`). Logs unhandled rejections instead of exiting.
- API: `GET /api/status` (sponsor pills) · `POST /api/ask {text, lang, date}` → `{runId, date}` (text cut to 500 chars,
  empty → 400, bad / missing date → next Saturday, lang `en` else `zh`) · `GET /api/stream` (SSE: `run`, `room`, `llm`,
  `cypher`, `graph`, `plan`, `status` (once on connect), `error`, `done`; ping every 15 s) · `GET /api/graph/overview` ·
  `GET /api/dashboard` · static files from `public/` (incl. `/demo/slides.html#title|arch|end`).
- UI (one file, vanilla JS + vis-network from unpkg, unpinned): top bar with three live sponsor pills (re-polled every
  30 s) and 中文 / EN (saved as `baybay.lang`); left = ask box (date picker, Ctrl+Enter), 4 example chips (the Halloween chip
  sets Oct 31), the plan card; middle = Band room trace (agent colours, @chips, Crusoe badge per LLM call, thinking
  indicator, stats strip); right = Graph (Overview / Fit) / Dashboard / Cypher log (last 100, unseen counter). 300 s
  safety timeout per run. CSS breakpoints at 1100 px and 560 px.

## 3. Run it

```bash
npm install
cp .env.example .env    # Crusoe key · Neo4j URI/user/password · 4 Band agent ids + keys · optional BAND_ROOM_ID
npm run check           # Crusoe (tests CRUSOE_MODEL + that the Checker model exists), Neo4j, Band (each agent + the room)
npm run load            # load data/graph.json into Neo4j Aura (idempotent)
npm start               # http://localhost:8787
```

Without keys it still runs end to end (local graph, in-process room, rule-based reasoning), clearly labelled.
Env (see `.env.example`): `CRUSOE_*` (above), `NEO4J_URI`, `NEO4J_USERNAME` (Aura's credentials file gives the instance id,
not "neo4j"), `NEO4J_PASSWORD`, `NEO4J_DATABASE` (optional), `BAYBAY_ / SCOUT_ / PLANNER_ / CHECKER_AGENT_ID` and `_API_KEY`,
`BAND_ROOM_ID`, `BAND_POLL_MS` (800), `PORT` (8787). Node 22+ (global `fetch` / `WebSocket`; developed on Node 24).
Band setup: create 4 External agents (BAYBAY / Scout / Planner / Checker), copy each Agent UUID + API key; create a
Session with all four (and yourself) and put its id in `BAND_ROOM_ID` so you can watch the run in Band.

## 4. Demo assets (`demo/`)

- `baybay-crew-walkthrough.mp4` (2:50, narrated, English subtitles burned in; `.en.srt` beside it): problem → stack →
  live run with a Checker veto → result + dashboard → the Band room (veto, then approval) → the code → close.
- `baybay-crew-demo.mp4` (1:46): the short cut. `screenshot.png`, `band-room.jpg`.
- `record.mjs`: records the slides (PNG) and a real run with headless Chrome over CDP (`Page.startScreencast`: JPEG frames
  + `timeline.json`); the videos were then cut with ffmpeg outside the repo. **It deletes its output folder at start** and
  hard-codes the Chrome path, the request, the date and the output folder — edit before reuse.
  `slides.html` (title / architecture / end; also served at `/demo/slides.html`).
- In the repo root: `DEMO-SCRIPT.md` (3-minute recording script), `SPEAKER-NOTES.md` (opening + live close),
  `SUBMISSION.md` (pitch texts).
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
- **The data runs out:** no SF event after 2026-10-31 (3–6 SF events per October Saturday); from November plans fall back
  to offers and places until the graph is re-exported.

### 6.1 Bugs and gotchas to fix first

1. `nextSaturday()` (server default date) parses the LA time string as local time and calls `toISOString()`: after 17:00
   PDT it returns a Sunday, and on a Saturday it returns next week (the UI's own default returns today).
2. Crusoe badge on a silent JSON-parse fallback (§2.3).
3. Transit hints only between two event stops (places store a station name, offers none).
4. Checker: time order is a string compare (`9:30` > `10:00`); the ✓ tick ignores the free check; offer weekdays and the
   free-text notes are not verified.
5. Deploy blockers: `/api/stream` broadcasts every run (incl. request text) to every client; any `error` event ends the
   run in every open UI; no auth / rate limit; `/api/status` exposes the Band room and agent ids.
6. `.webp` / `.jpg` / `.mp4` under `public/demo` are served as `application/octet-stream`; request bodies > 100 KB are
   dropped without a response; vis-network is unpinned (offline the graph tab gives up after 20 s).
7. Stale comment "max 2 rounds" in `agents.mjs` (it is 3); dead default `osm-n-mission` in Scout.

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
| `demo/` · `public/demo/` | videos, recorder, slides (+ a served copy with `key.webp`) |
| `DEMO-SCRIPT.md` · `SPEAKER-NOTES.md` · `SUBMISSION.md` | recording script, speaker notes, pitch texts |
| `README.md` · `.env.example` · `package.json` | overview, env template, scripts (`start`, `check`, `load`) |

Data © BAYLINK (catalog) and OpenStreetMap contributors (ODbL) for places, venues and transit.
