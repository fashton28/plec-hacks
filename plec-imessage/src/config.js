/**
 * Env parsing + defaults. Reads plec-imessage/.env (never the repo root one);
 * a real environment variable always wins over the file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(join(ROOT, '.env'));

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const num = (name, fallback) => {
  const v = Number(env(name, ''));
  return Number.isFinite(v) && env(name, '') !== '' ? v : fallback;
};

export const config = {
  port: num('PORT', 8788),
  agentName: env('AGENT_NAME', 'PLEC'),
  agentPhone: env('AGENT_PHONE', '+10000000000'),
  defaultCity: env('DEFAULT_CITY', 'Philadelphia'),
  organizerPhone: env('DEMO_ORGANIZER_PHONE', ''),
  organizerEmail: env('ORGANIZER_EMAIL', ''),
  debounceMs: num('DEBOUNCE_MS', 6000),
  debounceMentionMs: num('DEBOUNCE_MENTION_MS', 2000),
  demoToday: env('DEMO_TODAY', ''),
  llm: {
    baseUrl: env('LLM_BASE_URL', 'https://api.plec.ai/hackathon/llm/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY', ''),
    modelSmart: env('MODEL_SMART', 'kimi-k2.7-code-highspeed'),
    modelFast: env('MODEL_FAST', 'kimi-k2.7-code-highspeed'),
    maxWaitS: num('LLM_MAX_WAIT_S', 20),
  },
  venueSource: env('VENUE_SOURCE', 'mock'),
  sandbox: {
    url: env('PLEC_SANDBOX_URL', 'https://api.plec.ai/hackathon/sandbox').replace(/\/+$/, ''),
    key: env('PLEC_SANDBOX_KEY', ''),
  },
  // Where /ics and /cal links point (the tunnel URL in a live demo).
  publicBaseUrl: env('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 8788)}`),
  // Organizer's Google Calendar (OAuth refresh token). Empty = links + .ics only.
  google: {
    clientId: env('GOOGLE_CLIENT_ID', ''),
    clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
    refreshToken: env('GOOGLE_REFRESH_TOKEN', ''),
    calendarId: env('GOOGLE_CALENDAR_ID', 'primary'),
  },
  // Party playlist: ONE Spotify account (organizer / team) logs in once at /spotify/login. Empty = fallback (search links).
  spotify: {
    clientId: env('SPOTIFY_CLIENT_ID', ''),
    clientSecret: env('SPOTIFY_CLIENT_SECRET', ''),
    // Spotify only accepts HTTPS or a loopback IP (127.0.0.1, never "localhost"). Must match the dashboard exactly.
    redirectUri: env('SPOTIFY_REDIRECT_URI', `http://127.0.0.1:${num('PORT', 8788)}/spotify/callback`),
  },
  provider: env('IMESSAGE_PROVIDER', 'simulator'),
  webhookSecret: env('WEBHOOK_SECRET', ''),
  providerKeys: {
    sendblueKey: env('SENDBLUE_API_KEY', ''),
    sendblueSecret: env('SENDBLUE_API_SECRET', ''),
    photonKey: env('PHOTON_API_KEY', ''),
    linqKey: env('LINQ_API_KEY', ''),
    bluebubblesUrl: env('BLUEBUBBLES_URL', ''),
    bluebubblesPassword: env('BLUEBUBBLES_PASSWORD', ''),
  },
};

/** "YYYY-MM-DD" for today (pinned by DEMO_TODAY for reproducible demos). */
export function today() {
  return config.demoToday || new Date().toISOString().slice(0, 10);
}

/** Throw a loud, specific error when the model key is missing. */
export function requireLlmKey() {
  if (!config.llm.apiKey) {
    throw new Error('LLM_API_KEY is missing. Put your plk_... key in plec-imessage/.env (see .env.example).');
  }
}

export function configProblems() {
  const problems = [];
  if (!config.llm.apiKey) problems.push('LLM_API_KEY is empty: the agent cannot think (echo only).');
  if (config.venueSource === 'sandbox' && !config.sandbox.key) problems.push('VENUE_SOURCE=sandbox but PLEC_SANDBOX_KEY is empty.');
  if (!(config.google.clientId && config.google.clientSecret && config.google.refreshToken)) problems.push('Google Calendar not configured: calendar invites fall back to links + .ics.');
  if (!(config.spotify.clientId && config.spotify.clientSecret)) problems.push('Spotify not configured: party playlists run in fallback mode (search links).');
  return problems;
}
