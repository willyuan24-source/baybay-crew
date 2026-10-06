import { BandClient } from '@band-ai/rest-client';
import { bandOn, config } from './config.mjs';
import { emit } from './bus.mjs';

/**
 * The crew's only channel. Every handoff between the four agents is a Band chat-room message with an @mention (a
 * human-readable line + a fenced JSON payload); thoughts, tool calls and results are Band room events. An agent acts
 * ONLY when Band delivers it a message (polling /agent/chats/{id}/messages/next, marking processing → processed), so
 * deleting the room stops the crew (Band's "delete test").
 *
 * Without Band keys a LocalRoom with the same semantics runs in-process (labelled "local" in the UI).
 */
export const AGENTS = ['BAYBAY', 'Scout', 'Planner', 'Checker'];
const ENV_OF = { BAYBAY: 'BAYBAY', Scout: 'SCOUT', Planner: 'PLANNER', Checker: 'CHECKER' };

// the payload always rides last, with every backtick escaped (\u0060), so the LAST ```json fence is the payload even when
// the human line (the visitor's text) contains one
export const encode = (text, payload) => (payload === undefined ? text : `${text}\n\n\`\`\`json\n${JSON.stringify(payload).replace(/`/g, '\\u0060')}\n\`\`\``);
export function decode(content) {
  const s = String(content ?? '');
  const i = s.lastIndexOf('```json');
  const m = i < 0 ? null : /^```json\s*([\s\S]*?)\s*```\s*$/.exec(s.slice(i));
  let payload = null;
  if (m) { try { payload = JSON.parse(m[1]); } catch { payload = null; } }
  return { text: m ? s.slice(0, i).trim() : s.trim(), payload };
}

class LocalRoom {
  constructor() { this.mode = 'local'; this.roomId = null; this.handlers = new Map(); this.seq = 0; }
  async start() { return this; }
  join(name, handler) { this.handlers.set(name, handler); }
  async send(from, text, to, payload, runId) {
    const content = `${to.map(t => `@${t}`).join(' ')} ${encode(text, payload)}`;
    emit({ type: 'room', runId, from, to, kind: 'message', text, payload: summarize(payload) });
    // as in Band: delivered later (never inside send), never to the sender itself, and only the four agents speak as agents
    const sender = AGENTS.includes(from) ? from : 'User';
    for (const name of to) {
      const h = this.handlers.get(name);
      if (!h || name === from) continue;
      const msg = { id: `local-${++this.seq}`, from: sender, ...decode(content.replace(/^(@\S+\s)+/, '')) };
      setTimeout(() => Promise.resolve().then(() => h(msg)).catch(e => emit({ type: 'error', runId: msg.payload?.runId ?? runId ?? null, message: `${name}: ${e.message}` })), 50);
    }
  }
  async event(from, kind, text, runId) { emit({ type: 'room', runId, from, to: [], kind, text }); }
  async close() {}
  info() { return { mode: 'local', room: null, agents: AGENTS.map(n => ({ name: n, role: ROLE[n], ok: true })), ok: true }; }
}

class BandRoom {
  constructor() {
    this.mode = 'band'; this.roomId = config.band.roomId || null; this.handlers = new Map(); this.who = new Map(); this.timers = []; this.ok = new Map();
    this.clients = new Map(AGENTS.map(n => [n, new BandClient({ apiKey: config.band.agents[ENV_OF[n]].key })]));
  }
  async start() {
    for (const n of AGENTS) {
      const envId = config.band.agents[ENV_OF[n]].id;
      try {
        const me = await this.clients.get(n).agentApiIdentity.getAgentMe();
        const d = me?.data ?? me;
        this.who.set(n, { id: d?.id ?? envId, name: d?.name ?? n, handle: d?.handle ?? d?.username ?? undefined });
        this.ok.set(n, true);
      } catch (e) {
        this.who.set(n, { id: envId, name: n });
        this.ok.set(n, false);
        console.error(`[band] ${n} identity failed:`, e?.statusCode ?? '', e?.message);
      }
    }
    if (!this.roomId) {
      const c = await this.clients.get('BAYBAY').agentApiChats.createAgentChat({ chat: {} });
      this.roomId = (c?.data ?? c)?.id;
      for (const n of AGENTS.slice(1)) {
        try { await this.clients.get('BAYBAY').agentApiParticipants.addAgentChatParticipant(this.roomId, { participant: { participant_id: this.who.get(n).id } }); }
        catch (e) { console.error(`[band] add ${n} failed:`, e?.statusCode ?? '', e?.message); }
      }
      console.log('[band] created room', this.roomId);
    }
    for (const n of AGENTS) this.poll(n);
    return this;
  }
  join(name, handler) { this.handlers.set(name, handler); }
  poll(name) {
    const api = this.clients.get(name).agentApiMessages;
    // Band delivers at least once and serves failed messages again: each id is handled once; a repeat is only marked processed
    // (in a new attempt: /processed needs an open one, and /next keeps serving the oldest unprocessed message until then)
    const seen = new Set();
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const r = await api.getAgentNextMessage(this.roomId);
        const m = r?.data ?? r;
        if (m?.id && seen.has(m.id)) {
          await api.markAgentMessageProcessing(this.roomId, m.id).catch(() => {});
          await api.markAgentMessageProcessed(this.roomId, m.id).catch(() => {});
        } else if (m?.id) {
          seen.add(m.id);
          if (seen.size > 500) seen.delete(seen.values().next().value);
          const senderId = m.sender_id ?? m.senderId ?? m.sender?.id;
          const me = this.who.get(name)?.id;
          const dec = decode(String(m.content ?? '').replace(/^(@[^\s]+\s+)+/, ''));
          await api.markAgentMessageProcessing(this.roomId, m.id).catch(() => {});
          try {
            if (senderId !== me) {
              // a sender is an agent only by its Band id; anyone else in the room (whatever their display name) is a 'User'
              const from = [...this.who].find(([, w]) => senderId && w.id === senderId)?.[0] ?? 'User';
              const h = this.handlers.get(name);
              if (h) await h({ id: m.id, from, ...dec });
            }
            await api.markAgentMessageProcessed(this.roomId, m.id).catch(() => {});
          } catch (e) {
            await api.markAgentMessageFailed(this.roomId, m.id, { error: String(e.message).slice(0, 200) }).catch(() => {});
            emit({ type: 'error', runId: dec.payload?.runId ?? null, message: `${name}: ${e.message}` });
          }
        }
        this.ok.set(name, true);
      } catch (e) {
        if (this.ok.get(name)) console.error(`[band] ${name} poll:`, e?.statusCode ?? '', String(e?.message).slice(0, 160));
        this.ok.set(name, false);
      } finally { busy = false; }
    };
    this.timers.push(setInterval(tick, config.band.pollMs));
  }
  async send(from, text, to, payload, runId) {
    const mentions = to.map(t => this.who.get(t)).filter(Boolean).map(w => ({ id: w.id, name: w.name, ...(w.handle ? { handle: w.handle } : {}) }));
    const content = `${to.map(t => `@${this.who.get(t)?.handle ?? t}`).join(' ')} ${encode(text, payload)}`;
    await this.clients.get(from).agentApiMessages.createAgentChatMessage(this.roomId, { message: { content, mentions } });
    emit({ type: 'room', runId, from, to, kind: 'message', text, payload: summarize(payload), band: true });
  }
  async event(from, kind, text, runId) {
    emit({ type: 'room', runId, from, to: [], kind, text, band: true });
    try { await this.clients.get(from).agentApiEvents.createAgentChatEvent(this.roomId, { event: { content: text.slice(0, 3800), message_type: kind } }); }
    catch (e) { console.error(`[band] event ${kind} from ${from}:`, e?.statusCode ?? '', String(e?.message).slice(0, 160)); }
  }
  async close() { this.timers.forEach(clearInterval); }
  // for the browser: a short room id, no agent ids
  info() {
    const agents = AGENTS.map(n => ({ name: n, role: ROLE[n], ok: this.ok.get(n) !== false }));
    return { mode: 'band', room: this.roomId ? `${String(this.roomId).slice(0, 8)}…` : null, agents, ok: agents.every(a => a.ok) };
  }
}

const ROLE = { BAYBAY: 'host', Scout: 'graph scout', Planner: 'planner', Checker: 'checker' };
const summarize = p => (p === undefined ? undefined : JSON.stringify(p).length > 600 ? `${JSON.stringify(p).slice(0, 600)}…` : p);

export async function createRoom() {
  const room = bandOn() ? new BandRoom() : new LocalRoom();
  try { return await room.start(); }
  catch (e) {
    console.error('[band] could not start the Band room, falling back to local:', e?.statusCode ?? '', e?.message);
    return new LocalRoom().start();
  }
}
