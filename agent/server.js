/**
 * Zero-dependency HTTP server for the agent contract (docs/contract.md):
 *
 *   GET  /                 the chat page (chat/index.html) and its emblem
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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from './agent.js';
import { getSession, resetSession } from './session.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
loadDotEnv(join(ROOT, '.env'));

const PORT = Number(process.env.AGENT_PORT) || 8787;
/** The evaluator gives up at 45s; answer with an error before that so the failure is visible. */
const TURN_DEADLINE_MS = 40_000;
const MAX_BODY_BYTES = 64 * 1024;
const CHAT_DIR = join(ROOT, 'chat');
const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (req.method === 'OPTIONS') return end(res, 204);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/agent/messages') return await handleMessage(req, res);
    if (req.method === 'POST' && url.pathname === '/agent/reset') return await handleReset(req, res);
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
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!sessionId) return json(res, 400, { error: 'session_required', message: 'sessionId must be a non-empty string' });
  if (!text) return json(res, 400, { error: 'text_required', message: 'text must be a non-empty string' });

  const startedAt = Date.now();
  let parts;
  try {
    parts = await withDeadline(respond({ sessionId, text, session: getSession(sessionId) }), TURN_DEADLINE_MS);
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
  resetSession(sessionId);
  return json(res, 200, { ok: true });
}

/** Serves chat/ read-only; "/" is the chat page. Path is normalised so ".." cannot escape. */
async function serveStatic(pathname, res, headOnly = false) {
  const relative = pathname === '/' ? 'index.html' : normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.)+/, '');
  const file = join(CHAT_DIR, relative);
  if (!file.startsWith(CHAT_DIR) || !existsSync(file)) {
    return json(res, 404, { error: 'not_found', message: `No file ${pathname}` });
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

/** Tiny .env reader: KEY=value lines, # comments, optional quotes. Never overrides a real env var. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

server.listen(PORT, () => {
  console.log(`PLEC agent listening on http://localhost:${PORT}`);
  console.log(`Chat page:   http://localhost:${PORT}/`);
  console.log(`Sandbox:     ${process.env.PLEC_SANDBOX_URL || 'https://api.plec.ai/hackathon/sandbox'}  key ${process.env.PLEC_SANDBOX_KEY ? 'set' : 'MISSING (copy it from https://plec.ai/hack/dashboard into .env)'}`);
});
