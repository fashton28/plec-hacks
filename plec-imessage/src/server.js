/** Tiny zero-dependency router on node:http, plus JSON, HTML and SSE helpers. A path ending in * matches that prefix. */
import { createServer } from 'node:http';
import { log } from './log.js';

export function createRouter() {
  const routes = [];
  const add = (method) => (path, handler) => routes.push({ method, path, handler });
  return {
    get: add('GET'),
    post: add('POST'),
    routes,
    listen(port) {
      const server = createServer((req, res) => handle(routes, req, res));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server));
      });
    },
  };
}

async function handle(routes, req, res) {
  const url = new URL(req.url, 'http://localhost');
  const matches = (p) => p === url.pathname || (p.endsWith('*') && url.pathname.startsWith(p.slice(0, -1)));
  const route = routes.find((r) => r.method === req.method && matches(r.path));
  if (!route) return sendJson(res, 404, { error: 'not_found' });
  let body = null;
  try {
    if (req.method === 'POST') {
      const raw = await readBody(req);
      const type = req.headers['content-type'] || '';
      body = type.includes('application/json') ? (raw ? JSON.parse(raw) : {}) : type.includes('form') ? Object.fromEntries(new URLSearchParams(raw)) : raw;
    }
  } catch (err) {
    // Never crash on a bad payload: log it, answer 200 so providers do not retry forever.
    log('⚠️', null, `bad payload on ${url.pathname}: ${err.message}`);
    return sendJson(res, 200, { ok: false, error: 'bad_payload' });
  }
  try {
    await route.handler(req, res, { body, query: Object.fromEntries(url.searchParams), url });
  } catch (err) {
    log('💥', null, `${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: err.message });
  }
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

export function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** Open an SSE stream; returns send(obj). Closes cleanly when the client leaves. */
export function openSse(req, res, onClose) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); onClose?.(); });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
