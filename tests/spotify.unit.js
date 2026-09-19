/** Offline tests for real Spotify playlists (agent/spotify.js), the playlist tool's two modes, and the .env writer. Spotify is a stub. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetTokenCache, authorizeUrl, createPlaylist, exchangeCode, redirectUri, sameTrack, spotifyReady } from '../agent/spotify.js';
import { runExtra } from '../agent/extras.js';
import { getPage, renderPage } from '../agent/eventpage.js';
import { saveDotEnvValue } from '../agent/env.js';

const CATALOGUE = { 'le freak': ['spotify:track:1', 'Le Freak', 'CHIC'], 'september': ['spotify:track:2', 'September', 'Earth, Wind & Fire'], 'good times': ['spotify:track:3', 'Good Times', 'CHIC'], 'get lucky': ['spotify:track:4', 'Get Lucky (feat. Pharrell Williams)', 'Daft Punk'] };

function fakeSpotify({ itemsPath = '/v1/playlists/pl123/items' } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname, auth: init.headers?.Authorization, body: init.body });
    if (u.pathname === '/api/token') return json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-new' });
    if (u.pathname === '/v1/search') {
      const q = u.searchParams.get('q').toLowerCase();
      const hit = Object.entries(CATALOGUE).find(([key]) => q.includes(key));
      return json({ tracks: { items: hit ? [{ uri: hit[1][0], name: hit[1][1], artists: [{ name: hit[1][2] }], external_urls: { spotify: `https://open.spotify.com/track/${hit[1][0].split(':')[2]}` } }] : [] } });
    }
    if (u.pathname === '/v1/me/playlists') return json({ id: 'pl123', external_urls: { spotify: 'https://open.spotify.com/playlist/pl123' } }, 201);
    if (u.pathname === itemsPath) return json({ snapshot_id: 's' }, 201);
    if (/^\/v1\/playlists\/pl123\/(items|tracks)$/.test(u.pathname)) return json({ error: { status: 403, message: 'Forbidden' } }, 403);
    return json({ error: { message: 'unexpected' } }, 404);
  };
  return { fetchImpl, calls };
}
const connect = () => { process.env.SPOTIFY_CLIENT_ID = 'cid'; process.env.SPOTIFY_CLIENT_SECRET = 'csecret'; process.env.SPOTIFY_REFRESH_TOKEN = 'refresh-1'; _resetTokenCache(); };
const disconnect = () => { for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN']) delete process.env[k]; _resetTokenCache(); };
const TRACKS = [{ title: 'Le Freak', artist: 'Chic' }, { title: 'September', artist: 'Earth, Wind and Fire' }, { title: 'Good Times', artist: 'Chic' }, { title: 'Totally Made Up Song', artist: 'Nobody Real' }, { title: 'Get Lucky', artist: 'Daft Punk' }, { title: 'le freak', artist: 'chic' }];

test('a playlist holds only tracks Spotify found, once each, and reports the rest as missing', async () => {
  connect();
  const spotify = fakeSpotify();
  const made = await createPlaylist({ name: "Maya's 30th playlist", description: 'disco', tracks: TRACKS }, spotify.fetchImpl);
  assert.equal(made.url, 'https://open.spotify.com/playlist/pl123');
  assert.deepEqual(made.tracks.map((t) => t.title), ['Le Freak', 'September', 'Good Times', 'Get Lucky (feat. Pharrell Williams)'], "Spotify's own titles, de-duplicated");
  assert.deepEqual(made.missing, [{ title: 'Totally Made Up Song', artist: 'Nobody Real' }]);
  const add = spotify.calls.find((c) => c.path === '/v1/playlists/pl123/items');
  assert.ok(!spotify.calls.some((c) => c.path.endsWith('/tracks')), 'the old path is not touched when the new one works');
  assert.deepEqual(JSON.parse(add.body).uris, ['spotify:track:1', 'spotify:track:2', 'spotify:track:3', 'spotify:track:4']);
  assert.deepEqual(JSON.parse(spotify.calls.find((c) => c.path === '/v1/me/playlists').body), { name: "Maya's 30th playlist", description: 'disco', public: true });
  assert.equal(spotify.calls.filter((c) => c.path === '/api/token').length, 1, 'one token refresh, then cached');
  assert.equal(spotify.calls.find((c) => c.path === '/api/token').auth, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  disconnect();
});

test('too few real tracks means no playlist is created at all', async () => {
  connect();
  const spotify = fakeSpotify();
  await assert.rejects(createPlaylist({ name: 'x', tracks: [{ title: 'Nope', artist: 'Nobody' }, { title: 'Le Freak', artist: 'Chic' }] }, spotify.fetchImpl), /only recognised 1/);
  assert.equal(spotify.calls.filter((c) => c.path === '/v1/me/playlists').length, 0);
  disconnect();
  await assert.rejects(createPlaylist({ name: 'x', tracks: TRACKS }, spotify.fetchImpl), /not connected/);
});

test('login: the redirect is the loopback IP, and the code is exchanged for a refresh token', async () => {
  connect();
  assert.equal(redirectUri(8787), 'http://127.0.0.1:8787/spotify/callback');
  const url = new URL(authorizeUrl(8787, 'state-1'));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.deepEqual([url.searchParams.get('client_id'), url.searchParams.get('redirect_uri'), url.searchParams.get('state'), url.searchParams.get('scope')], ['cid', 'http://127.0.0.1:8787/spotify/callback', 'state-1', 'playlist-modify-public playlist-modify-private']);
  const spotify = fakeSpotify();
  assert.equal(await exchangeCode('the-code', 8787, spotify.fetchImpl), 'refresh-new');
  assert.match(spotify.calls[0].body.toString(), /grant_type=authorization_code&code=the-code/);
  disconnect();
  assert.equal(spotifyReady(), false);
});

test('the playlist tool: a real playlist when connected, honest track links when not or when Spotify fails', async () => {
  const ctx = (spotify) => ({ state: { seen: {}, typed: {} }, turn: { chatId: 't', writes: [] }, runTool: async () => ({}), spotify });
  const real = ctx({ ready: () => true, create: async ({ name }) => ({ id: 'pl123', url: 'https://open.spotify.com/playlist/pl123', tracks: [{ title: 'Le Freak', artist: 'CHIC', url: 'https://open.spotify.com/track/1' }, { title: 'September', artist: 'Earth, Wind & Fire', url: null }, { title: 'Good Times', artist: 'CHIC', url: null }], missing: [{ title: 'Made Up', artist: 'Nobody' }], name }) });
  const made = await runExtra('make_playlist', { vibe: 'rooftop disco', tracks: TRACKS }, real);
  assert.equal(made.realSpotifyPlaylist, true);
  assert.deepEqual(made.notOnSpotify, ['Made Up, Nobody']);
  assert.deepEqual(real.turn.links, [{ label: 'Open the playlist on Spotify', url: 'https://open.spotify.com/playlist/pl123' }]);
  const html = renderPage(getPage(real.state.pageId), 'https://x.trycloudflare.com');
  assert.match(html, /open\.spotify\.com\/embed\/playlist\/pl123/);
  assert.match(html, /href="https:\/\/open\.spotify\.com\/track\/1"/, 'a found track links to the track itself');
  assert.ok(!html.includes('Made Up'), 'a track Spotify does not have is not on the page');

  const broken = ctx({ ready: () => true, create: async () => { throw new Error('Spotify POST /me/playlists answered 403: Insufficient client scope'); } });
  const fallback = await runExtra('make_playlist', { vibe: 'disco', tracks: TRACKS }, broken);
  assert.equal(fallback.realSpotifyPlaylist, false);
  assert.match(fallback.spotifyProblem, /403/);
  assert.match(fallback.note, /NOT a playlist in a Spotify account/);
  assert.equal(broken.turn.links[0].label, 'Open the playlist');

  const off = await runExtra('make_playlist', { vibe: 'disco', tracks: TRACKS }, ctx({ ready: () => false, create: async () => { throw new Error('must not be called'); } }));
  assert.equal(off.realSpotifyPlaylist, false);
  assert.equal(off.spotifyProblem, undefined);
});

test('the .env writer adds a key, replaces it in place, and leaves everything else alone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'plec-env-')), '.env');
  writeFileSync(file, '# keys\nLLM_MODEL=gpt-5.5\nSPOTIFY_REFRESH_TOKEN=\nAGENT_PORT=8787');
  saveDotEnvValue(file, 'SPOTIFY_REFRESH_TOKEN', 'tok$1&"quoted"');
  assert.equal(readFileSync(file, 'utf8'), '# keys\nLLM_MODEL=gpt-5.5\nSPOTIFY_REFRESH_TOKEN="tok$1&quoted"\nAGENT_PORT=8787');
  saveDotEnvValue(file, 'NEW_KEY', 'v');
  assert.equal(readFileSync(file, 'utf8'), '# keys\nLLM_MODEL=gpt-5.5\nSPOTIFY_REFRESH_TOKEN="tok$1&quoted"\nAGENT_PORT=8787\nNEW_KEY="v"\n');
});

test('an older Spotify app that only has the /tracks path still gets its playlist', async () => {
  connect();
  const spotify = fakeSpotify({ itemsPath: '/v1/playlists/pl123/tracks' });
  const made = await createPlaylist({ name: 'x', tracks: TRACKS }, spotify.fetchImpl);
  assert.equal(made.tracks.length, 4);
  assert.deepEqual(spotify.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v1/playlists/')).map((c) => c.path), ['/v1/playlists/pl123/items', '/v1/playlists/pl123/tracks']);
  disconnect();
});

test('a search hit only counts when it is the track that was asked for', () => {
  const hit = (title, artist) => ({ title, artist });
  assert.ok(sameTrack({ title: 'Le Freak', artist: 'Chic' }, hit('Le Freak - 2018 Remaster', 'CHIC')));
  assert.ok(sameTrack({ title: 'September', artist: 'Earth, Wind and Fire' }, hit('September', 'Earth, Wind & Fire')));
  assert.ok(sameTrack({ title: 'Get Lucky', artist: 'Daft Punk' }, hit('Get Lucky (feat. Pharrell Williams and Nile Rodgers)', 'Daft Punk, Pharrell Williams, Nile Rodgers')));
  assert.ok(sameTrack({ title: 'Despacito', artist: 'Luis Fonsi' }, hit('Despacito', 'Luis Fonsi, Daddy Yankee')));
  assert.ok(!sameTrack({ title: 'Totally Made Up Song Xyzzy', artist: 'Nobody Real Qwerty' }, hit('Ghetto Cowboy', 'Mo Thugs')), 'seen live before this check existed');
  assert.ok(!sameTrack({ title: 'September', artist: 'Earth, Wind & Fire' }, hit('September', 'Some Cover Band')), 'right title, wrong artist');
});
