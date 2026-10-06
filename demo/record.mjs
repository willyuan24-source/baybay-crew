// Records the demo: the three slides as PNGs and one real crew run as a CDP screencast (frames + timestamps).
//
//   node demo/record.mjs [--out=DIR] [--clean] [--chrome=PATH] [--base=URL] [--request=TEXT] [--date=YYYY-MM-DD]
//
// The server must already be running (npm start; with real keys for a recording where the sponsors are live). Each option
// can also come from the environment: RECORD_OUT, CHROME_PATH, BASE_URL, RECORD_REQUEST, RECORD_DATE. The output goes to
// demo/out/ by default, which is emptied first; a folder given with --out is emptied only when --clean is passed too.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: arg } = parseArgs({ options: { out: { type: 'string' }, clean: { type: 'boolean' }, chrome: { type: 'string' }, base: { type: 'string' }, request: { type: 'string' }, date: { type: 'string' } } });
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, 'out');
const OUT = resolve(arg.out ?? process.env.RECORD_OUT ?? DEFAULT_OUT);
const CHROME = arg.chrome ?? process.env.CHROME_PATH ?? ({
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] ?? 'google-chrome');
const BASE = (arg.base ?? process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const REQUEST = arg.request ?? process.env.RECORD_REQUEST ?? 'A Saturday with my two kids (6 and 9): live music and something to eat. We take Muni, not too much walking.';
const DATE = arg.date ?? process.env.RECORD_DATE ?? '2026-10-03';
const SLIDES = new URL('./slides.html', import.meta.url).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error(`record: ${msg}`); process.exit(1); };

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) fail(`the date must be YYYY-MM-DD, got "${DATE}"`);
const status = await fetch(`${BASE}/api/status`).catch(() => null);
if (!status) fail(`no server at ${BASE} (start it with npm start, or pass --base / BASE_URL)`);
if (!status.ok) fail(`${BASE}/api/status answered HTTP ${status.status}`);
if (/[\\/]/.test(CHROME) && !existsSync(CHROME)) fail(`Chrome not found at ${CHROME} (pass --chrome or CHROME_PATH)`);

// the output folder: deleted only when it is demo/out or the caller passed --clean, and never when it holds this repo or home
const norm = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (p, dir) => norm(p) === norm(dir) || norm(p).startsWith(norm(dir.endsWith(sep) ? dir : dir + sep));
const unsafe = within(HERE, OUT) || within(homedir(), OUT);
if (norm(OUT) === norm(DEFAULT_OUT) || arg.clean) {
  if (unsafe) fail(`refusing to empty ${OUT}`);
  rmSync(OUT, { recursive: true, force: true });
} else if (existsSync(join(OUT, 'frames')) && readdirSync(join(OUT, 'frames')).length) console.warn(`record: ${OUT} already has frames; pass --clean to empty it first`);
mkdirSync(join(OUT, 'frames'), { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'baybay-rec-')); // a throwaway Chrome profile
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--window-size=1440,900', '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run', '--force_high_performance_gpu', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
chrome.on('error', e => { rmSync(profile, { recursive: true, force: true }); fail(`could not start Chrome (${CHROME}): ${e.message}`); });
async function quit(code, msg) {
  if (msg) console.error(`record: ${msg}`);
  if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill(); await Promise.race([new Promise(r => chrome.once('exit', r)), sleep(3000)]); }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked: it is only a temp folder */ }
  process.exit(code);
}

let targets = null;
for (let i = 0; i < 50 && !targets; i++) { await sleep(200); try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); } catch { /* not up yet */ } }
const page = targets?.find(t => t.type === 'page');
if (!page) await quit(1, `Chrome's debugging port never answered (${CHROME})`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map(); const handlers = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(file, Buffer.from(r.result.data, 'base64')); };

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// slides (at 1440×900 the stage is drawn 1:1)
await send('Page.navigate', { url: SLIDES });
await sleep(1500);
for (const s of ['title', 'arch', 'end']) { await evaluate(`document.body.dataset.s='${s}'`); await sleep(500); await shot(join(OUT, `slide-${s}.png`)); }

// the live run
await send('Page.navigate', { url: `${BASE}/` });
await sleep(4000);
await evaluate(`document.querySelector('[data-lang="en"]')?.click()`);
await sleep(1500);
const frames = [];
handlers.set('Page.screencastFrame', p => {
  const n = frames.length;
  writeFileSync(join(OUT, 'frames', `f${String(n).padStart(5, '0')}.jpg`), Buffer.from(p.data, 'base64'));
  frames.push(p.metadata.timestamp);
  send('Page.screencastFrameAck', { sessionId: p.sessionId });
});
await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
const t0 = Date.now() / 1000;
await sleep(1200);
// type the request like a person
await evaluate(`(async () => { const q = document.getElementById('q'); q.focus(); q.value = ''; const s = ${JSON.stringify(REQUEST)}; for (const ch of s) { q.value += ch; q.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 28)); } const d = document.getElementById('date'); d.value = ${JSON.stringify(DATE)}; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(700);
await evaluate(`document.getElementById('go').click()`);
const tAsk = Date.now() / 1000;
let tDone = null;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const finished = await evaluate(`(() => { const t = document.getElementById('trace')?.innerText || ''; return /Done|完成/.test(t) && !document.getElementById('go').disabled; })()`);
  if (finished) { tDone = Date.now() / 1000; break; }
}
await sleep(3500);
// scroll the plan into view (left column) and show the graph, then the dashboard
await evaluate(`document.getElementById('plan')?.scrollIntoView({ behavior: 'smooth', block: 'start' })`);
await sleep(3000);
await evaluate(`document.getElementById('gFit')?.click()`);
await sleep(3500);
await evaluate(`document.querySelector('[data-tab="dash"]')?.click()`);
await sleep(5000);
await evaluate(`document.querySelector('[data-tab="cypher"]')?.click()`);
await sleep(3000);
await evaluate(`document.querySelector('[data-tab="graph"]')?.click()`);
await sleep(2000);
await send('Page.stopScreencast');
await sleep(500);
const tEnd = Date.now() / 1000;
writeFileSync(join(OUT, 'timeline.json'), JSON.stringify({ t0, tAsk, tDone, tEnd, frames }, null, 1));
await shot(join(OUT, 'final.png'));
console.log(`frames ${frames.length} · ask +${(tAsk - t0).toFixed(1)} s · done ${tDone ? `+${(tDone - t0).toFixed(1)} s` : 'NOT DONE'} · end +${(tEnd - t0).toFixed(1)} s → ${OUT}`);
ws.close();
await quit(0);
