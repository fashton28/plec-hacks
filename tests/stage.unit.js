/** Offline tests for the live stage's narration (agent/stage.js): masking, event shapes, and the SSE stream. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { _internals, mask, openEventStream, stage } from '../agent/stage.js';

const { history } = _internals;
const since = (n) => history.slice(n);
const STATE = {
  city: 'Philadelphia', guestCount: 40, date: '2026-10-10',
  seen: { 'foundry-fishtown': { id: 'foundry-fishtown', name: 'The Foundry at Fishtown', photoUrls: ['https://picsum.photos/seed/foundry-fishtown-1/800/500'] } },
  lastQuote: { listingName: 'The Foundry at Fishtown', totalFormatted: '$1,815.00' },
};

test('masking hides emails, phone numbers and payment links, and keeps what is safe to show', () => {
  assert.equal(mask('I am Sam Rivera, sam.rivera@example.com'), 'I am Sam Rivera, s•••@example.com');
  assert.equal(mask('call me on +1 (215) 555-0123 ok'), 'call me on •••23 ok');
  assert.equal(mask('pay here: https://api.plec.ai/hackathon/sandbox/pay/cs_test_abc123 thanks'), 'pay here: [payment link] thanks');
  assert.equal(mask('BK-1001 at The Foundry for 40 guests on 2026-10-10, $1,815.00'), 'BK-1001 at The Foundry for 40 guests on 2026-10-10, $1,815.00');
});

test('a heard message is masked, names no handle, and says where it came from', () => {
  const n = history.length;
  stage.heard('chat-1', { userText: 'book it, sam@example.com', imessage: true, group: true, tag: '[B]' });
  const [inbound, typing] = since(n);
  assert.deepEqual(inbound.data, { fromName: 'Guest B', text: 'book it, s•••@example.com', channel: 'group chat' });
  assert.equal(inbound.chatId, 'chat-1');
  assert.equal(typing.type, 'typing');
});

test('a quote becomes an activity row, a pending card and a plan update', () => {
  const n = history.length;
  stage.tool('chat-1', 'quote', {}, { listingId: 'foundry-fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40, lineItems: [{ label: '5 hours', amountCents: 150000 }, { label: 'Cleaning fee', amountCents: 15000 }], serviceFeeCents: 16500, totalCents: 181500 }, STATE);
  const [row, pending, plan] = since(n);
  assert.deepEqual(row.data, { kind: 'quoted', title: 'Quoted $1,815.00', detail: 'The Foundry at Fishtown · 40 guests · all in' });
  assert.equal(pending.data.total, '$1,815.00');
  assert.deepEqual(pending.data.lines, [['5 hours', '$1,500.00'], ['Cleaning fee', '$150.00'], ['Service fee', '$165.00']]);
  assert.equal(pending.data.photoUrl, STATE.seen['foundry-fishtown'].photoUrls[0]);
  assert.deepEqual(plan.data, { city: 'Philadelphia', guests: 40, date: '2026-10-10', venue: 'The Foundry at Fishtown', total: '$1,815.00' });
});

test('a booking clears the pending card and never carries the guest or the payment URL', () => {
  const n = history.length;
  stage.tool('chat-1', 'book', {}, { ref: 'BK-1001', status: 'pending_payment', listingId: 'foundry-fishtown', listingName: 'The Foundry at Fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40, totalCents: 181500, guestName: 'Sam Rivera', guestEmail: 'sam@example.com', payment: { status: 'unpaid', url: 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_x' } }, STATE);
  const events = since(n);
  assert.deepEqual(events.map((e) => e.type), ['activity', 'pending', 'booking', 'plan']);
  assert.equal(events[1].data, null);
  assert.equal(events[2].data.fresh, true);
  assert.equal(events[2].data.paid, false);
  const wire = JSON.stringify(events);
  for (const secret of ['sam@example.com', 'Sam Rivera', 'cs_test_x']) assert.ok(!wire.includes(secret), secret);
});

test('a sandbox refusal and a held-back write each get an honest row', () => {
  const n = history.length;
  stage.tool('chat-1', 'quote', {}, { error: 'blackout', message: 'The Rooftop at Rittenhouse is not available on 2026-10-17.' }, STATE);
  stage.held('chat-1', 'cancel_booking', { error: 'requester_confirmation_required' });
  const [no, held] = since(n);
  assert.equal(no.data.kind, 'issue');
  assert.match(no.data.title, /not available/);
  assert.deepEqual(held.data, { kind: 'held', title: 'Held back on cancel booking', detail: 'only the person who asked can say yes' });
});

test('narration can never break a turn', () => {
  assert.doesNotThrow(() => stage.tool('chat-1', 'quote', null, null, null));
  assert.doesNotThrow(() => stage.replied('chat-1', null, null));
  assert.doesNotThrow(() => stage.heard('chat-1', null));
});

test('the event stream replays the past flagged as replay, then goes live, and unsubscribes on close', () => {
  const req = new EventEmitter();
  const chunks = [];
  const res = { writeHead: (status, headers) => chunks.push(`HEAD ${status} ${headers['Content-Type']}`), write: (c) => chunks.push(c) };
  openEventStream(req, res);
  assert.match(chunks[0], /^HEAD 200 text\/event-stream/);
  const replayed = chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)));
  assert.ok(replayed.length > 0 && replayed.every((e) => e.replay === true));
  const before = chunks.length;
  stage.quiet('chat-2', 'nobody was talking to PLEC');
  const live = JSON.parse(chunks.at(-1).slice(6));
  assert.equal(chunks.length, before + 1);
  assert.deepEqual([live.type, live.data.speak, live.replay], ['decision', false, undefined]);
  req.emit('close');
  stage.quiet('chat-2', 'again');
  assert.equal(chunks.length, before + 1, 'a closed stream gets nothing more');
});
