// Records the demo: the three slides as PNGs and one real crew run as a CDP screencast (frames + timestamps).
// node demo/record.mjs  (the server must be running on :8787 with real keys)
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'C:/Users/willy/hack2026/video';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const REQUEST = 'A Saturday with my two kids (6 and 9): live music and something to eat. We take Muni, not too much walking.';
const DATE = '2026-10-03';
const sleep = ms => new Promise(r => setTimeout(r, ms));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/frames`, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--window-size=1440,900', '--force-device-scale-factor=1', '--hide-scrollbars', '--no-first-run', '--force_high_performance_gpu', `--user-data-dir=C:/Users/willy/hack2026/chrome-rec`, 'about:blank'], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 50 && !targets; i++) { await sleep(200); try { targets = await (await fetch('http://127.0.0.1:9333/json/list')).json(); } catch { /* not up yet */ } }
const page = targets.find(t => t.type === 'page');
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

// slides
await send('Page.navigate', { url: 'file:///C:/Users/willy/hack2026/baybay-crew/demo/slides.html' });
await sleep(1500);
for (const s of ['title', 'arch', 'end']) { await evaluate(`document.body.dataset.s='${s}'`); await sleep(500); await shot(`${OUT}/slide-${s}.png`); }

// the live run
await send('Page.navigate', { url: 'http://localhost:8787/' });
await sleep(4000);
await evaluate(`document.querySelector('[data-lang="en"]')?.click()`);
await sleep(1500);
const frames = [];
handlers.set('Page.screencastFrame', p => {
  const n = frames.length;
  writeFileSync(`${OUT}/frames/f${String(n).padStart(5, '0')}.jpg`, Buffer.from(p.data, 'base64'));
  frames.push(p.metadata.timestamp);
  send('Page.screencastFrameAck', { sessionId: p.sessionId });
});
await send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 });
const t0 = Date.now() / 1000;
await sleep(1200);
// type the request like a person
await evaluate(`(async () => { const q = document.getElementById('q'); q.focus(); q.value = ''; const s = ${JSON.stringify(REQUEST)}; for (const ch of s) { q.value += ch; q.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 28)); } const d = document.getElementById('date'); d.value = '${DATE}'; d.dispatchEvent(new Event('input', { bubbles: true })); d.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(700);
await evaluate(`document.getElementById('go').click()`);
const tAsk = Date.now() / 1000;
let tDone = null;
for (let i = 0; i < 240; i++) {
  await sleep(500);
  const done = await evaluate(`(() => { const t = document.getElementById('trace')?.innerText || ''; return /Done|完成/.test(t) && !document.getElementById('go').disabled; })()`);
  if (done) { tDone = Date.now() / 1000; break; }
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
writeFileSync(`${OUT}/timeline.json`, JSON.stringify({ t0, tAsk, tDone, tEnd, frames }, null, 1));
await shot(`${OUT}/final.png`);
console.log(`frames ${frames.length} · ask +${(tAsk - t0).toFixed(1)} s · done ${tDone ? `+${(tDone - t0).toFixed(1)} s` : 'NOT DONE'} · end +${(tEnd - t0).toFixed(1)} s`);
ws.close();
chrome.kill();
process.exit(0);
