/**
 * OpenAI-compatible chat completions (adapted from agent/llm.js at the repo
 * root). Adds: per-call model choice, waiting out 429s when the window resets
 * soon, a retry for transient proxy errors, image inputs, and a call counter
 * (the PLEC proxy is capped per 5 minutes and shared with the teammate).
 */
import { config, requireLlmKey } from './config.js';
import { log } from './log.js';
import { emit } from './bus.js';

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

export const stats = { calls: 0, tokens: 0, errors: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object[]} messages OpenAI-shaped
 * @param {{ model?: string, tools?: object[], toolChoice?: any, temperature?: number, label?: string, maxWaitS?: number }} [options]
 */
export async function chatCompletion(messages, options = {}) {
  requireLlmKey();
  const model = options.model || config.llm.modelSmart;
  const body = { model, messages, temperature: options.temperature ?? 0.3 };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? 'auto';
  }
  const maxWaitS = options.maxWaitS ?? config.llm.maxWaitS;
  let waited = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const started = Date.now();
    let response;
    let text;
    try {
      response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      text = await response.text();
    } catch (err) {
      stats.errors += 1;
      if (attempt < 1) { await sleep(1000); continue; }
      throw new LlmError(`could not reach model: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message}`);
    }
    stats.calls += 1;
    if (!response.ok) {
      let parsed = {};
      try { parsed = JSON.parse(text); } catch { /* not json */ }
      const retryAfter = Number(parsed.retryAfterSeconds) || 0;
      const transient = ['proxy_busy', 'upstream_error', 'upstream_timeout', 'upstream_unreachable'].includes(parsed.error);
      if (response.status === 429 && retryAfter && waited + retryAfter <= maxWaitS) {
        log('⏳', null, `model quota: ${parsed.error}, waiting ${retryAfter}s`);
        emit('llm_wait', null, { seconds: retryAfter, error: parsed.error });
        await sleep(retryAfter * 1000 + 500);
        waited += retryAfter;
        continue;
      }
      if (transient && attempt < 3) { await sleep(1000 * (attempt + 1)); continue; }
      stats.errors += 1;
      throw new LlmError(`${model} HTTP ${response.status}: ${text.slice(0, 240)}`, { status: response.status, body: text });
    }
    let raw;
    try { raw = JSON.parse(text); } catch { throw new LlmError(`model returned non-JSON: ${text.slice(0, 200)}`); }
    stats.tokens += raw.usage?.total_tokens || 0;
    emit('llm_call', null, { label: options.label, model, ms: Date.now() - started, tokens: raw.usage?.total_tokens, calls: stats.calls });
    const message = raw.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    const toolCalls = (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function?.name ?? '', argumentsJson: c.function?.arguments ?? '{}' }));
    const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : '';
    return { text: content, toolCalls, message, raw };
  }
  throw new LlmError('model unavailable after retries');
}

/** Tolerate the occasional malformed JSON (code fences, trailing text). */
export function parseArgs(json) {
  if (json && typeof json === 'object') return json;
  const s = String(json || '{}').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

/**
 * Force a single structured tool call. Tries a named tool_choice first; if
 * the provider refuses that, falls back to "required"/"auto" + instruction,
 * and finally parses JSON out of plain text.
 */
let namedChoiceWorks = true;
export async function forcedToolCall(messages, tool, options = {}) {
  const name = tool.function.name;
  const attempts = namedChoiceWorks ? [{ type: 'function', function: { name } }, 'auto'] : ['auto'];
  let lastErr;
  for (const choice of attempts) {
    try {
      const r = await chatCompletion(messages, { ...options, tools: [tool], toolChoice: choice });
      const call = r.toolCalls.find((c) => c.name === name);
      const args = call ? parseArgs(call.argumentsJson) : parseArgs(r.text);
      if (args) return args;
      lastErr = new LlmError(`no ${name} call in response`);
    } catch (err) {
      lastErr = err;
      if (choice !== 'auto' && err.status === 400 && /tool_choice/i.test(err.body || '')) { namedChoiceWorks = false; continue; }
      if (err.status !== 400) throw err;
    }
  }
  throw lastErr;
}
