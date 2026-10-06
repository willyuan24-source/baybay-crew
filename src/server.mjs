process.on('unhandledRejection', e => console.error('[unhandled]', e?.message ?? e));
process.on('uncaughtException', e => console.error('[uncaught]', e?.message ?? e));
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, crusoeOn } from './config.mjs';
import { bus, emit } from './bus.mjs';
import { createRoom } from './room.mjs';
import { startCrew, nextSaturday } from './agents.mjs';
import { dashboard, dataRange, graphMode, neo4jStats, overview, stats } from './graph.mjs';
import { listModels } from './llm.mjs';

const room = await createRoom();
const crew = startCrew(room);
const HOST = config.host || '127.0.0.1';

// Crusoe's model list: undefined until the first answer, null when the listing failed; retried at most once a minute
let models, modelsAt = 0, modelsP = null;
const listNow = () => { modelsAt = Date.now(); return (modelsP = listModels().then(m => { models = m; }, () => { models = null; })); };
if (crusoeOn()) listNow();

async function status() {
  const want = Object.values(config.crusoe.models);
  if (crusoeOn() && models === undefined) await Promise.race([modelsP, new Promise(r => setTimeout(r, 3000))]);
  else if (crusoeOn() && !(models && want.every(m => models.includes(m))) && Date.now() - modelsAt > 60e3) listNow();
  const missing = models ? want.filter(m => !models.includes(m)) : [];
  const crusoeErr = !crusoeOn() ? undefined : models === undefined ? 'model list pending' : models === null ? 'model list failed' : missing.length ? `not served: ${missing.join(', ')}` : undefined;
  const s = stats();
  const live = await neo4jStats();
  const neo4jErr = live?.error ?? (live && live.nodes !== s.nodes ? `the graph has ${live.nodes} of ${s.nodes} nodes — run npm run load` : undefined);
  return {
    crusoe: { ok: crusoeOn() && !crusoeErr, model: crusoeOn() ? want.map(m => m.split('/').pop()).join(' · ') : 'not configured (rule-based fallback)', perAgent: config.crusoe.models, error: crusoeErr },
    neo4j: { ok: graphMode() === 'neo4j' && !!live && !neo4jErr, mode: graphMode(), nodes: live?.nodes ?? s.nodes, rels: live?.rels ?? s.rels, labels: s.labels, error: neo4jErr },
    band: room.info(),
    data: dataRange(),
  };
}

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const httpError = (code, message) => Object.assign(new Error(message), { http: code });
// the whole body as Buffers, decoded once (a UTF-8 character can be split across chunks); over 100 KB → 413
const readBody = req => new Promise((ok, bad) => {
  const parts = []; let n = 0;
  req.on('data', c => { n += c.length; if (n <= 1e5) parts.push(c); });
  req.on('end', () => {
    if (n > 1e5) return bad(httpError(413, 'request too large'));
    try { ok(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { bad(httpError(400, 'invalid JSON')); }
  });
  req.on('error', e => bad(httpError(400, e.message)));
});
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).toISOString().slice(0, 10) === s;
const clientId = c => (typeof c === 'string' && /^[\w.:-]{1,100}$/.test(c) ? c : null);
const bracket = h => (h.includes(':') ? `[${h}]` : h);
const hostOf = s => { try { return new URL(s).host; } catch { return null; } };
let hosts = new Set(); // the Host headers we answer (filled once listening): a DNS-rebinding page sends its own name

// runs in flight (at most MAX_RUNS; each counts until its 'done' / 'error' or 5 minutes) and the browser that asked for each
const MAX_RUNS = 3;
const active = new Map(), owners = new Map();
bus.on('ev', ev => {
  if ((ev.type === 'done' || ev.type === 'error') && active.has(ev.runId)) { clearTimeout(active.get(ev.runId)); active.delete(ev.runId); }
});

const server = createServer(async (req, res) => {
  try {
    if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return json(res, 403, { error: 'bad host' });
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/status') return json(res, 200, await status());
    if (url.pathname === '/api/graph/overview') return json(res, 200, overview());
    if (url.pathname === '/api/dashboard') return json(res, 200, await dashboard(today()));
    if (url.pathname === '/api/ask' && req.method === 'POST') {
      // only this page may start a run: same origin, and JSON (a cross-site form or no-cors fetch can only send text/plain)
      if (req.headers.origin !== undefined && hostOf(req.headers.origin) !== hostOf(`http://${req.headers.host}`)) return json(res, 403, { error: 'cross-origin request' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'content-type must be application/json' });
      const b = await readBody(req);
      if (!b || typeof b !== 'object' || (b.text != null && typeof b.text !== 'string')) return json(res, 400, { error: 'text must be a string' });
      const text = (b.text ?? '').trim().slice(0, 500);
      if (!text) return json(res, 400, { error: 'empty request' });
      if (active.size >= MAX_RUNS) return json(res, 429, { error: 'busy' });
      const date = isDate(b.date) ? b.date : nextSaturday();
      const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
      const client = clientId(b.client);
      if (client) { owners.set(runId, client); if (owners.size > 500) owners.delete(owners.keys().next().value); }
      active.set(runId, setTimeout(() => active.delete(runId), 300e3).unref());
      crew.ask({ text, lang: b.lang === 'en' ? 'en' : 'zh', date }, runId).catch(e => emit({ type: 'error', runId, message: e.message }));
      return json(res, 200, { runId, date });
    }
    if (url.pathname === '/api/stream') {
      // a run's events go only to the streams of the browser that asked for it; Band-room runs and run-less events go to all
      const client = clientId(url.searchParams.get('client'));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      // subscribed before the (possibly slow) status, so nothing is lost; what arrives meanwhile follows the status
      let open = true, early = [];
      const send = s => { if (open && !res.writableEnded) res.write(s); };
      const on = ev => { const o = owners.get(ev.runId); if (o === undefined || o === client) { const s = `data: ${JSON.stringify(ev)}\n\n`; if (early) early.push(s); else send(s); } };
      bus.on('ev', on);
      const ping = setInterval(() => send(': ping\n\n'), 15000);
      res.on('close', () => { open = false; bus.off('ev', on); clearInterval(ping); });
      const s = await status().catch(e => { console.error('[server] status:', e); return null; });
      if (s) send(`data: ${JSON.stringify({ type: 'status', ...s })}\n\n`);
      early.forEach(send); early = null;
      return;
    }
    let file;
    try { file = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return json(res, 400, { error: 'bad path' }); }
    const path = join(PUBLIC, file);
    if (file.includes('\0') || file.split(/[\\/]/).includes('..') || !path.startsWith(PUBLIC)) return json(res, 400, { error: 'bad path' });
    if (!(await stat(path)).isFile()) return json(res, 404, { error: 'not found' });
    const body = await readFile(path);
    // never inside another site's frame (a framed page's clicks could start runs that spend the keys)
    res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(body);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e.http) return json(res, e.http, { error: e.message });
    if (['ENOENT', 'EISDIR', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL'].includes(e.code)) return json(res, 404, { error: 'not found' });
    if (e.code === 'ERR_INVALID_URL') return json(res, 400, { error: 'bad request' });
    console.error('[server]', req.method, req.url, e);
    json(res, 500, { error: 'internal error' }); // the details stay in this log
  }
});

server.on('error', e => {
  if (server.listening) return console.error('[server]', e.message);
  console.error(e.code === 'EADDRINUSE' ? `[server] port ${config.port} is already in use on ${HOST} — stop the other server or set PORT` : `[server] cannot listen on ${HOST}:${config.port}: ${e.message}`);
  process.exit(1);
});
server.listen(config.port, HOST, () => {
  const { port } = server.address();
  // loopback and HOST; a non-loopback HOST adds this machine's name, a wildcard (0.0.0.0 / ::) its LAN addresses too, so
  // another device can open it; ALLOWED_HOSTS adds more (an entry without a port: bare or with ours)
  const wild = ['0.0.0.0', '::'].includes(HOST), loop = ['127.0.0.1', 'localhost', '::1'].includes(HOST.toLowerCase());
  const own = loop ? [] : [hostname(), `${hostname()}.local`, ...(wild ? Object.values(networkInterfaces()).flat().map(a => a.address) : [])];
  const names = [...new Set(['localhost', '127.0.0.1', '::1', HOST, ...own].map(h => bracket(h.toLowerCase())))];
  hosts = new Set([...names.flatMap(h => (port === 80 ? [h, `${h}:80`] : [`${h}:${port}`])), ...config.allowedHosts.flatMap(h => (/:\d+$/.test(h) ? [h] : [h, `${h}:${port}`]))]);
  console.log(`BAYBAY Crew on http://${['127.0.0.1', '0.0.0.0', '::'].includes(HOST) ? 'localhost' : bracket(HOST)}:${port}`);
  const lan = names.filter(h => !['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(h) && !h.startsWith('['));
  if (lan.length || config.allowedHosts.length) console.log(`  also as ${[...lan.map(h => `http://${h}:${port}`), ...config.allowedHosts].join(' · ')} — any other Host name gets 403 (add it to ALLOWED_HOSTS)`);
  console.log(`  Crusoe: ${crusoeOn() ? Object.entries(config.crusoe.models).map(([a, m]) => `${a} ${m}`).join(' · ') : 'not configured → rule-based fallback'}`);
  console.log(`  Neo4j:  ${graphMode()}`);
  console.log(`  Band:   ${room.mode}${room.roomId ? ` room ${room.roomId}` : ''}`);
  if (graphMode() === 'neo4j') neo4jStats().then(live => {
    const n = stats().nodes;
    if (live?.error) console.warn(`  Neo4j is not answering (${live.error}) — the crew uses the local copy of the graph until it does`);
    else if (live && live.nodes !== n) console.warn(`  Neo4j has ${live.nodes} of ${n} nodes — run npm run load`);
  });
});
