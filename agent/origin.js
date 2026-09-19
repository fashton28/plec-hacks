/**
 * The public address of this agent, for links it hands out (event pages,
 * calendar links). PUBLIC_URL wins. Otherwise the server learns it from the
 * requests it receives, but only from tunnel hosts it recognises: a Host header
 * is attacker-controlled, and an unchecked one would let anybody point our
 * guests' links at their own site.
 */

const TRUSTED_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?$|\.trycloudflare\.com$|\.ngrok(-free)?\.(app|dev|io)$|\.ngrok\.io$/i;
let learned = null;

export function noteRequestOrigin(headers = {}) {
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? '').split(',')[0].trim();
  if (!host || !TRUSTED_HOST.test(host)) return;
  const local = /^(localhost|127\.0\.0\.1)/i.test(host);
  // A tunnel address beats localhost, and is never replaced by it: links sent to a phone must work from the phone.
  if (local && learned && !/localhost|127\.0\.0\.1/.test(learned)) return;
  const proto = local ? 'http' : 'https';
  learned = `${proto}://${host}`;
}

export function publicOrigin() {
  const fixed = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return fixed || learned || `http://localhost:${Number(process.env.AGENT_PORT) || 8787}`;
}

/** For tests. */
export function _forget() { learned = null; }
