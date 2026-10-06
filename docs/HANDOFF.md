# BAYBAY Crew — project handoff

🏆 **Winner — Best Use of Neo4j** ($500 Neo4j Aura credits), The AI Conference Hack Day 2026 (Pier 48, San Francisco,
2026-09-29; 92 projects listed on HackerSquad). Built in about 3 hours (start ≈ 12:30, first commit 13:03, submitted 15:13 PDT) on top of
BAYLINK (https://www.baylink.us). The judged version is tagged `hackday-2026-submission` (commit 7c842e7); later commits
are fixes and docs.

This document is the full picture of the project for whoever continues it: what it is, how every part works, where each
file is, how to run it, what is weak, and what to build next. Machine-specific setup is not part of this repo.

---

## 1. What it is

**One line:** four AI agents coordinate in a Band room to plan a real day out in San Francisco from a Neo4j knowledge graph
of BAYLINK's local catalog, reasoning with open models on Crusoe — and a Checker agent re-reads every stop from the graph
(and can veto the plan) before a human sees it.

**Problem:** travel chatbots invent events, get dates wrong and send families to 21+ shows. **Answer:** split the job so
every fact comes from a graph of real, dated data and every plan is checked before it is shown.

**User flow:** type a request in Chinese or English ("A free Saturday with kids, reachable by Muni" / "这周六带小孩，免费、坐公交能到"),
pick a date → ~15–35 s later (with Crusoe; almost at once on the rule-based fallback) a time-ordered plan (the prompt asks
for 3–5 stops; the code keeps up to 6, the Checker needs ≥ 2) with FREE pills, transit hints, "✓ verified" ticks and
links to real BAYLINK pages; the whole agent conversation, the model calls, the Cypher queries and the subgraph of Scout's
candidates are shown live next to it. Under the date picker a notice appears when the date is after the last event in
the graph. The UI language is the saved 中文 / EN choice (`baybay.lang`), else the browser's language (`zh…` → 中文,
anything else → English); it never follows the request text.

## 2. Architecture

```
Visitor (web UI or @BAYBAY in the Band room)
   │ request
   ▼
┌──────────────── Band room (the ONLY channel between agents) ─────────────────┐
│ BAYBAY ──@Scout──▶ Scout ──@Planner──▶ Planner ──@Checker──▶ Checker          │
│    ▲                                       ▲                    │             │
│    └──────────────@BAYBAY (verdict)────────┼────────────────────┘             │
│                                            └──@Planner (fix these, ≤3 drafts)─┘
└───────────────────────────────────────────────────────────────────────────────┘
 Scout / Planner / Checker ──Cypher──▶ Neo4j Aura (1,577 nodes · 2,894 rels), or the same queries on the local copy
 Scout / Planner / Checker ──chat────▶ Crusoe Managed Inference (one open model each), or rule-based fallbacks
 server (SSE, per browser) ──▶ web UI: plan card · Band trace · graph · dashboard · Cypher log
```

### 2.1 The agents (`src/agents.mjs`)

| agent | trigger (a Band message to it) | does | sends |
|---|---|---|---|
| **BAYBAY** (host) | the UI's request (the server calls `ask()`), or an `@BAYBAY …` message in the room from anyone who is not one of the four agents; later the Checker's verdict (only from Checker) | starts a run; delivers the final plan: a `plan` event to the UI and a readable summary as a room event (`task`): the title, one line per stop `HH:MM name (FREE) — why`, the verdict | `@Scout` + payload `{runId, request: {text, lang, date}}` |
| **Scout** | `@Scout` from BAYBAY | Crusoe (DeepSeek-V4-Flash) turns the text into filters; the prompt asks for `{freeOnly, family, keywords[], interests, pace}` but only `freeOnly`, `family` and `keywords` (≤ 6) are used (`interests` only shows in a thought, `pace` is dropped). When the date is after the last event in the graph it posts a thought saying so, and when the text names another date (`M/D` or `YYYY-MM-DD`) than the one picked it points that out (the web run keeps the picked date). Runs `findEvents` (widens if < 3 hits: drop keywords — the thought then lists the coming dates with keyword events, from `findEventDates` — then drop free-only), `findOffers` (keeps the offers tied to a neighbourhood, so not the citywide free-Muni pass, and on a free day only free ones), `findPlacesNamed` (≤ 3 places whose whole English or Chinese name is a keyword, e.g. "golden gate park" / "金门公园"; a kind word such as "museum" is never looked up), `findPlaces` in ≤ 5 neighbourhoods: those of the named places (≤ 2), of the events (on a free day the free ones first, the paid backups last) and of the offers (a free day or an outdoor / park request skips museums unless nothing else is there); trims to ≤ 10 events / 5 offers / 6 places (named places first), each with its nearest station id, station name and line (in Chinese for a zh request when the graph has one: "市政中心站", "M 线"); an offer also carries `hours` when its terms name free hours (the Tea Garden: "09:00–10:00") and `needs` ('child' or 'eligibility') when it is not for everyone; emits the candidates' subgraph | `@Planner` + payload `{runId, request, filters, candidates}` |
| **Planner** | `@Planner` from Scout (round 1) or Checker (round n) | Crusoe (DeepSeek-V4-Pro) picks stops by candidate id (falls back to an exact name match; anything else keeps no id and the Checker sends it back), in time order, with a "why"; times are normalised to `HH:MM`. For **any two consecutive stops** that both carry a station id (events, offers and places all do when a station is within 700 m), `route()` = `shortestPath` over `NEXT` gives a transit hint "N stops from A to B". The hint is given only when every station on the path is on one line (the path never silently changes lines where two share track); otherwise the stop keeps "near <station> (<line>)". The prompt also asks it to keep each offer inside its `hours` and to use an offer with `needs` only when the visitor meets it. A reply whose `stops` is not a list with at least one stop object (a wrapper object, a string) counts as unparseable and the rule-based plan stands in. The rule-based plan (no key, or a failed / unusable reply) takes ≤ 2 events (on a family day only the ones marked family-friendly, or a daytime food / outdoors event such as the farmers market — never an evening meetup or a conference), 1 offer (inside its free hours; "with a child" only on a family day; never one that needs residency or a benefits card) and places. On a revision it gets its previous draft, the issues, and the ids that failed the graph check (never to be used again) | `@Checker` + payload `{runId, request, candidates, filters, plan, round, vetoes, rejected}` |
| **Checker** | `@Checker` from Planner | **graph checks** (authoritative), each stop re-read from the graph by id: **events** (`getEvent`) — happen on the date (`dates[]` or start/end), in San Francisco, not 18+ (`adultsOnly` or `minAge ≥ 18`) when `family`, free when `freeOnly`, and the stop's time inside the event's hours when its date label gives one time or one span; **offers** (`getOffer`) — valid from / to, on that weekday, free when `freeOnly`, not "with a child" unless `family`, and the stop's time inside the free hours the terms name (`HH:MM–HH:MM` in `requirementEn`); **places** (`getPlace`) — exist in the graph (no price in the graph: on a free day tagged "price not in the graph", never passed as free); no duplicates; every time readable, times in order (compared as minutes). A stop is "✓ verified" only when all its checks pass: a repeat, or an event / offer outside its hours, is not ✓ (but its id is not rejected: it may fit at another time). Free-text `why` / `notes` are not checked. **Model review** (Crusoe Gemma 4 31B, a different model): judges fit (pace, travel, constraints); on round 1 it may return up to 2 `fixes`, which veto the draft; later it only writes the verdict (told the plan can no longer change) | issues or fixes and round < 3 → `@Planner` "Round n rejected, please fix: …" (the **veto**) · else `@BAYBAY` "Approved ✓ (round n)" or "Still N issue(s) after n rounds" with the plan and `checker` |

`MAX_ROUNDS = 3`: up to 3 drafts, at most 2 vetoes. Each veto is carried forward in the payload as
`vetoes: [{round, issues, suggestions, draft}]`. The Checker's payload to BAYBAY carries
`checker = {approved, issues (open issues, [] when approved), fixed (every graph issue of earlier vetoes that is no longer
raised, in order, deduped), suggested / notApplied (the review's pace / fit suggestions, by whether the next draft changed),
rounds, review}`. The plan card shows "Caught and fixed along the way" from `fixed` when approved, "Still open" from
`issues` when not, and the review's suggestions apart (never as fixed: nothing re-checks them).

The whole state of a run travels in the Band messages (a human line + a fenced JSON payload), so the room is the source of
truth. Each agent checks the sender of a step: Scout acts only on BAYBAY, Planner on Scout or Checker, Checker on
Planner, and BAYBAY takes a plan only from Checker. Room events: Scout posts `thought`, `tool_call`, `tool_result`; Planner
a `thought` on revision rounds (its `route()` calls are not posted); Checker `tool_result` + `thought`; BAYBAY `task` (the
summary). Crusoe / Neo4j failure notices go to the UI only. Trace texts say "Neo4j" only when Aura answered every query of
that step, "partly the local copy of the graph" when some fell back, else "the local copy of the graph" (zh: 本地图谱副本);
Scout's tool call reads `neo4j.findEvents(…)` or `localGraph.findEvents(…)`. LLM settings: temperature 0.3; max_tokens
Scout 1,400 · Planner 5,000 · Checker 1,500.

### 2.2 Band transport (`src/room.mjs`)

- REST only (`@band-ai/rest-client`, `BandClient`), one client per agent (each agent's own API key).
- On start: `getAgentMe()` for each agent (id / name / handle); use `BAND_ROOM_ID` or BAYBAY creates a room
  (`createAgentChat`) and adds the other three (`addAgentChatParticipant`).
- Each agent polls `getAgentNextMessage(room)` every `BAND_POLL_MS` (800 ms) → `markAgentMessageProcessing` → handler →
  `markAgentMessageProcessed`; when the handler throws: `markAgentMessageFailed` once and an `error` event carrying the
  payload's `runId`. Messages from itself are ignored. A message id delivered again is handled once (a bounded set of
  500 seen ids per agent; a repeat is only marked processed).
- A sender counts as an agent only by its Band id (one of the four); anyone else in the room is `User`, whatever their
  display name — so the host's display name in Band can be anything.
- Send = `createAgentChatMessage(room, {message: {content, mentions: [{id, name, handle}]}})`; events =
  `createAgentChatEvent(room, {event: {content, message_type}})`. `encode()` always appends the payload as the last
  fenced `json` block (backticks inside escaped); `decode()` reads the last one.
- **Delete test:** agents act only on what Band delivers, so deleting the room stops the crew.
- Fallback `LocalRoom` (same API and the same delivery rules, in-process) when any of the 8 values (4 `*_AGENT_ID` +
  4 `*_API_KEY`) is missing, or when `BandRoom.start()` throws — labelled "local" in the UI either way.
- Without `BAND_ROOM_ID` every restart creates a new room (not saved, and the human is not added): set it.
- For the browser, `info()` gives a short room id (first 8 characters + "…"), each agent's name, role and whether its last
  poll worked — no agent ids.
- Runs started by a human `@BAYBAY …` in Band get a `band-…` run id, the language of the text (Chinese characters → zh)
  and the date in the text (`YYYY-MM-DD`, or `M/D` in 2026), else the coming Saturday. Their events go to every UI
  stream, but the web UI shows only the run it started itself; the human in Band reads the plan in BAYBAY's summary event.

### 2.3 Crusoe (`src/llm.mjs`, `src/config.mjs`)

- OpenAI-compatible: `new OpenAI({ baseURL: 'https://api.inference.crusoecloud.com/v1', apiKey, maxRetries: 0,
  timeout: 60_000 })`.
- One model per agent (env-overridable): Scout `deepseek-ai/Deepseek-V4-Flash`, Planner `deepseek-ai/DeepSeek-V4-Pro`,
  Checker `google/gemma-4-31b-it`. Model IDs are **case-sensitive and must match `/v1/models`** (docs differ).
  `CRUSOE_MODEL` (default `deepseek-ai/Deepseek-V4-Flash`) is only a fallback that no agent uses (each agent's model has
  its own default); `npm run check` tests it when it names another model.
- `chat()` makes up to 3 attempts on 429 / 5xx / network errors / timeouts (waits 1.2 s, then 2.4 s), strips
  `<think>…</think>` and extracts the JSON: the last fenced block that parses, else the whole text, else the first `{…}`
  that opens at the top level (a broken outer object is skipped whole, never mined for an object inside it).
  Every call emits `{provider, model, ms, tokens}` to the UI. `provider` is "Crusoe" only when the reply was used; a failed
  call is "Crusoe (failed → fallback)", a reply without usable JSON (for the Planner also one without a usable `stops` list) "Crusoe (unparseable → fallback)", no key
  "fallback (no Crusoe key)"; each of these steps uses the rule-based fallback, and a failed or unparseable call also posts
  a notice in the trace. The stats strip counts "Crusoe calls" and "rule-based steps" apart.
- `/api/status`: Crusoe is ok only when the key is set, the model list loads and all three agents' models are in it (else
  error "model list pending" while the first listing is out, "model list failed" or "not served: <ids>"); the list is
  fetched at start and again at most once a minute while it is not ok. The browser gets the short model names and each
  agent's model id, not the full list.
- Benchmarks on 2026-09-29 (same JSON-extraction prompt): DeepSeek-V4-Flash 0.6 s, DeepSeek-V4-Pro 0.8 s, Qwen3.8-27B 0.8 s
  (reasoning), Gemma 4 1.1 s, GLM-5.3 1.9 s, Kimi-K2.6 2.8 s (reasoning; a full plan took ~45 s / ~6k tokens, so no agent
  uses it; Crusoe has since stopped serving it), gpt-oss-120b 4.4 s, Nemotron-3.5-Lightning returned empty content at 600
  max tokens (all spent reasoning).

### 2.4 Neo4j (`src/graph.mjs`, `src/load-neo4j.mjs`, `data/graph.json`)

**Model** (every node also has label `:Entity` and unique `key = "<Label>:<id>"`):

```
(:Event)-[:AT]->(:Venue)-[:IN]->(:Neighborhood)-[:IN_CITY]->(:City)
(:Place|:Station|:Offer)-[:IN]->(:Neighborhood)        IN = Place 917 · Station 145 · Venue 18 · Offer 1
(:Venue|:Place|:Offer)-[:NEAR {meters}]->(:Station)-[:ON_LINE {order}]->(:Line)
(:Station)-[:NEXT {line}]->(:Station)     (:Event)-[:OF_CATEGORY]->(:Category)
(:Event)-[:IN_CITY]->(:City)   (:Offer)-[:AT]->(:Place)   (:Venue)-[:IS_PLACE]->(:Place)   (:Opening)-[:IN_CITY]->(:City)
```

Opening and Category nodes are loaded but no agent or dashboard query uses them (Category only appears in the picture).

**Counts** (`data/graph.json`, snapshot of 2026-09-29): Event 267 · Place 957 · Station 145 · Neighborhood 72 · City 64 ·
Opening 31 · Venue 18 · Offer 13 · Line 6 · Category 4 (1,577 nodes); IN 1,081 · NEAR 819 · IN_CITY 370 ·
OF_CATEGORY 267 · ON_LINE 168 · NEXT 155 · AT 49 · IS_PLACE 6 (2,915 rows in the JSON; 21 repeat a pair already linked by
the same type — 14 `NEXT` rows on track two lines share, 7 `ON_LINE` rows where the F line lists a stop twice in a row — so
`MERGE` leaves 2,894 in Aura: ON_LINE 161 · NEXT 141). The status pill and `stats()` count 2,894 too. Lines: the
Powell–Hyde, Powell–Mason and California cable cars, the F Market & Wharves streetcar, Muni N Judah and M Ocean View. `NEXT` has 4 connected parts (the two Powell lines share track, as do N and M) and no
transfer edges.

**Event properties:** title / titleEn, startDate, endDate, `dates[]` (occurrences), dateLabel(En), category, cost,
costLabel, admissionUsd, `free`, `minAge`, `adultsOnly`, `familyFriendly`, reservation, setting, summary(En), audience,
venueText, city, url (official), baylink (`https://www.baylink.us/events/<id>`), verifiedAt.

**Queries (all parameterized, READ routing):**
- `events` — SF events on `$date` with `$freeOnly`, `$family` (not adults-only), `$keywords` (matched in title, titleEn,
  summary, summaryEn and audience), joined to venue → neighbourhood → the nearest 2 stations, each with its first line;
  ordered free first, family-friendly first, with a venue first, then start date and id; LIMIT 14.
- `offers` — offers valid on `$date` and `$weekday`, with place / neighbourhood and the nearest station (of the place, else
  of the offer; its English and Chinese names, as for places); ordered date-specific first, then free, then "for everyone", then id; LIMIT 10.
- `places` — places of 10 kinds in `$hoodIds` with the nearest station; ordered guide-linked first, then the neighbourhood's
  order in `$hoodIds`, then the kind's order (generic "attraction" last), then id; LIMIT 10.
- `namedPlaces` — ≤ 3 places of the given kinds whose whole English or Chinese name is a keyword (case-insensitive);
  guide-linked first, then id.
- `eventDates` — when the SF events matching the keywords (and `$freeOnly` / `$family`) run, one span per event or
  listed date, ending on or after `$from` (today); LIMIT 8.
- `route` — `shortestPath((a:Station)-[:NEXT*..60]-(b:Station))` → stops and `stopsZh` (both platforms of one stop count
  once), lines, hops, and `common`: the lines every station on the path is on (empty when it changes lines).
- `event` / `offer` / `place` — re-read one node for the Checker (`getEvent`, `getOffer`, `getPlace`).
- **Dashboard** (3 graph questions): free events by neighbourhood · stations with the most attractions within 700 m ·
  family-friendly events reachable on each line. The dated panels count events from today on; once today is past the
  last event they count from the snapshot date and say so.
- `subgraph(keys)` builds the vis-network picture (2 hops over AT / IN / NEAR / ON_LINE / IS_PLACE / OF_CATEGORY) of
  **Scout's candidates** (the chosen stops are not redrawn); the picture, the overview and the graph walks are always built
  from `data/graph.json` in memory, not from Aura.

**Which engine answered:** without `NEO4J_URI` / `NEO4J_PASSWORD` every tool answers the same question from
`data/graph.json` in memory (both engines use the same fields and the same order, ties broken by id). Every `cypher` event
carries `engine` = `Neo4j Aura` | `local graph (Neo4j not configured)` | `local graph (Neo4j query failed)` |
`local graph (Neo4j unavailable)` — the one that actually answered — and the Cypher log shows it per query. The dashboard
says Neo4j only when all three panels came from Aura.

**When Aura is down:** the driver uses short timeouts (connection 5 s, acquisition 6 s, transaction retries 2 s). After a
failed Aura query (other than a Cypher error) a circuit breaker answers locally for the next 60 s without trying Aura, so
a paused or deleted instance does not stall a run; `neo4jStats()` returns an error at once while it is open. The pill is
green only when Aura answers and holds as many `:Entity` nodes as `data/graph.json` (else "run npm run load").

**Loader:** `npm run load` — constraint on `:Entity(key)`, an index per label, deletes every `:Entity` node, then batched
`UNWIND … MERGE` (500 nodes / 1,000 rels per batch) and prints the counts. Nodes without `:Entity` are left alone, but it
stops when any of them is linked to an `:Entity` node: use a dedicated, empty database. Idempotent.

**Where the data comes from** (`scripts/export-from-baylink.mts`, run with the `tsx` of a BAYLINK checkout that has its
dependencies installed; the checkout is `BAYLINK_DIR`, else the first argument, else the current directory; it writes
`../data/graph.json` next to the script):

```bash
BAYLINK_DIR=../baylink-web node ../baylink-web/node_modules/tsx/dist/cli.mjs scripts/export-from-baylink.mts
```

`public/planner-catalog.json` (267 events, verified 2026-09-28/29; exported 2026-09-29), `public/opus-bay/sf/v1/places.json`
(OpenStreetMap places incl. 72 neighbourhoods), `public/opus-bay/sf/v1/transit.json` + `transit-w4.json` (lines with an
OpenStreetMap route relation only: the 3D game's sightseeing loop is skipped), `public/opus-bay/sf/v1/live.json`
(verified free / reduced offers), `src/opus-bay/realsf/eventVenues.ts` (OSM-checked venue points),
`src/data/autumn-release-openings.json`. Neighbourhood = nearest OSM neighbourhood centroid within 2.5 km; NEAR = the 2
nearest stations within 700 m; English text through the site's translation layer; ad-click tracking parameters are
stripped from links. The committed `data/graph.json` is the 2026-09-29 export with the sightseeing loop removed (NEAR
recomputed) and the links cleaned (one dead link dropped); a re-export pulls BAYLINK's catalog as it is that day, so
every count changes. Data terms: `data/README.md`.

### 2.5 Server and UI (`src/server.mjs`, `public/index.html`)

- Plain `node:http` on `HOST` (127.0.0.1) and `PORT` (8787). Logs unhandled rejections instead of exiting. The startup log
  prints the three per-agent models (or "not configured → rule-based fallback"), the Neo4j mode and the Band mode.
- Only known `Host` headers are answered (localhost / 127.0.0.1 / ::1 and `HOST`; for a non-loopback `HOST` also the
  machine's name, for 0.0.0.0 / :: its LAN addresses; plus `ALLOWED_HOSTS`); any other gets 403.
- API:
  - `GET /api/status` → `{crusoe: {ok, model (short per-agent names joined " · ", or "not configured (rule-based
    fallback)"), perAgent, error?}, neo4j: {ok, mode 'neo4j'|'local', nodes, rels, labels, error?}, band: {mode
    'band'|'local', room (short id or null), agents: [{name, role, ok}], ok}, data: {snapshot, firstEvent, lastEvent}}`.
  - `POST /api/ask {text, lang, date, client}` → `{runId, date}`. Same origin only (403), `Content-Type: application/json`
    (415), body ≤ 100 KB (413), text cut to 500 chars (empty → 400), at most 3 runs at a time (429 "busy"; a run counts
    until its `done` / `error`, at most 5 minutes). `date` must be a real calendar date, else the coming Saturday in Los
    Angeles (today on a Saturday); `lang` `en` else `zh`. `runId` = `run-<Date.now() base36>-<4 random base36 chars>`.
  - `GET /api/stream?client=<id>` (SSE: `run`, `room`, `llm`, `cypher`, `graph`, `plan`, `status` (first, once per
    stream), `error`, `done`; ping every 15 s). The server remembers which client asked for each run: a run's events go
    only to that client's streams; `band-…` runs and events without a run id go to every stream.
  - `GET /api/graph/overview` · `GET /api/dashboard` (`{engine, asOf, queries}`) · static files from `public/` (incl.
    `/demo/slides.html#title|arch|end`), with content types for html / js / css / json / images / mp4 / srt, `nosniff`, and `X-Frame-Options: DENY` + CSP
    `frame-ancestors 'none'` (no other site can frame the page and click its buttons).
- UI (one file, vanilla JS + vis-network 10.1.2 from unpkg, pinned with an integrity hash): the browser makes a client id
  (`crypto.randomUUID()`, else a random fallback) for the stream and every ask; top bar with three live status pills
  (re-polled every 30 s) and 中文 / EN; left = ask box (date picker defaulting to the coming Saturday, today on a Saturday;
  Ctrl+Enter; the after-the-data notice), 4 example chips (the Halloween chip sets Oct 31, next year's once it has passed),
  the plan card; middle = Band room trace (agent colours, @chips, a badge per model call with its provider, thinking
  indicator, stats strip); right = Graph (Overview / Fit) / Dashboard / Cypher log (last 100, engine per query, unseen
  counter). 300 s safety timeout per run; an `error` event without a run id is a small notice and never ends a run. CSS
  breakpoints at 1100 px and 560 px. Offline, the graph tab gives up after 20 s (vis-network comes from unpkg).

## 3. Run it

Node 22 or later (`engines` in `package.json`; developed on Node 24).

```bash
npm install
cp .env.example .env    # PowerShell: Copy-Item .env.example .env
npm run check           # Crusoe (each agent's model answers; CRUSOE_MODEL only warns), Neo4j (connects, node count), Band (each agent + the room)
npm run load            # load data/graph.json into Neo4j (a dedicated, empty database)
npm start               # http://localhost:8787
```

Without keys it still runs end to end (local graph, in-process room, rule-based reasoning), clearly labelled; `check` and
`load` need keys (`check` exits with 1 when a line is ❌). Env (see `.env.example`; a blank value means the default):
`CRUSOE_API_KEY`, `CRUSOE_BASE_URL`, `CRUSOE_SCOUT_MODEL` / `CRUSOE_PLANNER_MODEL` / `CRUSOE_CHECKER_MODEL`, `CRUSOE_MODEL`
(only a fallback, default `deepseek-ai/Deepseek-V4-Flash`); `NEO4J_URI`, `NEO4J_USERNAME` (the user name in Aura's
credentials file — for newer instances the instance id; default `neo4j`), `NEO4J_PASSWORD`, `NEO4J_DATABASE` (optional);
`BAYBAY_ / SCOUT_ / PLANNER_ / CHECKER_AGENT_ID` and `_API_KEY`, `BAND_ROOM_ID`, `BAND_POLL_MS` (800); `HOST` (127.0.0.1;
0.0.0.0 serves the network too, with no auth), `PORT` (8787), `ALLOWED_HOSTS` (more Host names, comma-separated).
Band setup: create 4 External agents (BAYBAY / Scout / Planner / Checker; any display names), copy each Agent UUID + API
key; create a Session with all four (and yourself) and put its id in `BAND_ROOM_ID` so you can watch the run in Band.

## 4. Demo assets (`demo/`)

- `baybay-crew-walkthrough.mp4` (2:50, narrated, English subtitles burned in; `.en.srt` beside it): problem → stack →
  live run with a Checker veto → result + dashboard → the Band room (veto, then approval) → the code → close.
- `baybay-crew-demo.mp4` (1:46): the short cut. `screenshot.png`, `band-room.jpg`.
- Both videos and the images were made on 2026-09-29 with the judged version. They still show the sightseeing loop that
  was later removed from the graph (one transit tag and the 1,594 nodes / 3,053 rels counts), the Checker's old
  final-round wording and some old UI labels.
- Narration was generated with Higgsfield (Seed Audio, voice "Ainsley"); the videos were assembled with ffmpeg.
- `record.mjs`: records the slides (PNG) and a real run with headless Chrome over CDP (`Page.startScreencast`: JPEG frames
  + `timeline.json` + `final.png`); the videos were then cut with ffmpeg outside the repo. Usage:
  `node demo/record.mjs [--out=DIR] [--clean] [--chrome=PATH] [--base=URL] [--request=TEXT] [--date=YYYY-MM-DD]` (or
  `RECORD_OUT`, `CHROME_PATH`, `BASE_URL`, `RECORD_REQUEST`, `RECORD_DATE`), with the server already running. The default
  output `demo/out/` (git-ignored) is emptied first; another folder only with `--clean`.
- `slides.html` (title / architecture / end; arrow keys, Space, clicks; scaled to the window; also served at
  `/demo/slides.html`).

## 5. Result

**Winner — Best Use of Neo4j.**

Winners: Crusoe overall 1st Thermal Crusoe, 2nd Safe Scribe, 3rd Deja · **Neo4j Best Use: BAYBAY Crew** · Neo4j Best
Technical: CertAIn · Neo4j Most Creative: LineSignal · DuploCloud Best Agent: Harmony · Plaud: SiteSync · Vultr: SYNTH.

## 6. Known gaps (honest)

- Local only: no deploy, no auth; the only rate limit is 3 runs at a time; ~15–35 s per plan with Crusoe; results vary
  run to run.
- Pipeline with fixed roles + one feedback loop; no runtime recruitment; a human in the room can only start a run;
  Band messages carry wide JSON blocks; polling (800 ms), not websockets.
- Cypher is basic: no GDS algorithms, no vector index / GraphRAG, no text-to-Cypher (fixed, parameterized queries).
- **The data runs out:** a snapshot of 2026-09-29; San Francisco events only from 2026-09-26 to 2026-10-31 (3–6 per
  Saturday). For later dates the UI and the Scout say so and plans use offers and places only, until the graph is
  re-exported (which changes every count).
- Data coverage: only 18 SF venues with coordinates (38 of 59 SF events placed; 21 have a station within 700 m), a few
  candidates per day; no opening hours, no travel times, no prices for places; transit is 6 rail / cable-car lines (no
  buses, no BART) with no transfers between lines. Known data quirks: 4 neighbourhood names appear twice (an OSM point and
  an area), most places (878 of 957) have no Chinese name, and `familyFriendly` is a keyword guess (no minimum age and a
  family word in the text). Opening and Category nodes are unused.
- The Checker verifies facts, not experience: opening hours of places (and of offers beyond the free hours their terms
  name), whether the visitor holds an offer's residency or benefits card, walking distance, travel time, events with
  several times in their label and the free-text tips are not checked (the review model judges pace and fit).
- `familyFriendly` (and the category) decide the rule-based plan on a family day, so a kid-friendly event the graph does
  not mark (a street fair, a book fair) is left out there; the Crusoe Planner sees the flags and judges.
- No tests, no eval set.
- The web UI shows only the runs it started; a run started in the Band room is visible in Band only.

### 6.1 Fixed since the hackathon

1. `nextSaturday()` computes the Los Angeles calendar date (today on a Saturday) instead of a local-time
   `toISOString()`; the server accepts only real calendar dates; a Band-started run uses the date in its text.
2. Model calls are labelled by what was used: a failed or unparseable Crusoe reply is labelled as a fallback, never as
   Crusoe.
3. Transit hints between any two consecutive stops with a station (not only events); the made-up sightseeing loop is gone
   from the graph.
4. Checker: places are re-read from the graph; events are checked for the city and the hours; offers for their weekday;
   free counts toward the ✓; times are compared as minutes; every earlier veto's issues are listed as fixed or still open.
5. Engines: every query says which engine answered; the trace says "Neo4j" only when Aura answered; short Neo4j timeouts
   and a 60 s circuit breaker; the status pill is green only when Aura holds the full graph; the loader leaves other
   nodes alone.
6. Server: listens on 127.0.0.1 by default; Host check; same-origin JSON requests only; a cap of 3 runs; SSE per browser
   (no other visitor's request text); an error without a run id no longer ends runs; `/api/status` has no agent ids and a
   short room id; content types for `.webp` / `.jpg` / `.mp4`; bodies over 100 KB get 413; vis-network pinned with an
   integrity hash.
7. Band: a sender is an agent only by its id, each step checks its sender, repeated message ids are handled once, and
   BAYBAY posts the delivered plan as a readable summary.
8. UI language follows the browser; a notice for dates after the data; the exporter takes `BAYLINK_DIR`; the recorder takes
   options instead of fixed paths; the unused `@band-ai/sdk` dependency is gone; a stale comment on the round limit and the
   dead default neighbourhood are gone.
9. Final pre-share review: a broken model reply is never mined for one stop (it falls back to the rule-based plan, as does
   a reply without a stops list); a repeat or a stop outside its hours is never ✓; offers carry and respect their free
   hours and "with a child" terms; kids' rule-based plans skip events not marked family-friendly (except daytime food /
   outdoors ones); places the request names ("Golden Gate Park") are candidates; transit hints never change lines
   silently; Chinese station and line names in zh plans; a date or keyword the request names but the picked date lacks is
   pointed out; the page refuses to be framed.

## 7. What to build next (suggested order)

1. **Deploy** (Render / Vultr) with a public URL, auth or a request limit and a cost guard; keep `.env` secrets in the host.
2. **Data:** all Bay Area venues with coordinates; opening hours; GTFS (Muni + BART) as `(:Stop)-[:NEXT {minutes}]->`
   with transfers for real travel times; refresh from BAYLINK's catalog automatically.
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
| `src/graph.mjs` | Cypher tools, local engine, engine labels / breaker, subgraph, dashboard, data range |
| `src/llm.mjs` · `src/config.mjs` | Crusoe client, per-agent models, env |
| `src/server.mjs` · `src/bus.mjs` | HTTP + SSE (per-browser streams), event bus |
| `src/load-neo4j.mjs` · `src/check.mjs` | Aura loader, service checks |
| `public/index.html` | the UI |
| `data/graph.json` · `data/README.md` | the exported graph (≈ 940 KB) and its sources and terms |
| `scripts/export-from-baylink.mts` | the exporter (needs a BAYLINK checkout) |
| `demo/` · `public/demo/` | videos, screenshots, recorder, slides (+ a served copy with `key.webp`) |
| `README.md` · `LICENSE` · `.env.example` · `package.json` | overview, MIT license (code), env template, scripts (`start`, `check`, `load`) |

The code is MIT-licensed. Data © BAYLINK (catalog) and © OpenStreetMap contributors (places, venues, neighbourhoods,
transit; ODbL 1.0) — see `data/README.md`.
