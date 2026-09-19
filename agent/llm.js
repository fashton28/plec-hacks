/**
 * One call to an OpenAI-compatible chat completions endpoint. Zero
 * dependencies: it is a single fetch. Works with OpenAI, Anthropic's
 * compatibility endpoint, Groq, DeepSeek, Moonshot, Ollama, and anything else
 * that speaks POST /chat/completions.
 *
 * Configuration comes from the environment at call time (not import time), so
 * server.js can load .env before the first request without import-order games:
 *   LLM_BASE_URL   default https://api.openai.com/v1
 *   LLM_API_KEY    required by every hosted provider
 *   LLM_MODEL      default gpt-4o-mini
 */

export class LlmError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.body = body;
  }
}

/** Providers occasionally stall; 35s leaves room to answer inside the 45s turn budget. */
const REQUEST_TIMEOUT_MS = 35_000;

/**
 * @param {Array<object>} messages  OpenAI-shaped messages (system, user, assistant, tool)
 * @param {object} [options]
 * @param {Array<object>} [options.tools]  OpenAI function-tool definitions (see plec.js `tools`)
 * @param {number} [options.temperature]
 * @param {string|object} [options.toolChoice]  "auto" (default), "none", "required", or a named tool
 * @returns {Promise<{ text: string, toolCalls: Array<{ id: string, name: string, argumentsJson: string }>, message: object, raw: object }>}
 *   `message` is the assistant message exactly as the provider returned it. Push it onto your
 *   history before you push the tool results, or the next call will be rejected.
 */
export async function chatCompletion(messages, options = {}) {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) {
    throw new LlmError('LLM_API_KEY is not set. Put your provider key in .env.');
  }

  const body = { model, messages };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? 'auto';
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey || 'none'}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `no answer in ${REQUEST_TIMEOUT_MS / 1000}s` : err?.message;
    throw new LlmError(`Could not reach ${baseUrl}: ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new LlmError(`${model} at ${baseUrl} answered HTTP ${response.status}: ${text.slice(0, 300)}`, {
      status: response.status,
      body: text,
    });
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LlmError(`${baseUrl} returned something that is not JSON: ${text.slice(0, 200)}`);
  }

  const message = raw.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  const toolCalls = (message.tool_calls ?? [])
    .filter((call) => call.type === 'function' || call.function)
    .map((call) => ({
      id: call.id,
      name: call.function?.name ?? '',
      argumentsJson: call.function?.arguments ?? '{}',
    }));

  return {
    text: typeof message.content === 'string' ? message.content : contentToText(message.content),
    toolCalls,
    message,
    raw,
  };
}

/** Some providers return content as an array of blocks; flatten the text ones. */
function contentToText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** Parse a tool call's arguments, tolerating the occasional malformed JSON from a model. */
export function parseToolArguments(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
