import neo4j from 'neo4j-driver';
import OpenAI from 'openai';
import { BandClient } from '@band-ai/rest-client';
import { bandOn, config, crusoeOn, neo4jOn } from './config.mjs';

/** npm run check — one line per sponsor: is the key there, does the service answer. */
const line = (name, ok, msg) => console.log(`${ok ? '✅' : '❌'} ${name.padEnd(8)} ${msg}`);

if (!crusoeOn()) line('Crusoe', false, 'CRUSOE_API_KEY missing in .env');
else {
  try {
    const c = new OpenAI({ apiKey: config.crusoe.apiKey, baseURL: config.crusoe.baseUrl });
    const models = (await c.models.list()).data.map(m => m.id);
    const t0 = Date.now();
    const r = await c.chat.completions.create({ model: config.crusoe.model, messages: [{ role: 'user', content: 'Say hi in 3 words.' }], max_tokens: 20 });
    line('Crusoe', true, `${config.crusoe.model} answered in ${Date.now() - t0} ms: "${(r.choices[0].message.content ?? '').trim().slice(0, 40)}" · ${models.length} models${models.includes(config.crusoe.model) ? '' : ` (NOTE: ${config.crusoe.model} not in the list: ${models.slice(0, 8).join(', ')})`}`);
    if (config.crusoe.checkerModel && !models.includes(config.crusoe.checkerModel)) line('Crusoe', false, `CRUSOE_CHECKER_MODEL ${config.crusoe.checkerModel} not in the model list`);
  } catch (e) { line('Crusoe', false, `${e.status ?? ''} ${e.message}`); }
}

if (!neo4jOn()) line('Neo4j', false, 'NEO4J_URI / NEO4J_PASSWORD missing in .env');
else {
  const d = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password));
  try {
    await d.verifyConnectivity();
    const r = await d.executeQuery('MATCH (n:Entity) RETURN count(n) AS n', {}, { database: config.neo4j.database || undefined });
    const n = Number(r.records[0].get('n'));
    line('Neo4j', true, `connected · ${n} nodes${n ? '' : ' — run `npm run load` to load the BAYLINK graph'}`);
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
