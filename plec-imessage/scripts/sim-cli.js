/**
 * Terminal group chat against the real pipeline (in-process, simulator provider).
 *   /as Dani        switch speaker      /img path.png   send an image
 *   /plan           print the plan      /state          dump chat state
 *   /reset          clear this chat     /quit
 * The HTTP server runs too, so /sim and /dashboard stay live next to it.
 */
import readline from 'node:readline';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.IMESSAGE_PROVIDER = 'simulator';
const { startApp } = await import('../src/index.js');
const { bus } = await import('../src/bus.js');
const { getChat, resetChat, flushSave } = await import('../src/store/state.js');
const { contactName } = await import('../src/pipeline/ingest.js');
const { readFileSync } = await import('node:fs');
const { ROOT } = await import('../src/config.js');

const CHAT_ID = process.env.SIM_CHAT_ID || 'sim-group';
const contacts = JSON.parse(readFileSync(resolve(ROOT, 'data/contacts.json'), 'utf8'));
const byName = Object.fromEntries(Object.entries(contacts).filter(([k]) => k.startsWith('+')).map(([phone, name]) => [name.toLowerCase(), phone]));

const c = { dim: '\x1b[2m', mag: '\x1b[35m', cyan: '\x1b[36m', yel: '\x1b[33m', reset: '\x1b[0m', bold: '\x1b[1m' };
let speaker = Object.values(byName)[0];

await startApp();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => { rl.setPrompt(`${c.cyan}${contactName(speaker)}>${c.reset} `); rl.prompt(true); };

bus.on('event', (e) => {
  if (e.chatId !== CHAT_ID) return;
  if (e.type === 'agent_message') {
    process.stdout.write(`\r\x1b[K${c.mag}${c.bold}  PLEC ▸${c.reset}${c.mag} ${e.data.text.replace(/\n/g, `\n         `)}${c.reset}\n`);
    prompt();
  } else if (e.type === 'decision') {
    process.stdout.write(`\r\x1b[K${c.dim}  ${e.data.speak ? '💬' : '🤫'} ${e.data.reason}${c.reset}\n`);
    prompt();
  }
});

function send(text, attachments = []) {
  const { handleInbound } = globalThis.__plecPipeline;
  handleInbound([{ id: `cli-${randomUUID()}`, chatId: CHAT_ID, isGroup: true, from: speaker, fromName: contactName(speaker), text, attachments, timestamp: Date.now(), source: 'simulator' }]);
}
globalThis.__plecPipeline = await import('../src/pipeline/index.js');

console.log(`${c.dim}group chat "${CHAT_ID}" | people: ${Object.keys(byName).join(', ')} | /as <name>, /img <path>, /plan, /state, /reset, /quit${c.reset}`);
prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return prompt();
  const [cmd, ...rest] = text.split(' ');
  if (cmd === '/as') {
    const phone = byName[rest.join(' ').toLowerCase()];
    if (phone) speaker = phone; else console.log(`unknown person; try ${Object.keys(byName).join(', ')}`);
  } else if (cmd === '/img') {
    const path = resolve(rest.join(' '));
    const ext = path.split('.').pop().toLowerCase();
    send('', [{ url: path, mimeType: ext === 'png' ? 'image/png' : 'image/jpeg' }]);
  } else if (cmd === '/plan') {
    console.log(JSON.stringify(getChat(CHAT_ID).plan, null, 2));
  } else if (cmd === '/state') {
    const { transcript, seenIds, ...rest2 } = getChat(CHAT_ID);
    console.log(JSON.stringify({ ...rest2, transcriptLength: transcript.length }, null, 2));
  } else if (cmd === '/reset') {
    resetChat(CHAT_ID);
    console.log('chat cleared');
  } else if (cmd === '/quit') {
    flushSave();
    process.exit(0);
  } else {
    send(text);
  }
  prompt();
});
rl.on('close', () => { flushSave(); process.exit(0); });
