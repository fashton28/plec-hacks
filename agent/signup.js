/**
 * Self-serve iMessage sign-up (POST /imessage/signup, page at /imessage.html).
 *
 * On Photon's shared-pool plans a line only talks to people registered as
 * Users of the project, and each person is ASSIGNED their own number to text.
 * So there is no single number to publish. Instead a visitor types their name,
 * email and phone here, we register them through Photon's management API, and
 * hand back the number assigned to them plus a link that opens Messages.
 *
 * Management API: https://spectrum.photon.codes, HTTP Basic auth with the
 * project id and secret. The create body is { firstName, lastName, email,
 * phoneNumber (E.164), type: 'shared' }; that shape is not in Photon's docs and
 * was confirmed against the live API.
 *
 * It is a public form on a public URL that spends a scarce resource (the plan's
 * user cap), so it is guarded: an optional access code, a per-IP rate limit and
 * a hard user cap. Configuration, read at call time:
 *   SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET   required, else the route answers 503
 *   IMESSAGE_SIGNUP_CODE        optional; when set, the form must carry it
 *   IMESSAGE_SIGNUP_MAX_USERS   default 10 (the Free plan's cap)
 */

const API = 'https://spectrum.photon.codes';
const REQUEST_TIMEOUT_MS = 12_000;
const RATE_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 };
const FIRST_TEXT = 'yo plec';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "(215) 555-0123" -> "+12155550123". Ten digits are read as a US number; anything else must carry its country code. */
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Opens Messages with the number and a first text filled in. "?&body=" is the form both iOS and Android accept. */
export function smsLink(number, body = FIRST_TEXT) {
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

/**
 * @returns {{ ok: true, value: { firstName: string, lastName: string, email: string, phoneNumber: string } } | { ok: false, message: string }}
 */
export function validateSignup(input) {
  const name = String(input?.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(input?.email ?? '').trim().toLowerCase();
  const phoneNumber = normalizePhone(input?.phone);
  if (name.length < 2 || name.length > 80) return { ok: false, message: 'Tell us your name so the agent knows who is texting.' };
  if (!EMAIL.test(email) || email.length > 120) return { ok: false, message: 'That email does not look right.' };
  if (!phoneNumber) return { ok: false, message: 'That phone number does not look right. Include the country code if it is not a US number.' };
  const [firstName, ...rest] = name.split(' ');
  return { ok: true, value: { firstName, lastName: rest.join(' ') || '-', email, phoneNumber } };
}

const hits = new Map();
/** Sliding window per caller. Returns true when the caller is over the limit. */
export function rateLimited(key, now = Date.now()) {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    hits.set(key, recent);
    return true;
  }
  hits.set(key, [...recent, now]);
  if (hits.size > 5_000) hits.clear();
  return false;
}

function reply(status, body) {
  return { status, body };
}

/**
 * Register a visitor, or find them if they signed up before, and return the number assigned to them.
 * @param {{ name?: string, email?: string, phone?: string, code?: string }} input
 * @param {{ ip?: string, fetchImpl?: typeof fetch, env?: Record<string, string|undefined>, now?: number }} [ctx]
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function signup(input, { ip = 'unknown', fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  const projectId = env.SPECTRUM_PROJECT_ID || '';
  const secret = env.SPECTRUM_PROJECT_SECRET || '';
  if (!projectId || !secret) return reply(503, { error: 'imessage_off', message: 'Texting is not switched on for this agent right now. The web chat works.' });

  const wanted = env.IMESSAGE_SIGNUP_CODE || '';
  if (wanted && String(input?.code ?? '').trim() !== wanted) return reply(403, { error: 'bad_code', message: 'That access code is not right.' });
  if (rateLimited(ip, now)) return reply(429, { error: 'slow_down', message: 'Too many tries from here. Give it an hour.' });

  const checked = validateSignup(input);
  if (!checked.ok) return reply(400, { error: 'invalid', message: checked.message });
  const person = checked.value;

  const base = `${API}/projects/${encodeURIComponent(projectId)}/users/`;
  const headers = { Authorization: `Basic ${Buffer.from(`${projectId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const call = async (method, body) => {
    const res = await fetchImpl(base, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok && data?.succeed === true, status: res.status, data: data?.data, message: data?.message };
  };
  const done = (user, already) => reply(200, { number: user.assignedPhoneNumber, smsUrl: smsLink(user.assignedPhoneNumber), already, firstText: FIRST_TEXT });

  try {
    const listed = await call('GET');
    if (!listed.ok) throw new Error(`list users answered ${listed.status}`);
    const users = listed.data?.users ?? [];
    const existing = users.find((u) => u.phoneNumber === person.phoneNumber || (u.email ?? '').toLowerCase() === person.email);
    if (existing?.assignedPhoneNumber) return done(existing, true);

    const cap = Number(env.IMESSAGE_SIGNUP_MAX_USERS) || 10;
    if ((listed.data?.total ?? users.length) >= cap) return reply(409, { error: 'full', message: 'All the texting spots are taken right now. The web chat has the same agent.' });

    const created = await call('POST', { ...person, type: 'shared' });
    if (!created.ok || !created.data?.assignedPhoneNumber) throw new Error(`create user answered ${created.status}: ${String(created.message ?? '').slice(0, 200)}`);
    console.log(`[signup] registered a new iMessage user (${users.length + 1} of ${cap})`);
    return done(created.data, false);
  } catch (err) {
    console.error('[signup] failed:', err?.message ?? err);
    return reply(502, { error: 'photon_unreachable', message: 'Could not set up texting just now. Try again in a minute, or use the web chat.' });
  }
}
