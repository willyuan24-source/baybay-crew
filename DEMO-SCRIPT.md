# Demo recording script (≈ 3 minutes)

Chrome tabs are already open in this order:
① slides (http://localhost:8787/demo/slides.html — → / ← keys switch title / architecture / end) ·
② the app (http://localhost:8787, English) · ③ the Band room (app.band.ai session) · ④ GitHub `src/agents.mjs` (the
Checker) · ⑤ GitHub `src/room.mjs` (the Band transport) · (the HackerSquad tab with the "Record Video Demo" button).

Share the whole screen (so you can switch tabs). Speak slowly; it is fine to read.

---

## 1 · The problem (≈ 25 s) — tab ① title slide

**EN:** "Hi, I'm Hao. Ask any AI chatbot to plan a day in San Francisco and it will happily invent events, get dates wrong,
or send a family with kids to a 21-plus show. We built BAYBAY Crew: four AI agents that plan a real day, where every stop
comes from verified data and is checked before you ever see it."

**中文意思：** 问任何聊天机器人"在旧金山怎么过一天"，它会编造活动、弄错日期，甚至把带孩子的家庭推荐去 21 岁以上的演出。
BAYBAY Crew 是四个 AI 智能体，每一站都来自真实数据，并在你看到之前核对过。

## 2 · The tech stack (≈ 40 s) — press → for the architecture slide

**EN:** "The four agents — BAYBAY the host, Scout, Planner and Checker — coordinate only through a **Band** room. Every
handoff is a Band message with an @mention, and the whole state travels in those messages, so if you delete the room,
the crew stops. Scout and Checker query a **Neo4j** knowledge graph built from my site BAYLINK: 1,594 nodes — real dated
events, venues, neighborhoods, free museum days and transit stations. And every reasoning step runs on open models on
**Crusoe**: DeepSeek V4 Flash for Scout, DeepSeek V4 Pro for Planner, and Gemma 4 for Checker, so a different model
reviews the plan. Without the graph the agents would guess; without Band there is no veto loop."

**中文意思：** 四个智能体只通过 Band 房间协作（删掉房间就停）；Scout 和 Checker 查 Neo4j 图谱（1,594 个节点的真实数据）；
每一步推理都跑在 Crusoe 的开源模型上，三个智能体用三个不同模型，Checker 用不同模型复核。

## 3 · Live demo + code (≈ 110 s)

**Tab ② the app.** Click the chip **"A free Saturday with kids, reachable by Muni"** (or type
*"A Saturday with my two kids (6 and 9): live music and something to eat. We take Muni, not too much walking."*),
then **Plan my day**. While it runs (≈ 30 s):

**EN:** "The top bar shows all three sponsors live: Crusoe models, Neo4j Aura with 1,594 nodes, and the Band room.
Scout turns my request into filters — you can see *Crusoe, DeepSeek Flash, under a second* — and runs Cypher on Neo4j;
the graph on the right lights up with the venues, neighborhoods and stations it found. Planner drafts the day.
Now Checker re-reads every stop from the graph and a different model judges the fit. If anything is off it **vetoes** the draft
and sends it back to Planner with concrete fixes (say *"here it vetoed round one"* if you see *Round 1 rejected*); then every stop is verified and approved."

When it is done: point at the **plan card** (FREE pills, transit hints, ✓ verified, click one link → a real BAYLINK page),
then the **Dashboard** tab ("three graph questions: free events by neighborhood, transit hubs, family events per line")
and the **Cypher log** tab ("every query the agents ran").

**Tab ③ the Band room** (scroll to the newest messages):
"And this is the same run inside Band: Scout @Planner, Planner @Checker, Checker rejecting round one @Planner — dependent
handoffs and a critic that can veto, with every tool call and thought posted as room events."

**Tab ④ GitHub `agents.mjs`** (Checker, lines 113–175):
"Here is the Checker: it re-queries every stop in Neo4j — the date, free or paid, minimum age — then asks a second
Crusoe model for the fit; if anything is wrong it sends the plan back through Band."

**Tab ⑤ GitHub `room.mjs`:**
"And the Band transport: each agent only acts on messages Band delivers to it — processing, processed — so Band really
is the coordination layer."

**Close (tab ① → end slide):** "BAYBAY Crew: Crusoe thinks, Neo4j remembers, Band coordinates. Thank you!"

---

Backup: if the live run is slow or fails, play `demo/baybay-crew-demo.mp4` (1:46, narrated) during step 3.
