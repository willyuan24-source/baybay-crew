# BAYBAY Crew — submission kit

## One-liner
Four agents coordinate in a **Band** room to plan a real San Francisco day from a **Neo4j** knowledge graph of verified
local events, reasoning with open models on **Crusoe** — and a Checker agent re-verifies every stop against the graph
before a human ever sees the plan.

## Short description (≈100 words)
Travel chatbots invent events and get dates wrong. BAYBAY Crew splits the job: Scout turns a request ("a free Saturday
with kids, reachable by Muni") into Cypher over a Neo4j graph built from BAYLINK's real Bay Area catalog (267 dated events,
72 neighbourhoods, 161 transit stations, free-admission offers); Planner builds a time-ordered day only from those
candidates, with transit from graph shortest paths; Checker re-reads every stop from the graph (date, free, age limits)
and bounces the plan back until it is right. All handoffs are Band messages with @mentions; every LLM step runs on
Crusoe Managed Inference. Bilingual (中文 / English).

## How each sponsor is used (for judges)
- **Crusoe** — every reasoning step (Scout's filters, Planner's itinerary, Checker's review) calls Crusoe Managed
  Inference (OpenAI-compatible) with open-weight models; the Checker can use a different model than the Planner. The UI
  shows "⚡ Crusoe · <model> · <latency>" on every call; the top bar shows the model.
- **Neo4j** — the single source of truth: 1,594 nodes / 3,074 relationships loaded into AuraDB. Scout's candidates,
  Planner's transit (`shortestPath` over `NEXT`) and Checker's verification are Cypher; the UI shows each query, the
  plan's subgraph (vis-network) and a dashboard of three graph questions.
- **Band** — the coordination layer: four registered external agents in one room; each handoff is a message with an
  @mention carrying the state (request → candidates → draft → issues → verdict); tool calls, results and thoughts are room
  events; agents act only on delivered messages (processing → processed). Delete test: delete the room → the crew stops.

## 2-minute demo script
1. (0:00) Top bar: Crusoe model ●, Neo4j nodes / rels ●, Band room ●. "Four agents, one Band room, one graph."
2. (0:10) Click the chip "这周六带小孩，免费、坐公交能到" (or type in English). Show the Band app side by side: the same
   messages appear in the Band session live.
3. (0:25) Scout: the filters thought, the Cypher in the Neo4j log, the graph lights up with the candidates' venues,
   neighbourhoods and stations.
4. (0:45) Planner: the draft, "⚡ Crusoe · Kimi K2.6 · 2.1 s".
5. (1:00) Checker: "graph check: all stops verified" — or, better, a rejection round (ask for a Halloween day on a date
   with few events, or for kids when a 21+ show is a candidate) → Planner fixes it → approved.
6. (1:20) The plan card: times, FREE pills, transit hints, ✓ verified, links to real BAYLINK pages (click one).
7. (1:35) Dashboard tab: three Cypher questions (free events by neighbourhood, transit hubs, family events per line).
8. (1:50) Delete test (optional): delete the Band room / stop a Band agent → the next request stalls in the trace.
   "Band is the coordination layer, not a log."

## Built on an existing project
BAYLINK (https://www.baylink.us) existed before the hackathon: its catalog and its 3D San Francisco (OpenStreetMap data)
are the data source. Everything in this repository — the graph export and model, the agents, the Band transport, the
Crusoe layer, the verification loop and the UI — was built during the hackathon.
