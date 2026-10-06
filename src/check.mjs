import { readFileSync } from 'node:fs';
import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { BandClient } from '@band-ai/rest-client';
import { bandOn, config, crusoeOn, neo4jOn } from './config.mjs';

/** npm run check — one line per sponsor: is the key there, does the service answer. Exits with 1 when any line is ❌. */
let failed = 0;
const line = (name, ok, msg) => { if (!ok) failed++; console.log(`${ok === 'warn' ? '⚠️ ' : ok ? '✅' : '❌'} ${name.padEnd(8)} ${msg}`); };

if (!crusoeOn()) line('Crusoe', false, 'CRUSOE_API_KEY missing in .env');
else {
  const c = new OpenAI({ apiKey: config.crusoe.apiKey, baseURL: config.crusoe.baseUrl, maxRetries: 0, timeout: 60_000 });
  let models = null;
  try { models = (await c.models.list()).data.map(m => m.id); line('Crusoe', true, `${models.length} models served`); }
  catch (e) { line('Crusoe', false, `model list: ${e.message}`); }
  // a tiny chat with each agent's model (and with CRUSOE_MODEL when it is set to another one)
  const extra = (process.env.CRUSOE_MODEL ?? '').trim();
  const tests = [...Object.entries(config.crusoe.models), ...(extra && !Object.values(config.crusoe.models).includes(extra) ? [['CRUSOE_MODEL', extra]] : [])];
  for (const [who, model] of tests) {
    const note = !models || models.includes(model) ? '' : ' — NOTE: not in /v1/models (model ids are case-sensitive)';
    try {
      const t0 = Date.now();
      const r = await c.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say hi in 3 words.' }], max_tokens: 20 });
      line('Crusoe', true, `${who}: ${model} answered in ${Date.now() - t0} ms: "${(r.choices?.[0]?.message?.content ?? '').trim().slice(0, 40)}"${note}`);
    } catch (e) {
      // CRUSOE_MODEL is only a fallback that no agent uses, so it warns instead of failing the check
      const fb = who === 'CRUSOE_MODEL';
      line('Crusoe', fb ? 'warn' : false, `${who}: ${model} — ${e.message}${note}${fb ? ' (only a fallback, no agent uses it: set it to one of the models above or leave it blank)' : ''}`);
    }
  }
}

if (!neo4jOn()) line('Neo4j', false, 'NEO4J_URI / NEO4J_PASSWORD missing in .env');
else {
  const d = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), { connectionTimeout: 5000, maxTransactionRetryTime: 2000 });
  try {
    await d.verifyConnectivity();
    const r = await d.executeQuery('MATCH (n:Entity) RETURN count(n) AS n', {}, { database: config.neo4j.database || undefined });
    const n = Number(r.records[0].get('n'));
    const want = JSON.parse(readFileSync(new URL('../data/graph.json', import.meta.url), 'utf8')).nodes.length;
    line('Neo4j', n === want || 'warn', `connected · ${n} nodes${n === want ? '' : ` — data/graph.json has ${want}: run \`npm run load\` to load the BAYLINK graph`}`);
  } catch (e) { line('Neo4j', false, e.message); } finally { await d.close(); }
}

if (!bandOn()) line('Band', false, 'the four *_AGENT_ID / *_API_KEY pairs are not all in .env (BAYBAY, SCOUT, PLANNER, CHECKER)');
else {
  for (const [name, a] of Object.entries(config.band.agents)) {
    try {
      const me = await new BandClient({ apiKey: a.key }).agentApiIdentity.getAgentMe();
      const d = me?.data ?? me;
      line('Band', true, `${name}: ${d?.name ?? '?'} (${d?.id ?? '?'})${d?.id && d.id !== a.id ? ` — NOTE: .env says ${a.id}` : ''}`);
    } catch (e) { line('Band', false, `${name}: ${e?.statusCode ?? ''} ${e.message}`); }
  }
  if (config.band.roomId) {
    try {
      const p = await new BandClient({ apiKey: config.band.agents.BAYBAY.key }).agentApiParticipants.listAgentChatParticipants(config.band.roomId);
      const list = (p?.data ?? p ?? []).map(x => x.name ?? x.id);
      line('Band', true, `room ${config.band.roomId}: ${list.join(', ')}`);
    } catch (e) { line('Band', false, `room ${config.band.roomId}: ${e?.statusCode ?? ''} ${e.message}`); }
  } else line('Band', true, 'no BAND_ROOM_ID: BAYBAY will create a room at start and add the other three');
}

if (failed) {
  console.log('\n(Without keys `npm start` still runs end to end: local graph, local room, rule-based reasoning.)');
  process.exitCode = 1;
}
