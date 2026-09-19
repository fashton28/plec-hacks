/**
 * PLEC sandbox client. Copied (trimmed) from agent/plec.js at the repo root
 * (createPlecClient), so edits there can never break this agent. Docs: docs/sandbox.md.
 */
import { config } from '../config.js';

export class PlecError extends Error {
  constructor(status, error, message) {
    super(message);
    this.name = 'PlecError';
    this.status = status;
    this.error = error;
  }
}

async function request(method, path, { query, body } = {}) {
  const { url: baseUrl, key } = config.sandbox;
  if (!key) throw new PlecError(401, 'missing_key', 'PLEC_SANDBOX_KEY is not set in plec-imessage/.env.');
  const url = new URL(baseUrl + path);
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PlecError(0, 'network', `Could not reach the sandbox: ${err?.name === 'TimeoutError' ? 'timed out' : err?.message}`);
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!response.ok) {
    const code = typeof json?.error === 'string' && /^[a-z_]+$/.test(json.error) ? json.error : `http_${response.status}`;
    const message = Array.isArray(json?.message) ? json.message.join('; ') : json?.message || text || `HTTP ${response.status}`;
    throw new PlecError(response.status, code, message);
  }
  return json;
}

export const sandbox = {
  searchListings: (filters = {}) => request('GET', '/listings', { query: filters }),
  getListing: (id) => request('GET', `/listings/${encodeURIComponent(id)}`),
  getAvailability: (id, date) => request('GET', `/listings/${encodeURIComponent(id)}/availability`, { query: { date } }),
  quote: (inputs) => request('POST', '/quotes', { body: inputs }),
  book: (input) => request('POST', '/bookings', { body: input }),
  getBooking: (ref) => request('GET', `/bookings/${encodeURIComponent(ref)}`),
  cancelBooking: (ref) => request('POST', `/bookings/${encodeURIComponent(ref)}/cancel`),
  rescheduleBooking: (ref, changes) => request('POST', `/bookings/${encodeURIComponent(ref)}/reschedule`, { body: changes }),
};
