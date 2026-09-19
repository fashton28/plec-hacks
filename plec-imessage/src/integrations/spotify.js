/**
 * Spotify Web API over plain fetch (post-February-2026 rules):
 *   POST /me/playlists, /playlists/{id}/items (not /tracks), search limit <= 10,
 *   no popularity, no recommendations / audio-features.
 * ONE account logs in (the organizer's or a team account): GET /spotify/login
 * once, the callback stores the refresh token in data/spotify-token.json
 * (gitignored) and access tokens refresh automatically after that.
 * Friends never connect Spotify; they text requests and open the link.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, config } from '../config.js';
import { sendJson, sendHtml } from '../server.js';
import { log } from '../log.js';

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const TOKEN_FILE = join(ROOT, 'data', 'spotify-token.json');
const SCOPES = 'playlist-modify-private playlist-modify-public playlist-read-private';

export class SpotifyError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.body = body;
  }
}

const credentials = () => !!(config.spotify.clientId && config.spotify.clientSecret);
const basicAuth = () => `Basic ${Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64')}`;

let stored = null;
function readToken() {
  if (stored) return stored;
  try { stored = existsSync(TOKEN_FILE) ? JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) : null; } catch { stored = null; }
  return stored;
}
function writeToken(t) {
  stored = t;
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 1));
}

/** Credentials present and someone completed /spotify/login. */
export const spotifyConnected = () => credentials() && !!readToken()?.refreshToken;

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new SpotifyError(`spotify token: ${j.error || r.status}${j.error_description ? ` (${j.error_description})` : ''}`, { status: r.status, body: JSON.stringify(j) });
  return j;
}

async function accessToken() {
  const t = readToken();
  if (!t?.refreshToken) throw new SpotifyError('spotify not logged in (open /spotify/login)');
  if (t.accessToken && t.expiresAt > Date.now() + 60_000) return t.accessToken;
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
  // Spotify may rotate the refresh token; keep the old one when it doesn't.
  writeToken({ refreshToken: j.refresh_token || t.refreshToken, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

async function api(method, path, { query, body } = {}) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  if (!r.ok) {
    // Log the exact response: the 2026 rules change often, and a 403 here means "switch to fallback", not "debug".
    log('💥', null, `spotify ${method} ${path} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
    throw new SpotifyError(`spotify ${method} ${path} HTTP ${r.status}`, { status: r.status, body: text });
  }
  return text ? JSON.parse(text) : {};
}

/** Our song shape from a Spotify TrackObject. */
const toSong = (t) => ({
  uri: t.uri,
  title: t.name,
  artist: (t.artists || []).map((a) => a.name).join(', '),
  album: t.album?.name || '',
  albumType: t.album?.album_type || '',
  durationMs: t.duration_ms || 0,
  url: t.external_urls?.spotify || '',
});

export async function createPlaylist(name, description) {
  const p = await api('POST', '/me/playlists', { body: { name, description, public: false } });
  return { id: p.id, url: p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}` };
}

/** Up to 10 tracks (the 2026 max). No popularity: callers rank. */
export async function searchTracks(query) {
  const j = await api('GET', '/search', { query: { q: query, type: 'track', limit: '10' } });
  return (j.tracks?.items || []).filter(Boolean).map(toSong);
}

export async function addItems(playlistId, uris) {
  for (let i = 0; i < uris.length; i += 100) await api('POST', `/playlists/${playlistId}/items`, { body: { uris: uris.slice(i, i + 100) } });
}

export async function removeItems(playlistId, uris) {
  if (!uris.length) return;
  await api('DELETE', `/playlists/${playlistId}/items`, { body: { items: uris.map((uri) => ({ uri })) } });
}

export async function getItems(playlistId) {
  const out = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const j = await api('GET', `/playlists/${playlistId}/items`, { query: { limit: '50', offset: String(offset) } });
    for (const row of j.items || []) {
      const t = row.item || row.track; // "item" is current; "track" is the deprecated duplicate
      if (t?.uri) out.push(toSong(t));
    }
    if (!j.next) break;
  }
  return out;
}

// ---------------------------------------------------------------- one-time login (authorization code flow)

const states = new Set();
const redirectUri = () => config.spotify.redirectUri;

export function registerSpotifyRoutes(router) {
  router.get('/spotify/login', (req, res) => {
    if (!credentials()) return sendJson(res, 400, { error: 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing in plec-imessage/.env' });
    const state = randomUUID();
    states.add(state);
    const q = new URLSearchParams({ response_type: 'code', client_id: config.spotify.clientId, scope: SCOPES, redirect_uri: redirectUri(), state, show_dialog: 'true' });
    res.writeHead(302, { Location: `https://accounts.spotify.com/authorize?${q}`, 'Cache-Control': 'no-store' });
    res.end();
  });
  router.get('/spotify/callback', async (req, res, { query }) => {
    if (query.error) return sendHtml(res, `<p>Spotify said: ${String(query.error).replace(/[<>&]/g, '')}</p>`);
    if (!query.state || !states.delete(query.state)) return sendJson(res, 400, { error: 'bad_state', hint: 'start again at /spotify/login' });
    try {
      const j = await tokenRequest({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri() });
      writeToken({ refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
      log('🎶', null, 'Spotify connected; refresh token saved to data/spotify-token.json');
      sendHtml(res, '<body style="font-family:system-ui;padding:40px"><h2>Spotify connected 🎶</h2><p>You can close this tab. PLEC will build party playlists on this account.</p></body>');
    } catch (err) {
      log('💥', null, `spotify callback failed: ${err.message} ${err.body || ''}`);
      sendHtml(res, `<p>Spotify login failed: ${String(err.message).replace(/[<>&]/g, '')}. Check the redirect URI in the Spotify dashboard matches ${redirectUri()}.</p>`);
    }
  });
}
