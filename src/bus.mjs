import { EventEmitter } from 'node:events';

/** The UI stream: every agent message, LLM call, Cypher query, plan and status goes out on this bus (→ SSE). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const emit = ev => bus.emit('ev', { at: new Date().toISOString(), ...ev });
