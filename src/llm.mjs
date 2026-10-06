import OpenAI from 'openai';
import { config, crusoeOn } from './config.mjs';
import { emit } from './bus.mjs';

/**
 * Crusoe Managed Inference (OpenAI-compatible, open-weight models). Every call is reported on the bus with the provider
 * and model, so the UI always shows which provider answered. Without a key the crew still runs on a transparent rule-based
 * fallback, labelled "fallback" in the UI — never presented as Crusoe (nor is a step whose Crusoe call failed or whose
 * reply had no usable JSON).
 */
// no SDK retries (chat() retries on its own) and at most 60 s per attempt
const client = crusoeOn() ? new OpenAI({ apiKey: config.crusoe.apiKey, baseURL: config.crusoe.baseUrl, maxRetries: 0, timeout: 60_000 }) : null;
const t = (lang, zh, en) => (lang === 'en' ? en : zh);

/** The model ids Crusoe serves; null when the listing fails. */
export async function listModels() {
  if (!client) return [];
  try { const r = await client.models.list(); return r.data.map(m => m.id); } catch { return null; }
}

// rate limits, server errors, network errors and timeouts get two more tries
const retryable = e => e instanceof OpenAI.APIConnectionError || e?.status === 429 || e?.status >= 500;

/** Chat with a Crusoe model; returns the text. `json: true` asks for (and extracts) one JSON object; none, or one that
 *  `usable(obj)` turns down (the wrong shape) → fallback(). */
export async function chat({ agent, runId, lang, system, user, json = false, usable = () => true, model = config.crusoe.models[agent] ?? config.crusoe.model, temperature = 0.3, maxTokens = 1400, fallback }) {
  if (!client) {
    const out = await fallback();
    emit({ type: 'llm', runId, agent, provider: 'fallback (no Crusoe key)', model: 'rules', ms: 0, tokens: null });
    return out;
  }
  const t0 = Date.now();
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let text = '', tokens = null, lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await client.chat.completions.create({ model, messages, temperature, max_tokens: maxTokens });
      text = r.choices?.[0]?.message?.content ?? '';
      tokens = r.usage?.total_tokens ?? null;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2 && retryable(e)) { await new Promise(r => setTimeout(r, 1200 * (attempt + 1))); continue; }
      break;
    }
  }
  const ms = Date.now() - t0;
  if (lastErr) {
    const why = String(lastErr?.message ?? lastErr).slice(0, 160); // the SDK's message starts with the HTTP status
    emit({ type: 'llm', runId, agent, provider: 'Crusoe (failed → fallback)', model, ms, tokens: null });
    emit({ type: 'room', runId, from: agent, to: [], kind: 'error', text: t(lang, `Crusoe 调用失败（${why}），这一步改用规则兜底。`, `Crusoe call failed (${why}); using the rule-based fallback for this step.`) });
    return fallback();
  }
  const obj = json ? extractJson(stripThink(text)) : null;
  if (json && (obj === null || Array.isArray(obj) || !usable(obj))) {
    emit({ type: 'llm', runId, agent, provider: 'Crusoe (unparseable → fallback)', model, ms, tokens });
    emit({ type: 'room', runId, from: agent, to: [], kind: 'error', text: t(lang, 'Crusoe 回答了，但没有可用的 JSON，这一步改用规则兜底。', 'Crusoe answered without usable JSON; using the rule-based fallback for this step.') });
    return fallback();
  }
  emit({ type: 'llm', runId, agent, provider: 'Crusoe', model, ms, tokens });
  return json ? obj : stripThink(text);
}

// drops a closed <think>…</think>, everything before a lone </think> (the template opened it) and an unclosed <think>… (cut off)
const stripThink = s => String(s ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').replace(/<think>[\s\S]*$/i, '').trim();

/** The JSON in a model's reply: the last fenced block that parses, else the whole text, else the first {…} (then […]) in it. */
export function extractJson(s) {
  const text = String(s ?? '');
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(m => m[1]).reverse();
  for (const body of [...fenced, text]) {
    const v = jsonIn(body);
    if (v !== null) return v;
  }
  return null;
}

// only values that open outside any other bracket count: a broken outer object is skipped whole, never mined for a value
// inside it (one stop of a broken plan would pass for the plan)
function jsonIn(body) {
  try { const v = JSON.parse(body); if (v && typeof v === 'object') return v; } catch { /* look inside */ }
  const found = [];
  for (let i = body.search(/[{[]/); i >= 0;) {
    const r = balanced(body, i);
    if (!r) break; // never closes: a cut-off reply, so anything after it is a fragment
    if (r.value !== undefined) found.push(r.value);
    const next = body.slice(r.end + 1).search(/[{[]/);
    i = next < 0 ? -1 : r.end + 1 + next;
  }
  return found.find(v => !Array.isArray(v)) ?? found[0] ?? null;
}

// the value that opens at s[i] and where it closes: {value, end} (value undefined when it is not JSON); null when it never closes
function balanced(s, i) {
  let depth = 0, str = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (str) { if (ch === '\\') j++; else if (ch === '"') str = false; continue; }
    if (ch === '"') str = true;
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) { try { return { value: JSON.parse(s.slice(i, j + 1)), end: j }; } catch { return { value: undefined, end: j }; } }
  }
  return null;
}
