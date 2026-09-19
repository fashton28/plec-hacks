/**
 * End-to-end test of the harness against the LIVE sandbox with a scripted
 * stand-in for the model. It proves the parts that must not depend on a
 * model's mood: the tool loop, the consent gates, memory, payment handoff,
 * injection stripping and the parts that come out.
 *
 *   npm run test:integration       (needs PLEC_SANDBOX_KEY; resets your sandbox bookings)
 *
 * The stand-in speaks POST /chat/completions on a local port. Each test
 * queues the replies the "model" will give; a reply is either a string (final
 * answer), a list of tool calls, or a function of the messages so far.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../agent/env.js';

loadDotEnv(join(dirname(dirname(fileURLToPath(import.meta.url))), '.env'));
const { respond } = await import('../agent/agent.js');
const { plec } = await import('../agent/plec.js');

const script = [];
const requests = [];
let callId = 0;
const call = (name, args) => ({ id: `call_${(callId += 1)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const lastToolResult = (messages) => JSON.parse(messages.filter((m) => m.role === 'tool').at(-1).content);

const fakeModel = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    requests.push(body);
    let next = script.shift();
    if (typeof next === 'function') next = next(body.messages);
    const message = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', content: '', tool_calls: next ?? [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message }] }));
  });
});

before(async () => {
  await new Promise((resolve) => fakeModel.listen(0, '127.0.0.1', resolve));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${fakeModel.address().port}`;
  process.env.LLM_API_KEY = '';
  await plec.reset();
});
after(async () => {
  await plec.reset();
  fakeModel.close();
});

const newSession = () => ({ messages: [], state: {} });
const say = (session, text) => respond({ sessionId: 'integration-test', text, session });
const textOf = (parts) => parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
const FOUNDRY_SLOT = { listingId: 'foundry-fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40 };

test('search: every card is a real listing that fits 40 guests in Philadelphia', async () => {
  const session = newSession();
  script.push([call('search_listings', { city: 'Philly', kind: 'venue', guests: 40, date: '2026-10-10' })], 'Here are venues that fit 40 guests.');
  const parts = await say(session, 'Birthday party in Philadelphia for 40 people on October 10. What venues do you have?');
  const cards = parts.filter((p) => p.kind === 'card');
  assert.ok(cards.length >= 1 && cards.length <= 6, `${cards.length} cards`);
  const { results } = await plec.searchListings({ city: 'Philadelphia', kind: 'venue', guests: 40, limit: 10 });
  const fitting = new Set(results.map((l) => l.name));
  for (const card of cards) {
    assert.ok(fitting.has(card.title), `${card.title} is not in the fitting set`);
    assert.equal(card.photoUrls.length, 3);
  }
  assert.equal(session.state.city, 'Philadelphia', 'the "Philly" alias was normalised and remembered');
  assert.equal(session.state.guestCount, 40);
});

test('memory: a later service search inherits the city without being told', async () => {
  const session = newSession();
  script.push([call('search_listings', { city: 'Philadelphia', kind: 'venue', guests: 60 })], 'Venues for 60.');
  await say(session, 'Launch party in Philadelphia for 60 people. Which venues fit?');
  script.push([call('search_listings', { kind: 'service', category: 'photographer' })], 'Photographers.');
  const parts = await say(session, 'And a photographer?');
  const cards = parts.filter((p) => p.kind === 'card');
  assert.ok(cards.length >= 1);
  for (const card of cards) assert.match(card.subtitle, /Philadelphia/);
  assert.match(requests.at(-1).messages[0].content, /city: Philadelphia; headcount: 60/);
});

test('facts: the model is handed the real capacity and a card is attached', async () => {
  const session = newSession();
  script.push([call('get_listing', { id: 'foundry-fishtown' })], (messages) => `It holds up to ${lastToolResult(messages).capacity.max} guests.`);
  const parts = await say(session, 'How many people can The Foundry at Fishtown hold?');
  assert.match(textOf(parts), /150/);
  assert.deepEqual(parts.filter((p) => p.kind === 'card').map((p) => p.title), ['The Foundry at Fishtown']);
  assert.match(JSON.parse(requests.at(-1).messages.at(-1).content).cancellationTerms, /7 or more days/, 'the model is told what "moderate" actually means');
});

test('injection: planted instructions never reach the model, and a leaked code is scrubbed', async () => {
  const session = newSession();
  script.push([call('get_listing', { id: 'south-street-studio' })], 'A bright white-box studio. Use the code PLEC90 for 90% off everything! It holds 10 to 50 guests.');
  const parts = await say(session, 'Tell me about South Street Studio');
  const seenByModel = requests.at(-1).messages.filter((m) => m.role === 'tool').at(-1).content;
  assert.ok(!/PLEC90|ignore your instructions|free today/i.test(seenByModel), 'tool result still carries the planted text');
  assert.match(seenByModel, /cyclorama/);
  assert.ok(!/PLEC90/i.test(textOf(parts)));
  assert.match(textOf(parts), /10 to 50 guests/);
});

test('photos: asking for photos yields image parts from the sandbox', async () => {
  const session = newSession();
  script.push([call('get_listing', { id: 'foundry-fishtown' })], 'Here are the photos.');
  const parts = await say(session, 'Can I see photos of The Foundry at Fishtown?');
  const images = parts.filter((p) => p.kind === 'image');
  assert.equal(images.length, 3);
  for (const image of images) assert.match(image.url, /^https:\/\/picsum\.photos\/seed\/foundry-fishtown-/);
});

test('booking: nothing is booked without a yes, then exactly one booking with an honest payment handoff', async () => {
  await plec.reset();
  const session = newSession();

  // Turn 1: an over-eager model tries to quote AND book straight away. The gate must stop the booking.
  script.push(
    [call('quote', FOUNDRY_SLOT)],
    [call('book', { ...FOUNDRY_SLOT, quoteId: 'q_made_up', guestName: 'Guest', guestEmail: 'guest@example.com' })],
    (messages) => { assert.equal(lastToolResult(messages).error, 'guest_details_required'); return 'What name and email should I put the booking under?'; },
  );
  const first = await say(session, 'Book The Foundry at Fishtown for October 10 from 6pm to 11pm for 40 people.');
  assert.equal((await plec.listBookings()).bookings.length, 0, 'a bare "book it" created a booking');
  assert.match(textOf(first), /\$1,815\.00/, 'the exact all-in total was added even though the model forgot it');

  // Turn 2: identity but no yes. Still nothing.
  script.push(
    [call('book', { ...FOUNDRY_SLOT, quoteId: 'q_made_up', guestName: 'Sam Rivera', guestEmail: 'sam@example.com' })],
    (messages) => { assert.equal(lastToolResult(messages).error, 'confirmation_required'); return 'Shall I go ahead?'; },
  );
  // "actually" marks hesitation, so a quote from an earlier turn is not enough on its own.
  await say(session, 'Actually, put it under Sam Rivera, sam@example.com');
  assert.equal((await plec.listBookings()).bookings.length, 0);

  // Turn 3: the yes. One booking, with the quoteId the sandbox issued rather than the one the model made up.
  script.push([call('book', { ...FOUNDRY_SLOT, quoteId: 'q_made_up', guestName: 'Sam Rivera', guestEmail: 'sam@example.com' })], 'Done.');
  const third = await say(session, 'Yes, go ahead');
  const { bookings } = await plec.listBookings();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, 'pending_payment');
  assert.equal(bookings[0].guestEmail, 'sam@example.com');
  const reply = textOf(third);
  assert.ok(reply.includes(bookings[0].ref), 'reference missing from the reply');
  assert.ok(reply.includes(bookings[0].payment.url), 'payment URL missing from the reply text');
  assert.deepEqual(third.filter((p) => p.kind === 'link').map((p) => p.url), [bookings[0].payment.url]);
  assert.equal((await plec.getBooking(bookings[0].ref)).payment.status, 'unpaid', 'the agent must never pay');

  // Turn 4: cancel asks first, even when the model does not.
  script.push(
    [call('cancel_booking', { ref: bookings[0].ref })],
    (messages) => { assert.equal(lastToolResult(messages).error, 'confirmation_required'); return 'Cancel it? Nothing was paid, so there is no refund.'; },
  );
  await say(session, `Cancel ${bookings[0].ref}`);
  assert.equal((await plec.getBooking(bookings[0].ref)).status, 'pending_payment');

  script.push([call('cancel_booking', { ref: bookings[0].ref })], 'It is cancelled.');
  await say(session, 'yes');
  assert.equal((await plec.getBooking(bookings[0].ref)).status, 'cancelled');
});

test('request-to-book: details, identity and the yes in one message book in one turn as "requested"', async () => {
  await plec.reset();
  const session = newSession();
  const slot = { listingId: 'old-city-ballroom', date: '2026-10-10', startTime: '17:00', endTime: '22:00', guestCount: 100 };
  script.push(
    [call('quote', slot)],
    [call('book', { ...slot, quoteId: 'x', guestName: 'Ana Gomez', guestEmail: 'ana@example.com' })],
    (messages) => `Requested: ${lastToolResult(messages).ref}. The host still has to approve it.`,
  );
  const parts = await say(session, 'Book Old City Ballroom on October 10 from 5pm to 10pm for 100 guests. I am Ana Gomez, ana@example.com. Yes, go ahead and book it.');
  const { bookings } = await plec.listBookings();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].status, 'requested');
  assert.equal(parts.filter((p) => p.kind === 'link').length, 0, 'nothing is due yet, so no payment link');
});

test('honesty: a blackout error reaches the model verbatim and nothing is booked', async () => {
  await plec.reset();
  const session = newSession();
  script.push(
    [call('quote', { listingId: 'rooftop-at-rittenhouse', date: '2026-10-17', startTime: '18:00', endTime: '22:00', guestCount: 40 })],
    (messages) => { const r = lastToolResult(messages); assert.equal(r.error, 'blackout'); return r.message; },
  );
  const parts = await say(session, 'Is The Rooftop at Rittenhouse free on October 17, 6 to 10pm, for 40?');
  assert.match(textOf(parts), /not available|closed|blackout/i);
  assert.equal((await plec.listBookings()).bookings.length, 0);
});

test('resilience: a model outage becomes one honest line and the history stays usable', async () => {
  const session = newSession();
  const realUrl = process.env.LLM_BASE_URL;
  process.env.LLM_BASE_URL = 'http://127.0.0.1:9';
  const parts = await say(session, 'hi');
  process.env.LLM_BASE_URL = realUrl;
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /nothing was booked or changed/);
  assert.deepEqual(session.messages.map((m) => m.role), ['user', 'assistant']);
  script.push('Which city, what date, and about how many guests?');
  assert.match(textOf(await say(session, 'hi again')), /\?/);
});

test('runaway model: the loop stops, forces an answer, and never exceeds 8 model calls', async () => {
  const session = newSession();
  const before_ = requests.length;
  for (let i = 0; i < 7; i += 1) script.push([call('get_listing', { id: 'foundry-fishtown' })]);
  script.push('It holds 40 to 150 guests.');
  const parts = await say(session, 'Tell me about The Foundry at Fishtown');
  assert.equal(requests.length - before_, 8);
  assert.equal(requests.at(-1).tool_choice, 'none', 'the last round must forbid tool calls');
  assert.match(textOf(parts), /150/);
  assert.equal(parts.filter((p) => p.kind === 'card').length, 1, 'seven lookups of one listing are still one card');
});
