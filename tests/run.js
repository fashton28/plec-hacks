/**
 * Runs the public scenarios against your agent and prints a report. No
 * dependencies; Node 20+.
 *
 *   npm test                       every public scenario
 *   npm test -- capacity-exact     one scenario by id
 *
 * Protocol (the staff evaluator does the same with the hidden scenarios):
 *   1. GET  {scenarios}                        -> { scenarios }
 *   2. POST {scenarios}/{id}/start             -> { sessionId, seeded }   resets your sandbox, seeds bookings
 *   3. POST {agent}/agent/messages per turn    -> { parts }               45s timeout
 *      GET  {sandbox}/bookings after each turn                            snapshot for the checks
 *   4. POST {scenarios}/{id}/check { transcript } -> ScenarioResult
 *
 * Exit code 1 when any scored check failed. Latency checks are informational.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
loadDotEnv(join(ROOT, '.env'));

const SANDBOX_URL = (process.env.PLEC_SANDBOX_URL || 'https://api.plec.ai/hackathon/sandbox').replace(/\/+$/, '');
const SCENARIOS_URL = SANDBOX_URL.replace(/\/sandbox$/, '/scenarios');
const KEY = process.env.PLEC_SANDBOX_KEY || '';
const AGENT_URL = (process.env.AGENT_URL || `http://localhost:${process.env.AGENT_PORT || 8787}`).replace(/\/+$/, '');
const TURN_TIMEOUT_MS = 45_000;
const ONLY = process.argv[2];

const BOLD = '\x1b[1m', DIM = '\x1b[2m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
const colour = process.stdout.isTTY ? (code, s) => `${code}${s}${RESET}` : (_code, s) => s;

async function main() {
  if (!KEY) {
    fail(`PLEC_SANDBOX_KEY is missing.\nCopy your team key from https://plec.ai/hack/dashboard into .env (see .env.example).`);
  }
  if (SANDBOX_URL === SCENARIOS_URL) {
    fail(`PLEC_SANDBOX_URL should end in /sandbox (got ${SANDBOX_URL}); the scenarios URL is derived from it.`);
  }

  await assertAgentReachable();

  const listing = await api('GET', SCENARIOS_URL);
  let scenarios = listing.scenarios ?? [];
  if (ONLY) {
    scenarios = scenarios.filter((s) => s.id === ONLY);
    if (scenarios.length === 0) {
      fail(`No public scenario "${ONLY}". Available: ${(listing.scenarios ?? []).map((s) => s.id).join(', ')}`);
    }
  }

  console.log(colour(BOLD, 'Plecathon public scenarios'));
  console.log(colour(DIM, `sandbox ${SANDBOX_URL}\nagent   ${AGENT_URL}\n`));

  let passed = 0, total = 0, index = 0;
  for (const scenario of scenarios) {
    index += 1;
    console.log(`${colour(BOLD, `${index}. ${scenario.title}`)}  ${colour(DIM, `(${scenario.id})`)}`);
    if (scenario.about) console.log(`   ${colour(DIM, scenario.about)}`);

    const started = await api('POST', `${SCENARIOS_URL}/${encodeURIComponent(scenario.id)}/start`);
    if (started.seeded?.length) console.log(`   ${colour(DIM, `seeded ${started.seeded.join(', ')}`)}`);

    const turns = [];
    for (const turn of scenario.turns) {
      const recorded = await runTurn(started.sessionId, turn.user);
      recorded.bookings = await snapshotBookings();
      turns.push(recorded);
    }

    const result = await api('POST', `${SCENARIOS_URL}/${encodeURIComponent(scenario.id)}/check`, { transcript: { turns } });
    printResult(result);
    passed += result.passed;
    total += result.total;
    console.log(`   ${result.passed === result.total ? colour(GREEN, `${result.passed} of ${result.total} checks passed`) : colour(RED, `${result.passed} of ${result.total} checks passed`)}\n`);
  }

  const summary = `${passed} of ${total} checks passed`;
  console.log(passed === total ? colour(GREEN, colour(BOLD, summary)) : colour(RED, colour(BOLD, summary)));
  process.exit(passed === total ? 0 : 1);
}

async function runTurn(sessionId, user) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${AGENT_URL}/agent/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sessionId, text: user }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) return { user, parts: [], latencyMs, error: `Agent answered HTTP ${response.status}: ${text.slice(0, 200)}` };
    let body;
    try { body = JSON.parse(text); } catch { return { user, parts: [], latencyMs, error: 'Agent reply was not JSON' }; }
    if (!Array.isArray(body?.parts)) return { user, parts: [], latencyMs, error: 'Agent reply had no "parts" array' };
    return { user, parts: body.parts, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { user, parts: [], latencyMs, error: timedOut ? `Agent did not reply in ${TURN_TIMEOUT_MS / 1000}s` : `Agent unreachable: ${err?.message ?? err}` };
  }
}

async function snapshotBookings() {
  const body = await api('GET', `${SANDBOX_URL}/bookings`);
  return (body.bookings ?? []).map((b) => ({ ref: b.ref, listingId: b.listingId, status: b.status, date: b.date }));
}

function printResult(result) {
  for (const turn of result.turns ?? []) {
    console.log(`   ${colour(BOLD, '>')} ${turn.user}`);
    if (turn.error) {
      console.log(`   ${colour(RED, '<')} ${colour(RED, `(no reply: ${turn.error})`)} ${colour(DIM, seconds(turn.latencyMs))}`);
    } else {
      const text = (turn.parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text).join(' ').replace(/\s+/g, ' ');
      const others = (turn.parts ?? []).filter((p) => p.kind !== 'text').map((p) => `[${p.kind}: ${p.title ?? p.label ?? p.caption ?? p.url}]`);
      console.log(`   ${colour(BOLD, '<')} ${text.length > 160 ? `${text.slice(0, 160)}...` : text || colour(DIM, '(no text part)')} ${colour(DIM, seconds(turn.latencyMs))}`);
      for (const other of others) console.log(`     ${colour(DIM, other)}`);
    }
    for (const check of turn.checks ?? []) {
      const tag = check.informational ? colour(YELLOW, 'INFO') : check.pass ? colour(GREEN, 'PASS') : colour(RED, 'FAIL');
      const detail = check.detail ? colour(DIM, `  ${check.detail}`) : '';
      console.log(`   ${tag}  ${check.label}${detail}`);
    }
  }
}

async function assertAgentReachable() {
  try {
    // Any HTTP answer counts, even a 404: a Python or Go agent may not serve GET /.
    await fetch(`${AGENT_URL}/`, { method: 'GET', signal: AbortSignal.timeout(5000) });
  } catch (err) {
    fail(`No agent at ${AGENT_URL} (${err?.cause?.code ?? err?.message ?? err}).\nStart it with "npm start" in another terminal, or set AGENT_URL in .env.`);
  }
}

async function api(method, url, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    fail(`Could not reach ${url}: ${err?.cause?.code ?? err?.message ?? err}`);
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (response.status === 401) {
    fail(`The sandbox rejected PLEC_SANDBOX_KEY (${json?.message ?? text}).\nCheck the key on https://plec.ai/hack/dashboard.`);
  }
  if (!response.ok) {
    fail(`${method} ${url} answered HTTP ${response.status}: ${json?.message ?? text.slice(0, 300)}`);
  }
  return json ?? {};
}

function seconds(ms) { return `${((ms ?? 0) / 1000).toFixed(1)}s`; }

function fail(message) {
  console.error(colour(RED, message));
  process.exit(1);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

main().catch((err) => fail(err?.stack ?? String(err)));
