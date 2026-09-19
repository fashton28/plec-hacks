/**
 * Real Spotify playlists, in the account of whoever connected it.
 *
 * Spotify only lets a logged-in user create a playlist, so this needs three
 * values in .env: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from an app at
 * https://developer.spotify.com/dashboard, and SPOTIFY_REFRESH_TOKEN, which
 * GET /spotify/login obtains with one click and writes into .env itself.
 * Without them the agent falls back to per-track Spotify search links.
 *
 * The model proposes tracks from memory; this file is what makes them real.
 * Every track is looked up on Spotify first, and only tracks Spotify actually
 * returned go into the playlist: the same "facts come from a tool" rule the
 * agent applies to venues, applied to songs.
 */

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const REQUEST_TIMEOUT_MS = 8_000;
export const SPOTIFY_SCOPES = 'playlist-modify-public playlist-modify-private';

const env = () => ({ id: process.env.SPOTIFY_CLIENT_ID || '', secret: process.env.SPOTIFY_CLIENT_SECRET || '', refresh: process.env.SPOTIFY_REFRESH_TOKEN || '' });
export const spotifyConfigured = () => Boolean(env().id && env().secret);
export const spotifyReady = () => Boolean(env().id && env().secret && env().refresh);

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
  }
}

const basicAuth = () => `Basic ${Buffer.from(`${env().id}:${env().secret}`).toString('base64')}`;

async function tokenRequest(form, fetchImpl) {
  const res = await fetchImpl(`${ACCOUNTS}/api/token`, { method: 'POST', headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(`Spotify refused the token request: ${body.error_description || body.error || res.status}`, res.status);
  return body;
}

let cached = { token: '', expiresAt: 0 };
let refreshing = null;
/** Track lookups run in parallel, so they share one refresh instead of each asking Spotify for a token. */
async function accessToken(fetchImpl) {
  if (cached.token && Date.now() < cached.expiresAt - 30_000) return cached.token;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: env().refresh }, fetchImpl)
    .then((body) => { cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }; return cached.token; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

async function api(method, path, body, fetchImpl) {
  const res = await fetchImpl(`${API}${path}`, { method, headers: { Authorization: `Bearer ${await accessToken(fetchImpl)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new SpotifyError(`Spotify ${method} ${path.split('?')[0]} answered ${res.status}: ${json.error?.message ?? 'no detail'}`, res.status);
  return json;
}

/** The address Spotify sends the user back to. Spotify accepts plain http only for the loopback IP, never for "localhost". */
export const redirectUri = (port) => `http://127.0.0.1:${port}/spotify/callback`;

export function authorizeUrl(port, state) {
  return `${ACCOUNTS}/authorize?${new URLSearchParams({ response_type: 'code', client_id: env().id, scope: SPOTIFY_SCOPES, redirect_uri: redirectUri(port), state })}`;
}

/** Trade the code from the login redirect for a refresh token. */
export async function exchangeCode(code, port, fetchImpl = fetch) {
  const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(port) }, fetchImpl);
  if (!body.refresh_token) throw new SpotifyError('Spotify did not return a refresh token.');
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.refresh_token;
}

const words = (s) => new Set(String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['the', 'and', 'feat', 'with'].includes(w)));
const shares = (a, b) => { const other = words(b); return [...words(a)].some((w) => other.has(w)); };
/**
 * Spotify's search always returns something, even for a song that does not exist. A hit only counts when both its
 * title and one of its artists share a real word with what was asked for. Seen live: a made-up title came back as an
 * unrelated song before this check.
 */
export function sameTrack(wanted, hit) {
  return shares(wanted.title, hit.title) && shares(wanted.artist, hit.artist);
}

/** Find one track. A field search first, because it is precise; a plain search second, because titles vary. */
async function findTrack({ title, artist }, fetchImpl) {
  for (const q of [`track:"${title}" artist:"${artist}"`, `${title} ${artist}`]) {
    const found = await api('GET', `/search?${new URLSearchParams({ q, type: 'track', limit: '1' })}`, null, fetchImpl);
    const item = found.tracks?.items?.[0];
    const hit = item && { uri: item.uri, title: item.name, artist: (item.artists ?? []).map((a) => a.name).join(', '), url: item.external_urls?.spotify ?? null };
    if (hit && sameTrack({ title, artist }, hit)) return hit;
  }
  return null;
}

/**
 * Spotify renamed "add tracks" to "add items". Apps created since then get a 403 on the old path, so try the new one
 * first and keep the old one for apps that still have it. Confirmed against the live API: /items 201, /tracks 403.
 */
async function addItems(playlistId, uris, fetchImpl) {
  try {
    return await api('POST', `/playlists/${playlistId}/items`, { uris }, fetchImpl);
  } catch (err) {
    if (![403, 404, 405].includes(err.status)) throw err;
    return api('POST', `/playlists/${playlistId}/tracks`, { uris }, fetchImpl);
  }
}

/**
 * Create a public playlist from the tracks Spotify can actually find.
 * @param {{ name: string, description?: string, tracks: Array<{ title: string, artist: string }> }} input
 * @returns {Promise<{ id: string, url: string, tracks: Array<{ title: string, artist: string, url: string|null }>, missing: Array<{ title: string, artist: string }> }>}
 */
export async function createPlaylist({ name, description = '', tracks }, fetchImpl = fetch) {
  if (!spotifyReady()) throw new SpotifyError('Spotify is not connected.');
  const looked = await Promise.all(tracks.map((t) => findTrack(t, fetchImpl).catch(() => null)));
  const found = [], missing = [], seen = new Set();
  looked.forEach((hit, i) => {
    if (!hit) missing.push(tracks[i]);
    else if (!seen.has(hit.uri)) { seen.add(hit.uri); found.push(hit); }
  });
  if (found.length < 3) throw new SpotifyError(`Spotify only recognised ${found.length} of those tracks.`);
  const playlist = await api('POST', '/me/playlists', { name: name.slice(0, 100), description: description.slice(0, 280), public: true }, fetchImpl);
  await addItems(playlist.id, found.map((t) => t.uri), fetchImpl);
  return { id: playlist.id, url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`, tracks: found.map(({ title, artist, url }) => ({ title, artist, url })), missing };
}

/** For tests. */
export function _resetTokenCache() { cached = { token: '', expiresAt: 0 }; refreshing = null; }
