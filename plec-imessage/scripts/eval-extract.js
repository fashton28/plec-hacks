/**
 * Runs plan extraction alone over the demo script (same bursts as the
 * replay, no responder) and checks the final plan. Prints PASS/FAIL per check.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const { ROOT, config } = await import('../src/config.js');
const { getChat, resetChat, appendTranscript } = await import('../src/store/state.js');
const { extractPlan } = await import('../src/pipeline/extractPlan.js');
const { setQuiet } = await import('../src/log.js');
setQuiet(!process.argv.includes('--verbose'));
config.llm.maxWaitS = 300;

const script = JSON.parse(readFileSync(resolve(ROOT, 'data/demo-script.json'), 'utf8'));
const CHAT = 'eval-extract';
resetChat(CHAT);
const chat = getChat(CHAT);
chat.participants = Object.entries(script.people).map(([name, phone]) => ({ phone, name, isOrganizer: name === 'Tony' }));

let batch = [];
let n = 0;
const skip = /\{\{vote|^yes book it$|^switch it$|what's the plan/;
for (const step of script.steps) {
  if (!skip.test(step.text)) {
    const m = { id: `m${n += 1}`, chatId: CHAT, isGroup: true, from: script.people[step.from], fromName: step.from, text: step.text, attachments: [], timestamp: Date.now(), source: 'simulator' };
    appendTranscript(chat, m);
    batch.push(m);
  }
  if (step.pause && batch.length) {
    process.stdout.write(`extracting burst of ${batch.length}... `);
    const r = await extractPlan(chat, batch);
    console.log(r ? `ok (${r.changed.join(', ') || 'no change'}; model says ${r.decision?.speak ? 'speak' : 'silent'}: ${r.decision?.reason})` : 'FAILED');
    batch = [];
  }
}

const p = chat.plan;
const text = JSON.stringify(p).toLowerCase();
const has = (person, re) => p.personConstraints.some((c) => c.person.toLowerCase() === person && re.test(c.constraint.toLowerCase()));
const dateOut = (date, person) => p.dateOptions.some((d) => d.date === date && d.doesNotWorkFor.some((x) => x.toLowerCase() === person));
const checks = [
  ['Dani cannot do Oct 17', has('dani', /17/) || dateOut('2026-10-17', 'dani')],
  ['accessibility need (no stairs) recorded', /stair|wheelchair|accessib|step/.test(JSON.stringify(p.dealbreakers).toLowerCase() + JSON.stringify(p.personConstraints).toLowerCase())],
  [`headcount ≈ 53 after +8 (got ${p.headcount?.value})`, Math.abs((p.headcount?.value || 0) - 53) <= 2],
  ['budget ~$40/head (Marcus)', p.budget?.perPerson === 40 || /40/.test(JSON.stringify(p.budget || {})) || has('marcus', /40/)],
  ['"dancing" vibe', /danc/.test(JSON.stringify(p.vibe).toLowerCase()) || /danc/.test(JSON.stringify(p.dealbreakers).toLowerCase())],
  ['surprise + guest of honor Sofia', p.isSurprise === true && /sofia/i.test(p.guestOfHonor || '')],
  ['Oct 25 works for all four', p.dateOptions.some((d) => d.date === '2026-10-25' && d.doesNotWorkFor.length === 0)],
];
console.log('\nfinal plan:', JSON.stringify(p, null, 1).slice(0, 2500));
let fails = 0;
for (const [label, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails += 1; }
resetChat(CHAT);
process.exit(fails ? 1 : 0);
