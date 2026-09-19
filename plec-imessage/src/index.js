/**
 * Boot: load state, pick the provider, register routes, listen.
 * `startApp()` is also used in-process by the CLI simulator and replay-demo,
 * so every entry point runs the exact same pipeline.
 */
import { fileURLToPath } from 'node:url';
import { config, configProblems } from './config.js';
import { createRouter, sendJson, sendHtml } from './server.js';
import { load, flushSave, allChats } from './store/state.js';
import { icsResponse, templateRedirect } from './tools/calendar.js';
import { playlistPage } from './tools/playlist.js';
import { registerSpotifyRoutes } from './integrations/spotify.js';
import { setProvider } from './providers/Provider.js';
import { createSimulatorProvider } from './providers/simulator.js';
import { handleInbound } from './pipeline/index.js';
import { log, maskSecret } from './log.js';

async function createProvider(name) {
  const onInbound = (messages) => handleInbound(messages).catch((err) => log('💥', null, `pipeline: ${err.stack || err.message}`));
  if (name === 'simulator') return createSimulatorProvider({ onInbound });
  const mod = await import(`./providers/${name}.js`).catch(() => null);
  if (!mod) throw new Error(`IMESSAGE_PROVIDER=${name} has no adapter in src/providers/. Use "simulator".`);
  return mod.createProvider({ onInbound });
}

export async function startApp({ listen = true, port = config.port } = {}) {
  const restored = load();
  const provider = await createProvider(config.provider);
  setProvider(provider);
  // The simulator routes are always on, so /sim works as a backup demo next to a real provider.
  const sim = config.provider === 'simulator' ? provider : createSimulatorProvider({ onInbound: (m) => handleInbound(m) });

  const router = createRouter();
  router.get('/health', (req, res) => sendJson(res, 200, { ok: true, provider: provider.name, venueSource: config.venueSource }));
  // Calendar links for people who didn't share an email (token-gated, see tools/calendar.js).
  router.get('/ics/*', (req, res, { url, query }) => {
    const ics = icsResponse(allChats(), url.pathname, query.k);
    if (!ics) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${ics.filename}"`, 'Cache-Control': 'no-store' });
    res.end(ics.body);
  });
  router.get('/cal/*', (req, res, { url, query }) => {
    const target = templateRedirect(allChats(), url.pathname, query.k);
    if (!target) return sendJson(res, 404, { error: 'not_found' });
    res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
    res.end();
  });
  // Party playlist: one-time Spotify login, plus the fallback song list when Spotify isn't connected.
  registerSpotifyRoutes(router);
  router.get('/playlist/*', (req, res, { url }) => {
    const html = playlistPage(allChats(), url.pathname);
    if (!html) return sendJson(res, 404, { error: 'not_found' });
    sendHtml(res, html);
  });
  provider.registerRoutes(router);
  if (sim !== provider) sim.registerRoutes(router);

  let server = null;
  if (listen) {
    try {
      server = await router.listen(port);
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error(`Port ${port} is busy. Set PORT in plec-imessage/.env (never kill a process you did not start).`);
      throw err;
    }
  }
  log('🚀', null, `PLEC agent up${listen ? ` on http://localhost:${port}` : ''} | provider ${provider.name} | venues ${config.venueSource} | models ${config.llm.modelFast}/${config.llm.modelSmart} key ${maskSecret(config.llm.apiKey)} | restored ${restored} chat(s)`);
  for (const p of configProblems()) log('⚠️', null, p);
  return { router, server, provider, sim, handleInbound };
}

process.on('SIGINT', () => { flushSave(); process.exit(0); });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startApp().catch((err) => { console.error(err.message); process.exit(1); });
}
