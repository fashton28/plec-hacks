/**
 * Zero-dependency HTTP server for the agent contract (docs/contract.md):
 *
 *   GET  /                 the chat with its live panels (chat/index.html); /stage.html is the big-screen view, /imessage.html the iMessage sign-up
 *   GET  /events           server-sent events for the stage (agent/stage.js)
 *   POST /agent/messages   { sessionId, text }  ->  { parts: Part[] }
 *   POST /agent/reset      { sessionId }        ->  { ok: true }
 *   GET  /health           { ok: true }
 *
 * CORS is wide open so the chat page can be served from anywhere (a file, a
 * tunnel, another port) and still talk to this server. Every error is JSON
 * with { error, message } so the runner and the chat page can print it.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from './agent.js';
import { loadDotEnv } from './env.js';
import { startIMessage } from './imessage.js';
import { clampText } from './guards.js';
import { signup } from './signup.js';
import { openEventStream, stage } from './stage.js';
import { getCalendarLink, getPage, googleCalendarUrl, icsFile, pageEvent, renderPage } from './eventpage.js';
import { noteRequestOrigin, publicOrigin } from './origin.js';
import { getSession, resetSession, withSessionLock } from './session.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
loadDotEnv(join(ROOT, '.env'));

const PORT = Number(process.env.AGENT_PORT) || 8787;
/** The evaluator gives up at 45s; answer with an error before that so the failure is visible. */
const TURN_DEADLINE_MS = 40_000;
const MAX_BODY_BYTES = 64 * 1024;
const CHAT_DIR = join(ROOT, 'chat');
/** Addresses that moved, plus the ones people guess. The chat is the front page; the big-screen view is /stage.html. */
const MOVED = { '/chat': '/', '/chat/': '/', '/chat.html': '/', '/stage': '/stage.html', '/stage/': '/stage.html', '/imessage': '/imessage.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (req.method === 'OPTIONS') return end(res, 204);
    noteRequestOrigin(req.headers);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/events') return openEventStream(req, res);
    if (req.method === 'GET' && /^\/[ec]\//.test(url.pathname)) return serveEventLink(url.pathname, res);
    if (req.method === 'POST' && url.pathname === '/agent/messages') return await handleMessage(req, res);
    if (req.method === 'POST' && url.pathname === '/agent/reset') return await handleReset(req, res);
    if (req.method === 'POST' && url.pathname === '/imessage/signup') return await handleSignup(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && MOVED[url.pathname]) {
      res.writeHead(308, { Location: MOVED[url.pathname] });
      return res.end();
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res, req.method === 'HEAD');
    return json(res, 404, { error: 'not_found', message: `No route ${req.method} ${url.pathname}` });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'server_error', message: err?.message ?? String(err) });
  }
});

async function handleMessage(req, res) {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: 'bad_json', message: 'Send a JSON body: { "sessionId": "...", "text": "..." }' });
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  const text = typeof body.text === 'string' ? clampText(body.text.trim()) : '';
  if (!sessionId) return json(res, 400, { error: 'session_required', message: 'sessionId must be a non-empty string' });
  if (!text) return json(res, 400, { error: 'text_required', message: 'text must be a non-empty string' });

  const startedAt = Date.now();
  let parts;
  try {
    parts = await runTurn(sessionId, text);
  } catch (err) {
    const timedOut = err?.code === 'DEADLINE';
    console.error(`[turn ${sessionId.slice(0, 8)}] failed after ${Date.now() - startedAt}ms:`, timedOut ? err.message : err);
    return json(res, timedOut ? 504 : 500, { error: timedOut ? 'agent_timeout' : 'agent_error', message: err?.message ?? String(err) });
  }

  const clean = Array.isArray(parts) ? parts.filter(isPart) : [];
  if (clean.length === 0) {
    return json(res, 500, { error: 'no_parts', message: 'respond() returned no valid parts. See docs/contract.md for the shapes.' });
  }
  if (!clean.some((p) => p.kind === 'text')) {
    console.warn(`[turn ${sessionId.slice(0, 8)}] reply has no text part; the contract asks for at least one`);
  }
  console.log(`[turn ${sessionId.slice(0, 8)}] ${Date.now() - startedAt}ms  "${text.slice(0, 60)}" -> ${clean.map((p) => p.kind).join(',')}`);
  return json(res, 200, { parts: clean });
}

async function handleReset(req, res) {
  const body = await readJson(req);
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) return json(res, 400, { error: 'session_required', message: 'sessionId must be a non-empty string' });
  // Behind the lock, so a reset never pulls the session out from under a turn that is still writing to it.
  await withSessionLock(sessionId, () => resetSession(sessionId));
  stage.reset(sessionId);
  return json(res, 200, { ok: true });
}

/** Self-serve iMessage sign-up (agent/signup.js). Behind a tunnel the caller's address is in a forwarding header. */
async function handleSignup(req, res) {
  const body = await readJson(req);
  if (!body) return json(res, 400, { error: 'bad_json', message: 'Send a JSON body: { "name": "...", "email": "...", "phone": "..." }' });
  const forwarded = String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const result = await signup(body, { ip: forwarded || req.socket.remoteAddress || 'unknown' });
  return json(res, result.status, result.body);
}

/** Invitation pages (/e/<id>, /e/<id>.ics) and one-person calendar links (/c/<id>, /c/<id>.ics). See agent/eventpage.js. */
function serveEventLink(pathname, res) {
  const match = /^\/([ec])\/([A-Za-z0-9_-]{6,16})(\.ics)?$/.exec(pathname);
  const calendar = match?.[1] === 'c' ? getCalendarLink(match[2]) : null;
  const page = match?.[1] === 'e' ? getPage(match[2]) : null;
  const event = calendar?.event ?? (page ? pageEvent(page) : null);
  if (!calendar && !page) return json(res, 404, { error: 'not_found', message: 'That link has expired or never existed.' });
  if (match[3]) {
    if (!event) return json(res, 404, { error: 'no_date', message: 'This event has no date and time yet.' });
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="event.ics"', 'Cache-Control': 'no-store' });
    return res.end(icsFile(event, match[2]));
  }
  if (calendar) {
    res.writeHead(302, { Location: googleCalendarUrl(calendar.event, calendar.emails), 'Cache-Control': 'no-store' });
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(renderPage(page, publicOrigin()));
}

/** Serves chat/ read-only; "/" is the chat page. Path is normalised so ".." cannot escape. */
async function serveStatic(pathname, res, headOnly = false) {
  // A path ending in a slash is a directory: serve its index.html, the way / does.
  const wanted = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const relative = normalize(decodeURIComponent(wanted)).replace(/^([/\\]|\.\.)+/, '');
  const file = join(CHAT_DIR, relative);
  if (!file.startsWith(CHAT_DIR) || !existsSync(file)) {
    return json(res, 404, { error: 'not_found', message: `No file ${pathname}` });
  }
  // A directory asked for without its slash would resolve the page's relative links one level up: add the slash.
  if (statSync(file).isDirectory()) {
    res.writeHead(308, { Location: `${pathname}/` });
    return res.end();
  }
  const bytes = await readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.end(headOnly ? undefined : bytes);
}

/** Same validation the evaluator applies, so what you see locally is what staff see. */
function isPart(part) {
  if (!part || typeof part !== 'object') return false;
  switch (part.kind) {
    case 'text': return typeof part.text === 'string';
    case 'card': return typeof part.title === 'string' && Array.isArray(part.photoUrls);
    case 'link': return typeof part.label === 'string' && typeof part.url === 'string';
    case 'image': return typeof part.url === 'string';
    default: return false;
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * One turn, one at a time per session. The deadline starts when the turn
 * starts, not while it waits its turn, and the lock stays held until respond()
 * has really finished: giving up on a slow turn must not let the next one run
 * on top of it.
 */
function runTurn(sessionId, text) {
  return new Promise((resolve, reject) => {
    withSessionLock(sessionId, () => {
      const turn = respond({ sessionId, text, session: getSession(sessionId) });
      withDeadline(turn, TURN_DEADLINE_MS).then(resolve, reject);
      return turn;
    }).catch(reject);
  });
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`The agent took more than ${ms / 1000}s to reply`);
      err.code = 'DEADLINE';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function end(res, status) {
  res.writeHead(status);
  res.end();
}

server.listen(PORT, () => {
  console.log(`PLEC agent listening on http://localhost:${PORT}`);
  console.log(`Chat page:   http://localhost:${PORT}/`);
  console.log(`Big screen:  http://localhost:${PORT}/stage.html`);
  console.log(`Sandbox:     ${process.env.PLEC_SANDBOX_URL || 'https://api.plec.ai/hackathon/sandbox'}  key ${process.env.PLEC_SANDBOX_KEY ? 'set' : 'MISSING (copy it from https://plec.ai/hack/dashboard into .env)'}`);
  startIMessage();
});
