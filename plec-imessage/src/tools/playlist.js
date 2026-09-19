/**
 * Group party playlist. After a booking PLEC offers a playlist; once anyone
 * says yes it seeds ~15 songs that fit the plan, then the group builds it by
 * texting ("plec add Espresso", "add some Bad Bunny", "plec no country").
 *
 * Playlist requests are not risky, so there is no organizer confirmation.
 * Clear requests are handled in code from the debounced batch (pipeline/index.js),
 * so three adds in a burst get ONE confirmation; fuzzier asks go through the
 * responder, which has the same functions as tools.
 *
 * One Spotify account owns the playlist (integrations/spotify.js). No Spotify
 * (no creds, no login, or an API error)? Same chat behavior, the playlist lives
 * only in our state, and songs get open.spotify.com/search links.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { forcedToolCall } from '../llm.js';
import { save } from '../store/state.js';
import { emit } from '../bus.js';
import { log } from '../log.js';
import { spotifyConnected, createPlaylist, searchTracks, addItems, removeItems } from '../integrations/spotify.js';

const OFFER_WINDOW_MS = 48 * 60 * 60 * 1000;
const CLARIFY_WINDOW_MS = 10 * 60 * 1000;
const SEED_COUNT = 15;
const EST_TRACK_MS = 210_000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const GENRES = /^(country|rap|hip ?hop|trap|drill|edm|techno|house|dubstep|metal|heavy metal|jazz|classical|opera|reggaeton|latin|k-?pop|emo|punk|rock|folk|christmas|holiday|polka|gospel|r&b|rnb|disco|indie|sad songs?|slow songs?|ballads?|screamo|musicals?|broadway|kids songs?)$/i;
// Versions nobody asked for. Only skipped when the request doesn't mention them.
const BAD_VERSION = /karaoke|\bcover\b|tribute|sped ?up|slowed|instrumental|nightcore|8-?bit|lullaby|\bremix\b|- live\b|\(live\b|live (at|from)\b|acoustic|made famous|in the style of|originally performed/i;
const BAD_ARTIST = /karaoke|tribute|cover band|party hits|kids|lullaby|workout|the hit crew|vitamin string/i;

// ---------------------------------------------------------------- small helpers

const firstName = (s) => String(s || '').trim().split(/\s+/)[0];
const norm = (s) => String(s || '').toLowerCase()
  .replace(/\s*[([](feat|ft|with|from)\.?[^)\]]*[)\]]/g, '')
  .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo).*$/g, '')
  .replace(/&/g, 'and').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const searchLink = (title, artist) => `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`.trim())}`;
const songKey = (s) => s.uri || `${norm(s.title)}|${norm(s.artist.split(',')[0])}`;
const fmtLen = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };

const isLive = (chat) => !!chat.playlist?.id;
const activeBooking = (chat) => [...chat.bookings].reverse().find((b) => b.status !== 'cancelled');
const hasDj = (chat) => (activeBooking(chat)?.services || []).some((s) => /^dj/.test(s));

export const playlistOfferOpen = (chat) => !isLive(chat) && !!chat.playlist?.offeredAt && Date.now() - chat.playlist.offeredAt < OFFER_WINDOW_MS;

function artistVetoed(chat, artist) {
  const a = norm(artist);
  return (chat.playlist?.vetoes || []).find((v) => v.kind === 'artist' && a.includes(norm(v.value)));
}
function genreVetoed(chat, genre) {
  const g = norm(genre);
  return g && (chat.playlist?.vetoes || []).find((v) => v.kind === 'genre' && (g.includes(norm(v.value)) || norm(v.value).includes(g)));
}
const vetoOf = (chat, s) => artistVetoed(chat, s.artist) || genreVetoed(chat, s.genre);

/** "Sofia loves 2000s pop" -> "2000s pop", so the offer can show we listened. */
function musicClue(chat) {
  const re = /\b(?:loves?|obsessed with|is (?:really )?into|favou?rite (?:artist|band|singer|song) is)\s+([^.!?\n]{3,40}?(?:pop|rock|music|songs?|r&b|hip ?hop|rap|country|jazz|disco|reggaeton|swift|beyonc[eé]|abba|bad bunny|\d0s)(?:\s+music)?)/i;
  for (const m of [...chat.transcript].reverse()) {
    if (m.from === 'agent') continue;
    const hit = String(m.text || '').match(re);
    if (hit) return hit[1].trim();
  }
  return '';
}

/** Title + description that are safe if the guest of honor sees them on a friend's profile. */
function playlistName(chat) {
  const b = activeBooking(chat);
  const plan = chat.plan;
  if (plan.isSurprise) {
    const day = b?.date ? DAYS[new Date(`${b.date}T12:00:00Z`).getUTCDay()] : 'Friday';
    return { name: `${day} night 🎶`, description: 'party playlist, made with the group chat 🎶' };
  }
  const what = String(plan.eventType || 'party').replace(/\s+birthday$/i, '');
  return { name: plan.guestOfHonor ? `${firstName(plan.guestOfHonor)}'s ${what} 🎉` : `${what.charAt(0).toUpperCase()}${what.slice(1)} 🎉`, description: 'built by the group chat with PLEC 🎶' };
}

export function publicPlaylist(chat) {
  const p = chat.playlist || {};
  return {
    name: p.name, url: p.url, fallback: !!p.fallback, status: isLive(chat) ? 'live' : p.offeredAt ? 'offered' : 'none',
    songs: (p.songs || []).map(({ title, artist, addedBy, addedAt, durationMs, url }) => ({ title, artist, addedBy, addedAt, durationMs, url })),
    vetoes: (p.vetoes || []).map((v) => v.value),
  };
}
const emitPlaylist = (chat) => emit('playlist', chat.chatId, { playlist: publicPlaylist(chat) });

/** One line for the responder's context. */
export function playlistContext(chat) {
  const p = chat.playlist;
  if (!p?.offeredAt && !p?.id) return '';
  if (!isLive(chat)) return 'PLAYLIST: offered, nobody said yes yet (anyone saying yes creates it: call create_party_playlist).';
  const last = p.songs.slice(-5).map((s) => `${s.title} by ${s.artist} (${s.addedBy})`).join('; ');
  return `PLAYLIST: "${p.name}" ${p.url}${p.fallback ? ' (fallback mode: search links)' : ''}, ${p.songs.length} songs. last added: ${last || 'none'}. vetoes: ${p.vetoes.map((v) => v.value).join(', ') || 'none'}`;
}

// ---------------------------------------------------------------- Spotify or fallback

function toFallback(chat, why) {
  if (chat.playlist.fallback) return;
  chat.playlist.fallback = true;
  log('🎶', chat.chatId, `Spotify not connected, running playlist in fallback mode. (${why})`);
}

const useSpotify = (chat) => !chat.playlist?.fallback && spotifyConnected();

/** Deterministic score of a search result against what we want. -1 = never pick. */
function score(song, want, requestText = '') {
  const allowOdd = BAD_VERSION.test(requestText);
  if (!allowOdd && (BAD_VERSION.test(song.title) || BAD_ARTIST.test(song.artist) || /karaoke|tribute|cover/i.test(song.album))) return -1;
  let s = 0;
  const t = norm(song.title);
  const w = norm(want.title);
  if (w) s += t === w ? 3 : t.startsWith(w) || w.startsWith(t) ? 2 : -3;
  const wa = norm(String(want.artist || '').split(/,| and | & /)[0]);
  if (wa) s += norm(song.artist).includes(wa) ? 3 : -3;
  if (song.albumType === 'compilation') s -= 1;
  return s;
}

async function spotifyCandidates(want, requestText) {
  const q = [want.title && `track:${want.title}`, want.artist && `artist:${want.artist}`].filter(Boolean).join(' ');
  let results = await searchTracks(q);
  if (!results.length) results = await searchTracks(`${want.title || ''} ${want.artist || ''}`.trim());
  return results
    .map((song) => ({ song, s: score(song, want, requestText) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s);
}

/** Resolve one {title, artist} to a playable song, or null. `confidentOnly` for seeds (no model pick). */
async function matchSong(chat, want, requestText, { confidentOnly = false } = {}) {
  if (!useSpotify(chat)) {
    if (!want.title || !want.artist) return { pick: null, candidates: [] };
    return { pick: { uri: null, title: want.title, artist: want.artist, durationMs: 0, url: searchLink(want.title, want.artist) } };
  }
  const ranked = await spotifyCandidates(want, requestText);
  const top = ranked[0];
  if (top && top.s >= (want.artist ? 5 : 3) && (!ranked[1] || want.artist || ranked[1].s < top.s)) return { pick: top.song };
  return { pick: null, candidates: confidentOnly ? [] : ranked.map((x) => x.song) };
}

// ---------------------------------------------------------------- model steps (MODEL_FAST / MODEL_SMART)

const NORMALIZE_TOOL = {
  type: 'function',
  function: {
    name: 'resolve_requests',
    description: 'Turn each playlist request into real released songs.',
    parameters: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              i: { type: 'integer' },
              kind: { type: 'string', enum: ['track', 'artist', 'unknown'] },
              songs: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' }, genre: { type: 'string' } }, required: ['title', 'artist'] } },
              question: { type: 'string', description: 'ONLY if the request could mean clearly different songs: one short question, e.g. "the Taylor Swift one or the remix?"' },
              options: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' } }, required: ['title', 'artist'] } },
            },
            required: ['i', 'kind'],
          },
        },
      },
      required: ['results'],
    },
  },
};

async function normalizeRequests(chat, requests) {
  const vetoes = (chat.playlist?.vetoes || []).map((v) => v.value).join(', ') || 'none';
  const list = requests.map((r, i) => `${i}. ${r.requestedBy}: "${r.text}"`).join('\n');
  try {
    const out = await forcedToolCall([
      { role: 'system', content: `You resolve party playlist requests from a group chat into real, released songs. For each request:
- A song ("Espresso", "put on mr brightside"): kind "track", one song with its main original artist, correct official title.
- An artist ("some Bad Bunny", "anything by ABBA"): kind "artist", their 2 best-known party-friendly songs.
- If the title could mean clearly different songs by different big artists, set question (short, casual) and 2-3 options instead of songs.
- If you don't recognize it as a real song or artist: kind "unknown", no songs. Never guess.
- genre: one or two lowercase words (e.g. "pop", "country", "reggaeton", "hip hop").
Vetoed by the group: ${vetoes}. Never output lyrics.` },
      { role: 'user', content: list },
    ], NORMALIZE_TOOL, { model: config.llm.modelFast, label: 'playlist:resolve' });
    return requests.map((_, i) => (out.results || []).find((r) => r.i === i) || { i, kind: 'unknown' });
  } catch (err) {
    log('⚠️', chat.chatId, `playlist resolve fell back to text parsing: ${err.message}`);
    return requests.map((r, i) => {
      const p = parseTarget(r.text);
      return p.kind === 'artist' ? { i, kind: 'artist', artistOnly: p.artist, songs: [] } : { i, kind: 'track', songs: [{ title: p.title, artist: p.artist }] };
    });
  }
}

const PICK_TOOL = {
  type: 'function',
  function: {
    name: 'pick_tracks',
    description: 'Pick the search result that matches each request.',
    parameters: {
      type: 'object',
      properties: { picks: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, n: { type: ['integer', 'null'], description: 'result number, or null if none match' } }, required: ['i'] } } },
      required: ['picks'],
    },
  },
};

/** MODEL_FAST chooses among <=10 Spotify results. Prefer the original studio version by the main artist; null over a guess. */
async function pickFromCandidates(chat, jobs) {
  if (!jobs.length) return [];
  const body = jobs.map((j, i) => `${i}. request: "${j.requestText}" (wanted: ${j.want.title || '?'} by ${j.want.artist || '?'})\n${j.candidates.map((c, n) => `   ${n}: ${c.title} | ${c.artist} | album: ${c.album} (${c.albumType})`).join('\n')}`).join('\n');
  try {
    const out = await forcedToolCall([
      { role: 'system', content: 'For each request pick the result that is the original studio version by the main artist. Avoid karaoke, covers, sped up, slowed, instrumentals, live, remixes and tribute acts unless the request asked for one. If no result is the requested song, n = null. Never pick a random close-ish song.' },
      { role: 'user', content: body },
    ], PICK_TOOL, { model: config.llm.modelFast, label: 'playlist:pick' });
    return jobs.map((j, i) => {
      const n = (out.picks || []).find((p) => p.i === i)?.n;
      return Number.isInteger(n) ? j.candidates[n] || null : null;
    });
  } catch (err) {
    log('⚠️', chat.chatId, `playlist pick failed, skipping unclear matches: ${err.message}`);
    return jobs.map(() => null);
  }
}

const SEED_TOOL = {
  type: 'function',
  function: {
    name: 'seed_playlist',
    description: 'About 20 songs for this party, in party order.',
    parameters: {
      type: 'object',
      properties: {
        songs: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' }, genre: { type: 'string' }, phase: { type: 'string', enum: ['arrival', 'peak', 'singalong'] } }, required: ['title', 'artist', 'phase'] } },
      },
      required: ['songs'],
    },
  },
};

// Used only if the model is unreachable, so seeding never blocks the demo.
const DEFAULT_SEEDS = [
  ['Electric Feel', 'MGMT', 'indie', 'arrival'], ['Put Your Records On', 'Corinne Bailey Rae', 'soul', 'arrival'], ['Redbone', 'Childish Gambino', 'r&b', 'arrival'],
  ['Levitating', 'Dua Lipa', 'pop', 'arrival'], ['September', 'Earth, Wind & Fire', 'funk', 'arrival'],
  ['Uptown Funk', 'Mark Ronson', 'funk', 'peak'], ['Toxic', 'Britney Spears', 'pop', 'peak'], ['Hey Ya!', 'Outkast', 'hip hop', 'peak'],
  ['Yeah!', 'Usher', 'r&b', 'peak'], ['Crazy In Love', 'Beyoncé', 'r&b', 'peak'], ['Titi Me Pregunto', 'Bad Bunny', 'reggaeton', 'peak'],
  ['Espresso', 'Sabrina Carpenter', 'pop', 'peak'], ['Blinding Lights', 'The Weeknd', 'pop', 'peak'], ['Dancing Queen', 'ABBA', 'disco', 'peak'],
  ['I Wanna Dance with Somebody (Who Loves Me)', 'Whitney Houston', 'pop', 'peak'], ['Mr. Brightside', 'The Killers', 'rock', 'singalong'],
  ["Don't Stop Believin'", 'Journey', 'rock', 'singalong'], ['Livin\' on a Prayer', 'Bon Jovi', 'rock', 'singalong'],
].map(([title, artist, genre, phase]) => ({ title, artist, genre, phase }));

async function suggestSeeds(chat) {
  const plan = chat.plan;
  const clues = chat.transcript.filter((m) => m.from !== 'agent' && /music|song|playlist|danc|pop|rock|rap|country|jazz|artist|band|singer|dj|\d0s|loves?/i.test(m.text || '')).slice(-15).map((m) => `${m.fromName}: ${m.text}`);
  const vetoes = (chat.playlist?.vetoes || []).map((v) => v.value);
  try {
    const out = await forcedToolCall([
      { role: 'system', content: `You pick the opening songs for a group party playlist. Suggest about 20 real, released, well-known songs (exact official titles, main artist). Fit the plan: event, the guest of honor's tastes, the group's age, the vibe (if people want to dance, lean danceable). Mix decades in a way that fits this group. Put them in party order: chill arrivals first (phase "arrival"), the dance peak in the middle ("peak"), then 1-2 big singalongs at the end ("singalong"). Never include anything vetoed: ${vetoes.join(', ') || 'none'}. Titles only, never lyrics.` },
      { role: 'user', content: `PLAN: ${JSON.stringify({ eventType: plan.eventType, guestOfHonor: plan.guestOfHonor, vibe: plan.vibe, personConstraints: plan.personConstraints, headcount: plan.headcount?.value })}\nMUSIC CLUES FROM THE CHAT:\n${clues.join('\n') || 'none'}` },
    ], SEED_TOOL, { model: config.llm.modelSmart, label: 'playlist:seed' });
    if (Array.isArray(out.songs) && out.songs.length >= 8) return out.songs;
    throw new Error('too few seed songs');
  } catch (err) {
    log('⚠️', chat.chatId, `seed suggestions fell back to defaults: ${err.message}`);
    return DEFAULT_SEEDS;
  }
}

// ---------------------------------------------------------------- parsing chat text

const ADDRESSED = new RegExp(`^\\s*@?(plec|${config.agentName.toLowerCase()})\\b[\\s,:!-]*`, 'i');
const strip = (text) => String(text || '').replace(ADDRESSED, '').trim();

/** "some Bad Bunny" -> artist; "Espresso by Sabrina Carpenter" -> track + artist. */
function parseTarget(raw) {
  const t = String(raw).replace(/\s+(to|on|onto|in) (the |our |that )?(playlist|list|queue|party playlist)\b.*$/i, '')
    .replace(/[.!?\s🎶🎵🔥💃]+$/u, '').replace(/^["'“”]+|["'“”]+$/g, '').trim();
  let m = t.match(/^(?:some|something by|anything by|a (?:few|couple)(?: of)?|more|a little(?: bit of)?)\s+(.+?)(?:\s+songs?)?$/i);
  if (m) return { kind: 'artist', artist: m[1].trim() };
  if ((m = t.match(/^(.+?)\s+songs?$/i))) return { kind: 'artist', artist: m[1].trim() };
  if ((m = t.match(/^(.+?)\s+by\s+(.+)$/i))) return { kind: 'track', title: m[1].trim(), artist: m[2].trim() };
  return { kind: 'track', title: t, artist: '' };
}

const YESISH = /^(y+e+s+|y+e+a+h*|yep|yup|ya+s+|sure|ok(ay)?|down|do it|let'?s do it|absolutely|100|please|pls|omg yes|obviously|duh|hell yes|of course|💯|🙌|🎶)\b/i;
const ADD_RE = /^(?:(?:can|could) (?:you|we|u) (?:please |pls )?)?(?:add|put on|queue(?: up)?|throw on|play|get)\s+(.+)$/i;
const NO_ADDRESS_ADD_RE = /^(?:add|put on|queue(?: up)?|throw on)\s+(?!me\b|him\b|her\b|them\b|us\b|you\b|\d)(.+)$/i;

/**
 * What a message means for the playlist, or null.
 * @returns {null | { kind: 'accept'|'add'|'remove'|'veto'|'summary'|'clarify', text?: string, target?: string }}
 */
export function classifyPlaylistMessage(chat, message) {
  const raw = String(message.text || '').trim();
  if (!raw || message.from === 'agent') return null;
  const addressed = ADDRESSED.test(raw);
  const body = strip(raw);
  const lower = body.toLowerCase();

  if (playlistOfferOpen(chat)) {
    if (/playlist/.test(lower) && /(yes|yeah|ya|sure|pls|please|start|make|do|down|want|love|obviously)/.test(lower) && !/\bno\b|nah|don'?t|not\b/.test(lower)) return { kind: 'accept' };
    // A bare "yesss" only counts right after the offer (PLEC's last message was the offer).
    const lastAgent = chat.transcript.findLast((t) => t.from === 'agent');
    if (lower.length <= 30 && YESISH.test(lower) && /playlist/i.test(lastAgent?.text || '') && Date.now() - chat.playlist.offeredAt < 30 * 60 * 1000) return { kind: 'accept' };
    return null;
  }
  if (!isLive(chat)) return null;

  if (/^(?:what'?s|whats|what is) on (?:the |our )?playlist|^(?:show|send)(?: me| us)? (?:the )?playlist|^playlist\??$/.test(lower)) return { kind: 'summary' };
  let m = lower.match(/^(?:remove|delete|take off|skip|drop|cut|nix)\s+(.+)$/);
  if (m && (addressed || /^(that|it|the last one|last one|last song|that one)\b/.test(m[1]))) return { kind: 'remove', target: body.slice(body.length - m[1].length) };
  if (addressed && (m = body.match(/^(?:no more|no|nothing|ban|veto|block|please no|pls no)\s+(.+?)[.!\s]*$/i)) && m[1].length <= 40) return { kind: 'veto', target: m[1] };
  if ((m = body.match(addressed ? ADD_RE : NO_ADDRESS_ADD_RE))) return { kind: 'add', text: m[1] };

  const c = chat.playlist.clarify;
  if (c && Date.now() - c.at < CLARIFY_WINDOW_MS && firstName(c.requestedBy) === firstName(message.fromName) && lower.length <= 50) return { kind: 'clarify', text: body };
  return null;
}

export const isPlaylistMessage = (chat, message) => !!classifyPlaylistMessage(chat, message);

// ---------------------------------------------------------------- offer + create

/** Line appended to the booking confirmation. */
export function offerPlaylist(chat) {
  chat.playlist ||= {};
  if (isLive(chat)) return '';
  chat.playlist.offeredAt = Date.now();
  save();
  emitPlaylist(chat);
  const goh = chat.plan.guestOfHonor ? firstName(chat.plan.guestOfHonor) : '';
  const clue = musicClue(chat);
  const dj = hasDj(chat) ? " and I'll hand it to the DJ" : '';
  return `want a party playlist? I'll start one based on what ${goh || 'you all'} ${goh ? 'loves' : 'love'}${clue ? ` (${clue} 👀)` : ''}. just text me songs to add${dj} 🎶`;
}

/** Tool + "yes" path: create, seed, store. Returns data; never sends. */
export async function createPartyPlaylist(chat) {
  chat.playlist ||= {};
  const p = chat.playlist;
  if (isLive(chat)) return { ok: true, already: true, url: p.url, name: p.name, count: p.songs.length };
  const { name, description } = playlistName(chat);
  Object.assign(p, { name, songs: [], vetoes: p.vetoes || [], fallback: false, createdAt: Date.now() });
  if (!spotifyConnected()) toFallback(chat, 'no credentials or /spotify/login not done');

  const seeds = await suggestSeeds(chat);
  const order = { arrival: 0, peak: 1, singalong: 2 };
  const ordered = seeds.map((s, i) => ({ ...s, i })).sort((a, b) => (order[a.phase] ?? 1) - (order[b.phase] ?? 1) || a.i - b.i);

  const picked = [];
  for (let i = 0; i < ordered.length && picked.length < SEED_COUNT; i += 5) {
    const chunk = ordered.slice(i, i + 5).filter((s) => !vetoOf(chat, s));
    const results = await Promise.all(chunk.map((s) => matchSong(chat, s, '', { confidentOnly: true }).catch((err) => {
      if (err.name === 'SpotifyError') toFallback(chat, `search failed: ${err.message}`);
      return { pick: null };
    })));
    chunk.forEach((s, k) => {
      const pick = results[k].pick;
      if (pick && picked.length < SEED_COUNT && !picked.some((x) => songKey(x) === songKey(pick))) picked.push({ ...pick, genre: s.genre || '', addedBy: 'PLEC', addedAt: Date.now() });
    });
    if (p.fallback && picked.some((x) => x.uri)) break; // switched mid-way: restart below without Spotify
  }
  if (p.fallback && picked.some((x) => x.uri)) {
    picked.length = 0;
    for (const s of ordered.filter((x) => !vetoOf(chat, x)).slice(0, SEED_COUNT)) picked.push({ uri: null, title: s.title, artist: s.artist, durationMs: 0, url: searchLink(s.title, s.artist), genre: s.genre || '', addedBy: 'PLEC', addedAt: Date.now() });
  }

  if (!p.fallback) {
    try {
      const created = await createPlaylist(name, description);
      p.id = created.id;
      p.url = created.url;
      await addItems(p.id, picked.map((s) => s.uri));
    } catch (err) {
      toFallback(chat, `create/add failed: ${err.message}`);
      p.id = undefined;
      for (const s of picked) Object.assign(s, { uri: null, url: searchLink(s.title, s.artist) });
    }
  }
  if (p.fallback) {
    p.id = `local-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    p.url = `${config.publicBaseUrl.replace(/\/+$/, '')}/playlist/${p.id}`;
  }
  p.songs = picked;
  save();
  emitPlaylist(chat);
  log('🎶', chat.chatId, `playlist "${name}" created (${picked.length} seeds${p.fallback ? ', fallback' : ''})`);
  return { ok: true, url: p.url, name, fallback: p.fallback, count: picked.length, seeds: picked.map((s) => `${s.title} by ${s.artist}`) };
}

function createdBubbles(chat, r) {
  const p = chat.playlist;
  const goh = chat.plan.guestOfHonor ? firstName(chat.plan.guestOfHonor) : '';
  const occasion = goh ? `${goh}'s ${String(chat.plan.eventType || 'party').replace(/\s+birthday$/i, '')}` : 'the party';
  const safe = chat.plan.isSurprise && goh ? ` (it's called "${p.name}" so ${goh} can't spot it 🤫)` : '';
  return [
    `here's the start for ${occasion}${safe}: ${r.url}`,
    `${r.count} songs: chill arrivals, dance peak, singalongs at the end. text me songs to add anytime, like "plec add Espresso" 🎶`,
  ];
}

// ---------------------------------------------------------------- add / remove / veto / summary

/**
 * Tool + batch path. requests: [{ text, requestedBy }].
 * Returns { added: [{title, artist, requestedBy}], ambiguous: [{requestedBy, question}], notFound: [{text, requestedBy}], duplicates, vetoed }.
 */
export async function addSongs(chat, { requests = [] } = {}) {
  if (!isLive(chat)) return { error: 'no_playlist', message: 'no playlist yet: call create_party_playlist first (someone has to say yes)' };
  const reqs = requests.filter((r) => r?.text).map((r) => ({ text: String(r.text), requestedBy: firstName(r.requestedBy) || 'someone' }));
  const out = { added: [], ambiguous: [], notFound: [], duplicates: [], vetoed: [] };
  if (!reqs.length) return out;
  const p = chat.playlist;
  const resolved = await normalizeRequests(chat, reqs);

  const wants = [];   // { req, want: {title, artist, genre} }
  const pickJobs = []; // needs MODEL_FAST choice
  for (const [i, r] of resolved.entries()) {
    const req = reqs[i];
    if (r.question && r.options?.length >= 2) {
      p.clarify = { requestedBy: req.requestedBy, text: req.text, options: r.options.slice(0, 3), at: Date.now() };
      out.ambiguous.push({ requestedBy: req.requestedBy, question: r.question });
      continue;
    }
    if (r.kind === 'artist' && r.artistOnly && useSpotify(chat)) {
      // Model unreachable: search the artist, let the ranking keep clean tracks by them.
      const ranked = await spotifyCandidates({ artist: r.artistOnly }, req.text).catch(() => []);
      const two = ranked.filter((x) => x.s >= 3).slice(0, 2).map((x) => x.song);
      if (!two.length) out.notFound.push(req);
      for (const s of two) wants.push({ req, song: s });
      continue;
    }
    const songs = (r.songs || []).filter((s) => s?.title).slice(0, r.kind === 'artist' ? 2 : 1);
    if (r.kind === 'unknown' || !songs.length) {
      // The model may not know a new release; Spotify might.
      if (useSpotify(chat)) {
        const t = parseTarget(req.text);
        songs.push({ title: t.title || '', artist: t.artist || '', unknown: true });
      } else { out.notFound.push(req); continue; }
    }
    for (const s of songs) wants.push({ req, want: s });
  }

  const matched = []; // { req, song, genre }
  for (const w of wants) {
    if (w.song) { matched.push({ req: w.req, song: w.song, genre: '' }); continue; }
    try {
      const { pick, candidates } = await matchSong(chat, w.want, w.req.text);
      if (pick) matched.push({ req: w.req, song: pick, genre: w.want.genre || '' });
      else if (candidates?.length) pickJobs.push({ ...w, requestText: w.req.text, candidates });
      else out.notFound.push(w.req);
    } catch (err) {
      if (err.name !== 'SpotifyError') throw err;
      toFallback(chat, `search failed: ${err.message}`);
      if (w.want.title && w.want.artist && !w.want.unknown) matched.push({ req: w.req, song: { uri: null, title: w.want.title, artist: w.want.artist, durationMs: 0, url: searchLink(w.want.title, w.want.artist) }, genre: w.want.genre || '' });
      else out.notFound.push(w.req);
    }
  }
  const picks = await pickFromCandidates(chat, pickJobs);
  pickJobs.forEach((j, k) => (picks[k] ? matched.push({ req: j.req, song: picks[k], genre: j.want.genre || '' }) : out.notFound.push(j.req)));

  const fresh = [];
  const served = new Set(); // requests that got an answer (added, duplicate or vetoed)
  for (const { req, song, genre } of matched) {
    served.add(req);
    const s = { ...song, genre, addedBy: req.requestedBy, addedAt: Date.now() };
    const veto = vetoOf(chat, s);
    if (veto) { out.vetoed.push({ title: s.title, artist: s.artist, veto: veto.value, requestedBy: req.requestedBy }); continue; }
    if ([...p.songs, ...fresh].some((x) => songKey(x) === songKey(s) || (norm(x.title) === norm(s.title) && norm(x.artist) === norm(s.artist)))) { out.duplicates.push({ title: s.title, requestedBy: req.requestedBy }); continue; }
    fresh.push(s);
  }
  if (fresh.length && useSpotify(chat)) {
    try { await addItems(p.id, fresh.map((s) => s.uri)); } catch (err) {
      toFallback(chat, `add failed: ${err.message}`);
      for (const s of fresh) Object.assign(s, { url: searchLink(s.title, s.artist) });
    }
  }
  p.songs.push(...fresh);
  // An artist request can half-fail (one of two songs): only report requests that got nothing.
  out.notFound = [...new Set(out.notFound)].filter((r) => !served.has(r));
  out.added = fresh.map((s) => ({ title: s.title, artist: s.artist, requestedBy: s.addedBy, link: p.fallback ? s.url : undefined }));
  save();
  if (fresh.length) emitPlaylist(chat);
  return out;
}

/** "remove that" (last added), "remove Espresso", or a veto rule ("no country", "no Drake"). */
export async function removeOrVeto(chat, { text = '', requestedBy = '' } = {}) {
  if (!isLive(chat)) return { error: 'no_playlist' };
  const p = chat.playlist;
  const t = String(text).trim().replace(/[.!?]+$/, '');
  const removeMatch = t.match(/^(?:remove|delete|take off|skip|drop|cut|nix)\s+(.+)$/i);
  const vetoMatch = t.match(/^(?:no more|no|nothing|ban|veto|block|please no|pls no)\s+(.+)$/i);
  let removed = [];
  let veto = null;

  if (removeMatch || (!vetoMatch && /^(that|it|the last one|last song|that one)$/i.test(t))) {
    const target = (removeMatch?.[1] || t).replace(/\s+(from|off) (the )?playlist$/i, '').trim();
    if (/^(that|it|the last one|last one|last song|that one)$/i.test(target)) {
      const last = [...p.songs].reverse().find((s) => s.addedBy !== 'PLEC') || p.songs[p.songs.length - 1];
      if (last) removed = [last];
    } else {
      const n = norm(target.replace(/\s+by\s+.+$/i, ''));
      removed = p.songs.filter((s) => norm(s.title) === n || norm(s.title).startsWith(n)).slice(-1);
      if (!removed.length) removed = p.songs.filter((s) => norm(s.artist).includes(n));
    }
  } else if (vetoMatch) {
    const value = vetoMatch[1].replace(/\s+(songs?|music|pls|please|on (the )?playlist)$/i, '').trim();
    const kind = GENRES.test(value) ? 'genre' : 'artist';
    veto = { kind, value: value.toLowerCase(), by: firstName(requestedBy), at: Date.now() };
    if (!p.vetoes.some((v) => v.kind === kind && v.value === veto.value)) p.vetoes.push(veto);
    const g = kind === 'genre' ? norm(value.replace(/s$/, '')) : '';
    removed = p.songs.filter((s) => (kind === 'artist' ? norm(s.artist).includes(norm(value)) : g && norm(s.genre).includes(g)));
  } else {
    return { error: 'unclear', message: 'say "remove <song>", "remove that", or "no <genre/artist>"' };
  }

  if (removed.length && useSpotify(chat)) {
    try { await removeItems(p.id, removed.map((s) => s.uri).filter(Boolean)); } catch (err) { toFallback(chat, `remove failed: ${err.message}`); }
  }
  p.songs = p.songs.filter((s) => !removed.includes(s));
  save();
  emitPlaylist(chat);
  return { ok: true, removed: removed.map((s) => ({ title: s.title, artist: s.artist })), veto: veto ? { kind: veto.kind, value: veto.value } : null };
}

export function getPlaylistSummary(chat) {
  if (!isLive(chat)) return { error: 'no_playlist' };
  const p = chat.playlist;
  const known = p.songs.every((s) => s.durationMs);
  const total = p.songs.reduce((a, s) => a + (s.durationMs || EST_TRACK_MS), 0);
  return {
    name: p.name, url: p.url, count: p.songs.length, length: `${known ? '' : '~'}${fmtLen(total)}`,
    lastAdded: p.songs.slice(-5).reverse().map((s) => ({ title: s.title, artist: s.artist, addedBy: s.addedBy })),
    vetoes: p.vetoes.map((v) => v.value), fallback: !!p.fallback, dj: hasDj(chat),
  };
}

// ---------------------------------------------------------------- templated bubbles (batch path)

function addBubbles(r) {
  const lines = [];
  if (r.added.length === 1) {
    const a = r.added[0];
    lines.push(`added ${a.title} by ${a.artist} for ${a.requestedBy} 🎶${a.link ? `\n${a.link}` : ''}`);
  } else if (r.added.length > 1) {
    // Two songs from one artist request read as "2 Bad Bunny songs (Marcus)".
    const groups = [];
    for (const a of r.added) {
      const g = groups.find((x) => x.requestedBy === a.requestedBy && x.artist === a.artist);
      if (g) g.n += 1; else groups.push({ ...a, n: 1 });
    }
    lines.push(`added ${r.added.length}: ${groups.map((g) => `${g.n > 1 ? `${g.n} ${g.artist} songs` : g.title} (${g.requestedBy})`).join(', ')} 🎶`);
    const links = r.added.filter((a) => a.link).slice(0, 3);
    if (links.length) lines.push(links.map((a) => `${a.title}: ${a.link}`).join('\n'));
  }
  const misc = [];
  for (const d of r.duplicates) misc.push(`${d.title} is already on there 😉`);
  for (const v of r.vetoed) misc.push(`skipped ${v.title} for ${v.requestedBy}, ${v.veto} is vetoed`);
  for (const n of r.notFound) misc.push(`couldn't find "${n.text}" ${n.requestedBy}, who's it by?`);
  for (const q of r.ambiguous) misc.push(`${q.requestedBy}, ${q.question}`);
  if (misc.length) lines.push(misc.join('\n'));
  return lines;
}

function vetoBubble(r) {
  const took = r.removed.length ? ` took off ${r.removed.length === 1 ? r.removed[0].title : `${r.removed.length} (${r.removed.map((s) => s.title).join(', ')})`}` : '';
  if (r.veto) return `no ${r.veto.value}, got it 🚫${took}`;
  return r.removed.length ? `${took.trim()} 👋` : "couldn't find that one on the playlist";
}

function summaryBubbles(s) {
  const last = s.lastAdded.map((x) => `${x.title} (${x.addedBy})`).join('\n');
  return [
    `${s.count} songs, ${s.length} 🎶 ${s.url}${s.vetoes.length ? `\nvetoed: ${s.vetoes.join(', ')}` : ''}`,
    `last added:\n${last}${s.dj ? '\nthe DJ gets this playlist too' : ''}`,
  ];
}

/** The requester answered "the Taylor Swift one or the remix?". */
async function resolveClarify(chat, message, text) {
  const c = chat.playlist.clarify;
  chat.playlist.clarify = undefined;
  const t = text.toLowerCase();
  const ordinal = /\b(first|1st|1|former|og|original)\b/.test(t) ? 0 : /\b(second|2nd|2|latter)\b/.test(t) ? 1 : /\b(third|3rd|3)\b/.test(t) ? 2 : -1;
  let best = ordinal >= 0 ? c.options[ordinal] : null;
  if (!best) {
    const words = new Set(norm(t).split(' ').filter((w) => w.length > 2 && !['the', 'one', 'song', 'that'].includes(w)));
    const scored = c.options.map((o) => ({ o, s: norm(`${o.title} ${o.artist}`).split(' ').filter((w) => words.has(w)).length })).sort((a, b) => b.s - a.s);
    if (scored[0]?.s > 0 && scored[0].s > (scored[1]?.s ?? 0)) best = scored[0].o;
  }
  if (!best) return null;
  return addSongs(chat, { requests: [{ text: `${best.title} by ${best.artist}`, requestedBy: c.requestedBy || message.fromName }] });
}

/**
 * Batch path (called from pipeline/index.js with the debounced burst).
 * Handles the playlist messages, sends ONE combined reply, returns the rest.
 */
export async function handlePlaylistBatch(chat, messages, send) {
  const tagged = messages.map((m) => ({ m, c: classifyPlaylistMessage(chat, m) }));
  const mine = tagged.filter((x) => x.c);
  if (!mine.length) return messages;
  const bubbles = [];

  if (mine.some((x) => x.c.kind === 'accept')) {
    const r = await createPartyPlaylist(chat);
    bubbles.push(...(r.already ? [`it's already going 🎶 ${r.url}`] : createdBubbles(chat, r)));
  }
  const adds = mine.filter((x) => x.c.kind === 'add').map((x) => ({ text: x.c.text, requestedBy: x.m.fromName }));
  const addResult = { added: [], ambiguous: [], notFound: [], duplicates: [], vetoed: [] };
  const merge = (r) => { if (r && !r.error) for (const k of Object.keys(addResult)) addResult[k].push(...(r[k] || [])); };
  for (const x of mine.filter((y) => y.c.kind === 'clarify')) {
    const r = await resolveClarify(chat, x.m, x.c.text);
    if (r) merge(r); else bubbles.push(`sorry ${firstName(x.m.fromName)}, which one? say the artist`);
  }
  if (adds.length) merge(await addSongs(chat, { requests: adds }));
  bubbles.push(...addBubbles(addResult));
  for (const x of mine.filter((y) => ['remove', 'veto'].includes(y.c.kind))) {
    const r = await removeOrVeto(chat, { text: strip(x.m.text), requestedBy: x.m.fromName });
    if (!r.error) bubbles.push(vetoBubble(r));
  }
  if (mine.some((x) => x.c.kind === 'summary')) bubbles.push(...summaryBubbles(getPlaylistSummary(chat)));

  if (bubbles.length) await send(chat, bubbles);
  const handled = new Set(mine.map((x) => x.m));
  return messages.filter((m) => !handled.has(m));
}

/** Fallback page: GET /playlist/local-xxxx (the random id is the gate). */
export function playlistPage(chats, pathname) {
  const m = pathname.match(/^\/playlist\/(local-[a-f0-9]{12})$/);
  const chat = m && chats.find((c) => c.playlist?.id === m[1]);
  if (!chat) return null;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const p = chat.playlist;
  const rows = p.songs.map((s, i) => `<li><a href="${esc(s.url || searchLink(s.title, s.artist))}">${esc(s.title)}</a> <span>${esc(s.artist)}${s.addedBy && s.addedBy !== 'PLEC' ? ` · added by ${esc(s.addedBy)}` : ''}</span></li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;background:#FBF7F2;color:#2B2320}h1{font-size:24px}li{margin:10px 0}a{color:#1DB954;font-weight:600;text-decoration:none}span{color:#8A7F78;font-size:14px}</style>
<h1>${esc(p.name)}</h1><p>${p.songs.length} songs · tap a song to open it in Spotify</p><ol>${rows}</ol>`;
}
