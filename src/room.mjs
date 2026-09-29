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

export const encode = (text, payload) => (payload === undefined ? text : `${text}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``);
export function decode(content) {
  const s = String(content ?? '');
  const m = /```json\s*([\s\S]*?)```\s*$/.exec(s);
  let payload = null;
  if (m) { try { payload = JSON.parse(m[1]); } catch { payload = null; } }
  return { text: m ? s.slice(0, m.index).trim() : s.trim(), payload };
}

class LocalRoom {
  constructor() { this.mode = 'local'; this.roomId = null; this.handlers = new Map(); }
  async start() { return this; }
  join(name, handler) { this.handlers.set(name, handler); }
  async send(from, text, to, payload, runId) {
    const content = `${to.map(t => `@${t}`).join(' ')} ${encode(text, payload)}`;
    emit({ type: 'room', runId, from, to, kind: 'message', text, payload: summarize(payload) });
    for (const name of to) {
      const h = this.handlers.get(name);
      if (h) setTimeout(() => h({ id: `local-${Date.now()}`, from, ...decode(content.replace(/^(@\S+\s)+/, '')) }).catch(e => emit({ type: 'error', runId, message: `${name}: ${e.message}` })), 50);
    }
  }
  async event(from, kind, text, runId) { emit({ type: 'room', runId, from, to: [], kind, text }); }
  async close() {}
  info() { return { mode: 'local', room: null, agents: AGENTS.map(n => ({ name: n, role: ROLE[n], ok: true })) }; }
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
    const client = this.clients.get(name);
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const r = await client.agentApiMessages.getAgentNextMessage(this.roomId);
        const m = r?.data ?? r;
        if (m && m.id) {
          const senderId = m.sender_id ?? m.senderId ?? m.sender?.id;
          const me = this.who.get(name)?.id;
          await client.agentApiMessages.markAgentMessageProcessing(this.roomId, m.id).catch(() => {});
          try {
            if (senderId !== me) {
              const from = [...this.who].find(([, w]) => w.id === senderId)?.[0] ?? (m.sender_name ?? m.senderName ?? 'User');
              const content = String(m.content ?? '').replace(/^(@[^\s]+\s+)+/, '');
              const h = this.handlers.get(name);
              if (h) await h({ id: m.id, from, ...decode(content) });
            }
            await client.agentApiMessages.markAgentMessageProcessed(this.roomId, m.id).catch(() => {});
          } catch (e) {
            await client.agentApiMessages.markAgentMessageFailed(this.roomId, m.id, { error: String(e.message).slice(0, 200) }).catch(() => {});
            emit({ type: 'error', runId: null, message: `${name}: ${e.message}` });
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
  info() { return { mode: 'band', room: this.roomId, agents: AGENTS.map(n => ({ name: n, role: ROLE[n], ok: this.ok.get(n) !== false, id: this.who.get(n)?.id })) }; }
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
