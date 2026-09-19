/**
 * Replays data/demo-script.json through the real pipeline (simulator provider).
 *   node scripts/replay-demo.js          realistic delays (watch /sim and /dashboard)
 *   node scripts/replay-demo.js --fast   no delays, bursts flushed immediately
 * Other flags: --script path.json, --keep (don't reset the chat first), --no-server
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.env.IMESSAGE_PROVIDER = 'simulator';
const fast = process.argv.includes('--fast');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

const { config, ROOT } = await import('../src/config.js');
const { startApp } = await import('../src/index.js');
const { bus } = await import('../src/bus.js');
const { getChat, resetChat, flushSave } = await import('../src/store/state.js');
const { flush, whenIdle } = await import('../src/pipeline/debounce.js');
const { setBubbleDelay } = await import('../src/pipeline/outbound.js');
const { stats } = await import('../src/llm.js');
const { setQuiet } = await import('../src/log.js');

const script = JSON.parse(readFileSync(resolve(arg('--script') || resolve(ROOT, 'data/demo-script.json')), 'utf8'));
const CHAT = script.chatId;
config.llm.maxWaitS = 300; // wait out the shared proxy's 5-minute window instead of failing mid-demo
if (fast) {
  config.debounceMs = 250;
  config.debounceMentionMs = 150;
  setBubbleDelay(0, 0);
}
setQuiet(!process.argv.includes('--verbose'));
const app = await startApp({ listen: !process.argv.includes('--no-server') }).catch((err) => {
  console.error(`${err.message}\n(tip: --no-server, or stop the other instance)`);
  process.exit(1);
});
if (!process.argv.includes('--keep')) resetChat(CHAT);

const c = { dim: '\x1b[2m', mag: '\x1b[35m', bold: '\x1b[1m', cyan: '\x1b[36m', yel: '\x1b[33m', grn: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };
const decisions = [];
bus.on('event', (e) => {
  if (e.type === 'llm_wait') console.log(`${c.yel}  ⏳ model quota hit, waiting ${e.data.seconds}s for the window to reset${c.reset}`);
  if (e.chatId !== CHAT) return;
  if (e.type === 'agent_message') console.log(`${c.mag}${c.bold}          PLEC ▸ ${c.reset}${c.mag}${e.data.text.replace(/\n/g, '\n                 ')}${c.reset}`);
  if (e.type === 'decision') { decisions.push(e.data); console.log(`${c.dim}                 ${e.data.speak ? '💬' : '🤫'} ${e.data.reason}${c.reset}`); }
  if (e.type === 'tool') console.log(`${c.dim}                 🔧 ${e.data.name}${e.data.error ? ` -> ${e.data.error}` : ''}${c.reset}`);
});

function fill(text) {
  const plan = getChat(CHAT).plan;
  return text.replace(/\{\{vote:([^}]+)\}\}/g, (_, id) => {
    const list = plan.shortlist || [];
    if (id === 'other') {
      const kiln = list.indexOf('kiln-loft-fishtown');
      const i = list.findIndex((_, j) => j !== kiln);
      return String(i >= 0 ? i + 1 : 1);
    }
    const i = list.indexOf(id);
    return String(i >= 0 ? i + 1 : 2);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`${c.bold}▶ ${script.title}${c.reset} ${c.dim}(${fast ? 'fast' : 'realtime'}, venues=${config.venueSource}, chat ${CHAT}${app.server ? `, watch http://localhost:${config.port}/dashboard` : ''})${c.reset}\n`);
const started = Date.now();
let seq = 0;
for (const step of script.steps) {
  const text = fill(step.text);
  const from = script.people[step.from];
  console.log(`${c.cyan}${step.from.padStart(8)}:${c.reset} ${text}`);
  await app.handleInbound([{ id: `demo-${Date.now()}-${seq += 1}`, chatId: CHAT, isGroup: true, from, fromName: step.from, text, attachments: [], timestamp: Date.now(), source: 'simulator' }]);
  if (step.pause) {
    if (fast) flush(CHAT); else await sleep(config.debounceMs + 500);
    await whenIdle(CHAT);
    if (step.expect) console.log(`${c.dim}                 (expected: ${step.expect})${c.reset}`);
    console.log('');
  } else if (!fast) {
    await sleep(1200 + Math.random() * 1500);
  }
}
await whenIdle(CHAT);
flushSave();

const chat = getChat(CHAT);
const b = chat.bookings.find((x) => x.status !== 'cancelled');
const check = (label, ok) => console.log(`${ok ? `${c.grn}PASS` : `${c.red}FAIL`}${c.reset}  ${label}`);
console.log(`${c.bold}--- result${c.reset} (${((Date.now() - started) / 1000).toFixed(0)}s, ${stats.calls} model calls, ${stats.tokens} tokens)`);
check('introduced once', chat.introduced && chat.transcript.filter((m) => m.from === 'agent' && /I'm PLEC/.test(m.text)).length === 1);
const firstSpeak = decisions.findIndex((d) => d.speak);
check('silent through the chatter (first speak is the "plec help")', firstSpeak >= 0 && decisions[firstSpeak].reason === 'mentioned directly');
check('shortlist sent with numbered options', (chat.plan.shortlist || []).length >= 2);
check('booking exists (confirmed by server code)', !!b);
check('over-capacity alert fired', (chat.flaggedIssues || []).some((k) => k.startsWith('cap:')));
check('booking now fits the new headcount', !!b && b.venueCapacity >= (chat.plan.headcount?.value || 0));
check(`headcount ≈ 53 (got ${chat.plan.headcount?.value})`, Math.abs((chat.plan.headcount?.value || 0) - 53) <= 2);
if (b) console.log(`${c.dim}booking: ${b.id} ${b.venueName} ${b.date} ${b.startTime}-${b.endTime} x${b.headcount} $${b.total} | history: ${b.history.map((h) => h.change).join(' | ')}${c.reset}`);
if (app.server && !process.argv.includes('--exit')) {
  console.log(`\n${c.dim}server still up: http://localhost:${config.port}/dashboard (ctrl-c to quit)${c.reset}`);
} else process.exit(0);
