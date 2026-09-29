process.on('unhandledRejection', e => console.error('[unhandled]', e?.message ?? e));
process.on('uncaughtException', e => console.error('[uncaught]', e?.message ?? e));
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { config, crusoeOn } from './config.mjs';
import { bus, emit } from './bus.mjs';
import { createRoom } from './room.mjs';
import { startCrew, nextSaturday } from './agents.mjs';
import { dashboard, graphMode, neo4jStats, overview, stats } from './graph.mjs';
import { listModels } from './llm.mjs';

const room = await createRoom();
const crew = startCrew(room);
let models = [];
listModels().then(m => { models = m; });

async function status() {
  const s = stats();
  const live = await neo4jStats();
  return {
    crusoe: { ok: crusoeOn() && (models.length === 0 || Object.values(config.crusoe.models).every(m => models.includes(m))), model: crusoeOn() ? Object.values(config.crusoe.models).map(m => m.split('/').pop()).join(' · ') : 'not configured (rule-based fallback)', perAgent: config.crusoe.models, baseUrl: config.crusoe.baseUrl, models },
    neo4j: { ok: graphMode() === 'neo4j' && !live?.error, mode: graphMode(), nodes: live?.nodes ?? s.nodes, rels: live?.rels ?? s.rels, labels: s.labels, error: live?.error },
    band: room.info(),
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/status') return json(res, 200, await status());
    if (url.pathname === '/api/graph/overview') return json(res, 200, overview());
    if (url.pathname === '/api/dashboard') return json(res, 200, await dashboard(today()));
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text ?? '').trim().slice(0, 500);
      if (!text) return json(res, 400, { error: 'empty request' });
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '') ? b.date : nextSaturday();
      const runId = `run-${Date.now().toString(36)}`;
      crew.ask({ text, lang: b.lang === 'en' ? 'en' : 'zh', date }, runId).catch(e => emit({ type: 'error', runId, message: e.message }));
      return json(res, 200, { runId, date });
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'status', ...(await status()) })}\n\n`);
      const on = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      bus.on('ev', on);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { bus.off('ev', on); clearInterval(ping); });
      return;
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (file.includes('..')) return json(res, 400, { error: 'bad path' });
    const body = await readFile(new URL(`../public${file}`, import.meta.url));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 500, { error: e.message });
  }
}).listen(config.port, () => {
  console.log(`BAYBAY Crew on http://localhost:${config.port}`);
  console.log(`  Crusoe: ${crusoeOn() ? config.crusoe.model : 'not configured → rule-based fallback'}`);
  console.log(`  Neo4j:  ${graphMode()}`);
  console.log(`  Band:   ${room.mode}${room.roomId ? ` room ${room.roomId}` : ''}`);
});
