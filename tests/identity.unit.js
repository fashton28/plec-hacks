/**
 * Offline tests for who may do what: consent that belongs to the person who
 * asked, guest details from the same speaker, booking access on iMessage,
 * the per-session lock, and the open-question marker the group policy reads.
 *
 *   npm run test:unit
 *
 * Nothing here touches a network. The brain is driven through respond() with
 * global fetch replaced by a scripted model and a tiny in-memory sandbox.
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = '';
process.env.PLEC_SANDBOX_URL = 'http://sandbox.invalid';
process.env.PLEC_SANDBOX_KEY = 'offline-test-key';

const { respond } = await import('../agent/agent.js');
const guards = await import('../agent/guards.js');
const { withSessionLock, sessionLockCount } = await import('../agent/session.js');
const { checkWrite, checkBookingAccess, hasConsent, hasBookingIntent, isTapbackText, hasTimeFor, clampText, quoteKey, recordRef } = guards;

const SLOT = { listingId: 'foundry-fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40 };
const ANA = { id: '+15550000001' };
const BEN = { id: '+15550000002' };
const GROUP = { kind: 'imessage', group: true };
const DM = { kind: 'imessage', group: false };

/** The scripted model's queue, the requests it received, and the fake sandbox's rows and call log. */
const script = [];
const modelRequests = [];
const sandbox = { bookings: new Map(), calls: [] };
let callId = 0;
const call = (name, args) => ({ id: `call_${(callId += 1)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function seedBooking(ref, guestEmail, guestName = 'Sam Rivera') {
  sandbox.bookings.set(ref, { ref, status: 'pending_payment', listingId: SLOT.listingId, listingName: 'The Foundry at Fishtown', date: SLOT.date, startTime: SLOT.startTime, endTime: SLOT.endTime, totalCents: 181500, guestName, guestEmail, payment: { status: 'unpaid', url: `https://pay.invalid/${ref}` } });
}

function fakeSandbox(method, url, body) {
  const path = url.pathname.replace(/^\/+/, '');
  sandbox.calls.push(`${method} /${path}${url.search}`);
  if (sandbox.cutOff?.test(`${method} /${path}`)) throw new DOMException('The operation timed out.', 'TimeoutError');
  if (method === 'GET' && path === 'listings') {
    const category = url.searchParams.get('category');
    return json(200, { totalMatches: 1, results: [{ id: `${category}-1`, name: `Gotham ${category} Co`, kind: 'service', category, city: 'New York', photoUrls: [] }] });
  }
  if (method === 'POST' && path === 'quotes') return json(200, { quoteId: 'q_1', ...body, totalCents: 181500, lineItems: [] });
  if (method === 'POST' && path === 'bookings') {
    const ref = `BK-${2001 + sandbox.bookings.size}`;
    seedBooking(ref, body.guestEmail, body.guestName);
    return json(200, sandbox.bookings.get(ref));
  }
  if (method === 'GET' && path === 'bookings') {
    const email = url.searchParams.get('guestEmail');
    return json(200, { bookings: [...sandbox.bookings.values()].filter((b) => !email || b.guestEmail === email) });
  }
  const [, ref, action] = path.match(/^bookings\/([^/]+)(?:\/(cancel))?$/) ?? [];
  const booking = sandbox.bookings.get(ref);
  if (!booking) return json(404, { error: 'not_found', message: 'No such booking.' });
  if (action === 'cancel') Object.assign(booking, { status: 'cancelled', refundCents: 0 });
  return json(200, booking);
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(init.body) : undefined;
  if (url.host === 'sandbox.invalid') return fakeSandbox(init.method ?? 'GET', url, body);
  modelRequests.push(body);
  let next = script.shift();
  if (typeof next === 'function') next = next(body.messages);
  const message = typeof next === 'string' ? { role: 'assistant', content: next } : { role: 'assistant', content: '', tool_calls: next ?? [] };
  return json(200, { choices: [{ index: 0, message }] });
};

beforeEach(() => {
  script.length = 0;
  modelRequests.length = 0;
  sandbox.bookings.clear();
  sandbox.calls.length = 0;
  sandbox.cutOff = null;
});

const newSession = () => ({ messages: [], state: {} });
const lastToolResult = (messages) => JSON.parse(messages.filter((m) => m.role === 'tool').at(-1).content);
const wrote = (pattern) => sandbox.calls.filter((c) => pattern.test(c)).length;
const bookCall = (guestName, guestEmail) => call('book', { ...SLOT, quoteId: 'q_from_model', guestName, guestEmail });

/** Queue a model that tries the write straight away and reports the gate's verdict as its answer. */
function eagerModel(toolCall, errors) {
  script.push([toolCall], (messages) => {
    const result = lastToolResult(messages);
    errors.push(result.error ?? null);
    return result.error ? 'Need to hear it from the right person first. Want me to go ahead?' : 'All done.';
  });
}

/** Ana asks for a quote in the group and gives her details; the over-eager book attempt is refused. */
async function anaGetsAQuote(session) {
  const errors = [];
  script.push([call('quote', SLOT)]);
  eagerModel(bookCall('Ana Lopez', 'ana@example.com'), errors);
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec, price The Foundry at Fishtown Oct 10 6pm to 11pm for 40. I am Ana Lopez, ana@example.com' });
  assert.deepEqual(errors, ['confirmation_required']);
}

test('group: nothing another member types books the quote Ana asked for; her own yes does', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  assert.deepEqual(session.state.quotes[quoteKey(SLOT)].requesters, { [ANA.id]: 1 });

  for (const text of ['yes', 'ok', 'lol', 'sounds good see you at 8']) {
    const errors = [];
    eagerModel(bookCall('Ana Lopez', 'ana@example.com'), errors);
    await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text });
    assert.deepEqual(errors, ['requester_confirmation_required'], text);
  }
  assert.equal(wrote(/^POST \/bookings$/), 0);

  const errors = [];
  eagerModel(bookCall('Ana Lopez', 'ana@example.com'), errors);
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes' });
  assert.deepEqual(errors, [null]);
  assert.equal(wrote(/^POST \/bookings$/), 1);
});

test('group: Ana chatting is not Ana saying yes', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  for (const text of ['lol', 'where are we eating', 'ok wait dont book yet', 'Liked “Want me to go ahead and book it?”']) {
    const errors = [];
    eagerModel(bookCall('Ana Lopez', 'ana@example.com'), errors);
    await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text });
    assert.deepEqual(errors, ['confirmation_required'], text);
  }
  assert.equal(wrote(/^POST \/bookings$/), 0);
});

test('group: a message with no identifiable sender can never be a yes', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  const errors = [];
  eagerModel(bookCall('Ana Lopez', 'ana@example.com'), errors);
  await respond({ sessionId: 's', session, sender: undefined, channel: GROUP, text: 'yes' });
  assert.deepEqual(errors, ['sender_unknown']);
});

test('group: guest details must be typed by the person booking, not by someone else in the chat', async () => {
  const session = newSession();
  script.push('Noted.');
  await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text: 'plec fyi I am Ben Ortiz, ben@example.com' });
  script.push([call('quote', SLOT)], 'That comes to $1,815.00. Want me to lock it in?');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec price The Foundry at Fishtown Oct 10 6pm to 11pm for 40' });

  const errors = [];
  eagerModel(bookCall('Ben Ortiz', 'ben@example.com'), errors);
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes' });
  assert.deepEqual(errors, ['guest_details_required']);
  assert.equal(wrote(/^POST \/bookings$/), 0);
  assert.equal(session.state.guests[ANA.id], undefined, "Ben's email was not filed under Ana");
  assert.equal(session.state.guests[BEN.id].email, 'ben@example.com');
});

test('group: another member cannot cancel the booking Ana raised; Ana can', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  script.push([bookCall('Ana Lopez', 'ana@example.com')], 'Booked.');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes, go ahead' });
  const [ref] = [...sandbox.bookings.keys()];

  let errors = [];
  eagerModel(call('cancel_booking', { ref }), errors);
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: `plec cancel ${ref}` });
  assert.deepEqual(errors, ['confirmation_required'], 'a cancellation is asked about first');

  for (const text of ['yes', 'ok', 'lol', 'sounds good see you at 8']) {
    errors = [];
    eagerModel(call('cancel_booking', { ref }), errors);
    await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text });
    assert.deepEqual(errors, ['requester_confirmation_required'], text);
  }
  assert.equal(sandbox.bookings.get(ref).status, 'pending_payment');

  errors = [];
  eagerModel(call('cancel_booking', { ref }), errors);
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: "yes, I don't need it anymore" });
  assert.deepEqual(errors, [null]);
  assert.equal(sandbox.bookings.get(ref).status, 'cancelled');
});

/** One eager write attempt by `sender`; returns the gate's verdict (null when the write ran). */
async function attempt(session, toolCall, sender, text, channel = GROUP) {
  const errors = [];
  eagerModel(toolCall, errors);
  await respond({ sessionId: 's', session, sender, channel, text });
  return errors[0];
}

test('group: a member who types the reference and then says yes still cannot cancel or move a booking Ana made here', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  script.push([bookCall('Ana Lopez', 'ana@example.com')], 'Booked.');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes, go ahead' });
  const [ref] = [...sandbox.bookings.keys()];
  assert.equal(session.state.refs[ref].by, ANA.id);

  assert.equal(await attempt(session, call('cancel_booking', { ref }), BEN, `plec cancel ${ref}`), 'requester_confirmation_required');
  assert.equal(await attempt(session, call('cancel_booking', { ref }), BEN, 'yes'), 'requester_confirmation_required');
  assert.equal(await attempt(session, call('reschedule_booking', { ref, date: '2026-12-25' }), BEN, `plec move ${ref} to dec 25`), 'requester_confirmation_required');
  assert.equal(await attempt(session, call('reschedule_booking', { ref, date: '2026-12-25' }), BEN, 'ok'), 'requester_confirmation_required');
  assert.equal(sandbox.bookings.get(ref).status, 'pending_payment');
  assert.equal(wrote(/^POST \/bookings\/.+\/(cancel|reschedule)$/), 0);

  // Guessing the next reference before it exists does not make the booking Ben's either.
  const refs = {};
  recordRef(refs, 'BK-3001', { turn: 1, senderId: BEN.id });
  recordRef(refs, 'BK-3001', { turn: 2, senderId: ANA.id, created: true });
  assert.equal(refs['BK-3001'].by, ANA.id);

  assert.equal(await attempt(session, call('cancel_booking', { ref }), ANA, `plec cancel ${ref}`), 'confirmation_required');
  assert.equal(await attempt(session, call('cancel_booking', { ref }), ANA, 'yes, cancel that'), null);
  assert.equal(sandbox.bookings.get(ref).status, 'cancelled');
});

test('group: a price check by someone else does not take the quote away from Ana', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  script.push([call('quote', SLOT)], 'Still $1,815.00 all in.');
  await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text: 'plec how much was that again' });
  assert.deepEqual(session.state.quotes[quoteKey(SLOT)].requesters, { [ANA.id]: 1, [BEN.id]: 2 });

  assert.equal(await attempt(session, bookCall('Ana Lopez', 'ana@example.com'), BEN, 'yes'), 'guest_details_required', 'Ben may book it for himself, never under details Ana typed');
  assert.equal(await attempt(session, bookCall('Ana Lopez', 'ana@example.com'), ANA, 'yes'), null);
  assert.equal(wrote(/^POST \/bookings$/), 1);
});

test('group: a lookup by someone else neither locks the owner out nor lets their bare yes cancel', async () => {
  seedBooking('BK-1001', 'ana@example.com', 'Ana Lopez');
  const session = newSession();
  script.push([call('list_bookings', { guestEmail: 'ana@example.com' })], 'Found one.');
  await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text: 'plec what bookings does ana@example.com have' });
  script.push([call('list_bookings', { guestEmail: 'ana@example.com' })], 'You have The Foundry on October 10. Cancel it?');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec cancel my booking, it is under ana@example.com' });
  assert.equal(session.state.refs['BK-1001'].last, ANA.id);

  assert.equal(await attempt(session, call('cancel_booking', { ref: 'BK-1001' }), BEN, 'yes'), 'requester_confirmation_required', 'the question was put to Ana');
  assert.equal(sandbox.bookings.get('BK-1001').status, 'pending_payment');
  assert.equal(await attempt(session, call('cancel_booking', { ref: 'BK-1001' }), ANA, 'yes'), null);
  assert.equal(sandbox.bookings.get('BK-1001').status, 'cancelled');
});

test('group: one person is one speaker however their handle is spelled', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  assert.equal(await attempt(session, bookCall('Ana Lopez', 'ana@example.com'), { id: '+1 (555) 000-0001 ' }, 'yes'), null);
  assert.deepEqual(Object.keys(session.state.speakers), [ANA.id]);
  assert.equal(guards.canonicalSender('Ana@iCloud.com'), 'ana@icloud.com');
  assert.equal(guards.canonicalSender('15550000001'), ANA.id);
  assert.equal(guards.canonicalSender('  '), null);
});

test('group: the history carries speaker tags and the prompt explains them; the bare text is what gets parsed', async () => {
  const session = newSession();
  script.push('Hey both.', 'Got it.');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec what about BK-1001, I am ana@example.com' });
  await respond({ sessionId: 's', session, sender: BEN, channel: GROUP, text: 'plec hi' });
  assert.deepEqual(session.messages.filter((m) => m.role === 'user').map((m) => m.content), ['[A] plec what about BK-1001, I am ana@example.com', '[B] plec hi']);
  assert.match(modelRequests.at(-1).messages[0].content, /Group chat/);
  assert.equal(session.state.guests[ANA.id].email, 'ana@example.com');
  assert.deepEqual(session.state.refs['BK-1001'], { by: ANA.id, raised: { [ANA.id]: 1 }, last: ANA.id, created: false });
  assert.ok(!session.state.typed[ANA.id].includes('[A]'), 'the tag never reaches the text that emails and names are matched against');
});

test('HTTP: no sender, no tags, no group prompt, and a seeded booking opens by reference in a fresh session', async () => {
  seedBooking('BK-1001', 'sam@example.com');
  const session = newSession();
  script.push([call('get_booking', { ref: 'BK-1001' })], (messages) => `It is ${lastToolResult(messages).status}.`);
  const parts = await respond({ sessionId: 's', session, text: 'What is the status of BK-1001?' });
  assert.match(parts[0].text, /pending_payment/);
  assert.equal(session.messages[0].content, 'What is the status of BK-1001?');
  assert.ok(!/Group chat/.test(modelRequests.at(-1).messages[0].content));
  assert.deepEqual(session.state.awaiting, {}, 'awaiting is left alone without a sender');

  script.push([call('list_bookings', {})], (messages) => `You have ${lastToolResult(messages).bookings.length}.`);
  assert.match((await respond({ sessionId: 's', session, text: 'show all bookings' }))[0].text, /You have 1/);
});

test('HTTP: a yes in the next turn still cancels a seeded booking', async () => {
  seedBooking('BK-1001', 'sam@example.com');
  const session = newSession();
  let errors = [];
  eagerModel(call('cancel_booking', { ref: 'BK-1001' }), errors);
  await respond({ sessionId: 's', session, text: 'Cancel BK-1001' });
  assert.deepEqual(errors, ['confirmation_required']);
  errors = [];
  eagerModel(call('cancel_booking', { ref: 'BK-1001' }), errors);
  await respond({ sessionId: 's', session, text: 'yes' });
  assert.deepEqual(errors, [null]);
  assert.equal(sandbox.bookings.get('BK-1001').status, 'cancelled');
});

test('iMessage: a stranger cannot open, cancel or list a booking until they give the email it is under', async () => {
  seedBooking('BK-1001', 'sam@example.com');
  const session = newSession();
  for (const name of ['get_booking', 'resend_payment_link', 'cancel_booking', 'reschedule_booking']) {
    const errors = [];
    eagerModel(call(name, { ref: 'BK-1001', date: '2026-10-17' }), errors);
    await respond({ sessionId: 'imessage:dm', session, sender: BEN, channel: DM, text: 'yes do it for BK-1001' });
    assert.deepEqual(errors, ['not_found'], name);
  }
  assert.equal(wrote(/^POST /), 0);
  assert.ok(!JSON.stringify(session.messages).includes('sam@example.com'), "the owner's details never reached the model");

  const errors = [];
  eagerModel(call('list_bookings', {}), errors);
  await respond({ sessionId: 'imessage:dm', session, sender: BEN, channel: DM, text: 'show my bookings' });
  assert.deepEqual(errors, ['email_required']);
  assert.equal(wrote(/^GET \/bookings(\?|$)/), 0, 'the unfiltered list never ran');
});

test('iMessage: the guest email opens the booking, and list_bookings is pinned to it', async () => {
  seedBooking('BK-1001', 'sam@example.com');
  seedBooking('BK-1002', 'someone.else@example.com');
  const session = newSession();
  const sam = { id: '+15550000003' };
  script.push([call('get_booking', { ref: 'BK-1001' })], (messages) => `It is ${lastToolResult(messages).status}.`);
  const parts = await respond({ sessionId: 'imessage:dm2', session, sender: sam, channel: DM, text: 'status of BK-1001? I booked as sam@example.com' });
  assert.match(parts[0].text, /pending_payment/);

  script.push([call('list_bookings', { guestEmail: 'someone.else@example.com' })], (messages) => lastToolResult(messages).bookings.map((b) => b.ref).join(','));
  const listed = await respond({ sessionId: 'imessage:dm2', session, sender: sam, channel: DM, text: 'and all my bookings' });
  assert.equal(listed[0].text, 'BK-1001');
  assert.equal(sandbox.calls.at(-1), 'GET /bookings?guestEmail=sam%40example.com', 'the filter is an address this sender typed, not the one the model asked for');
});

test('iMessage: a booking made in this conversation opens without an email check', () => {
  const refs = {};
  recordRef(refs, 'bk-2001', { turn: 3, senderId: ANA.id, created: true });
  assert.equal(checkBookingAccess('get_booking', { ref: 'BK-2001' }, { refs, emails: [] }).allowed, true);
  assert.equal(checkBookingAccess('cancel_booking', { ref: 'BK-2002' }, { refs, emails: [] }).allowed, false);
  assert.equal(checkBookingAccess('search_listings', {}, { refs, emails: [] }).allowed, true);
});

test('awaiting: set for the sender when the reply asks something, cleared when it does not', async () => {
  const session = newSession();
  const before = Date.now();
  script.push('Fun! What city, what date, and how many people?');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec we need a venue' });
  assert.ok(session.state.awaiting[ANA.id] >= before);
  assert.equal(session.state.awaiting[BEN.id], undefined);

  script.push('Philly it is.');
  await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'plec Philadelphia' });
  assert.equal(ANA.id in session.state.awaiting, false);
});

test('consent wording: the curly apostrophe iOS types reads the same as a straight one', () => {
  for (const no of ['don\u2019t book it', 'ok don\u2019t book it yet?', 'ok don\u2019t', 'please don\u2019t book yet, ok', 'I don\u2019t confirm']) {
    assert.ok(!hasConsent(no) && guards.isNegative(no), no);
  }
  assert.ok(!hasConsent('ok don\u2019t cancel', { cancelling: true }));
  assert.ok(hasConsent('yes, let\u2019s do it'));
  assert.ok(hasConsent('yes, we don\u2019t need it anymore', { cancelling: true }));
});

test('consent wording: hedges, conditions, relayed answers and questions are not a yes', () => {
  const refused = [
    'not ok', 'not sure', "I'm not sure, ok let me think", "can't confirm yet", 'ok let me ask my boss first', 'ok so what is the total',
    'is that ok with the venue?', 'is it ok to bring a dog?', 'Is parking ok there?', 'would it be perfect for a wedding?', 'yes?', 'ok?',
    'that is not correct', 'far from perfect', 'maybe yes', 'yes if it is refundable', 'yes tomorrow', 'Ana said yes', 'yes but not yet',
    'sure, no thanks', 'yeah no', 'ok actually make it 50 people', 'what would the refund be? ok thanks', 'is it ok if I think about it?',
    'I am Sam Rivera, sam@example.com. Give me a minute to think about it', "I'm Sam Rivera sam@example.com - hang on, I need to ask my boss",
    'a\u00FAn no', 's\u00ED pero espera', 'ok pero no todavia', 'si no te importa, dime el precio otra vez', 'si puedes, m\u00E1ndame fotos',
  ];
  for (const text of refused) assert.ok(!hasConsent(text), text);
  for (const text of ['should I book it or look at others?', 'can I book later?', 'what happens if I book and then cancel?', 'I will book tomorrow', 'let me think about it before we book']) {
    assert.ok(!hasConsent(text) && !(hasBookingIntent(text) && !guards.isNegative(text)), text);
  }
});

test('consent wording: a yes with a harmless no beside it is still a yes', () => {
  const agreed = [
    'yes, no rush', 's\u00ED, no hay problema', 's\u00ED, no te preocupes', "yes, don't worry", 'yes, no changes', 'yes, no allergies or anything',
    's\u00ED, no tengo dudas', "yes can't wait", 'yes actually', 'k', 'kk', 'alright', 'please do', 'No changes, go ahead and book it', 'yes, no notes needed',
    "yes - book it, don't worry about the dog note", 'yes, move it to the 11th instead', 'yes I know it is non refundable', 'I said yes',
    'Book it for tomorrow at 6pm, yes go ahead', 'Book The Foundry if it is free on Oct 10. Yes, I confirm, go ahead.', 'Yes please! Can you send me the payment link?',
    'si', 'si, por favor', 'claro que s\u00ED',
  ];
  for (const text of agreed) assert.ok(hasConsent(text), text);
  for (const text of ['can you book it?', 'could you lock it in for me?', 'book it', '\u00BFpuedes reservarlo?']) assert.ok(hasBookingIntent(text), text);
  assert.ok(hasConsent('\u{1F44D}', { thumbsUp: true }) && !hasConsent('\u{1F44D}'), 'a lone thumbs-up counts only where the caller allows it');
});

test('consent wording: confirming a cancellation may restate it and give the reason, refusing it may not hide behind one', () => {
  const agreed = [
    'yes, cancel that', 'yes cancel that booking', 'yes please cancel that one', 'yes, cancel it, no longer needed', 'yes, stop the booking',
    's\u00ED, ya no la necesito', 'yes, no way we can make it', 'Yes, cancel it. No refund is fine.', 'yes please cancel, I can not make it',
    'yes cancel. we do not need the venue anymore', "yes, I don't need it anymore",
  ];
  for (const text of agreed) assert.ok(hasConsent(text, { cancelling: true }), text);
  const refused = ["ok, I don't want it cancelled after all... keep it", 'ok I don\u2019t want it cancelled', "ok don't cancel it", "ok I don't want to cancel", 'not sure, ok let me check'];
  for (const text of refused) assert.ok(!hasConsent(text, { cancelling: true }), text);
  assert.ok(!hasConsent('yes, cancel that'), 'outside a cancellation, "cancel that" still means stop');
});

test('cancel gate: natural confirmations cancel, a refusal dressed as a reason does not, and a thumbs-up only counts outside a group', () => {
  const state = { turn: 2, quotes: {}, refs: { 'BK-1001': { by: null, raised: { '': 1 }, last: '', created: false } } };
  const verdict = (userText, extra = {}) => checkWrite('cancel_booking', { ref: 'BK-1001' }, { state, userText, userHistory: '', ...extra });
  for (const text of ['yes, cancel that', 'Yes, cancel it. No refund is fine.', 'yes, go ahead and cancel the booking', '\u{1F44D}']) assert.equal(verdict(text).allowed, true, text);
  for (const text of ["ok, I don't want it cancelled after all... keep it", 'ok don\u2019t cancel', 'is it ok if I think about it?', 'what would the refund be? ok thanks']) {
    assert.equal(verdict(text).result?.error, 'confirmation_required', text);
  }
  const groupState = { ...state, refs: { 'BK-1001': { by: ANA.id, raised: { [ANA.id]: 1 }, last: ANA.id, created: true } } };
  assert.equal(checkWrite('cancel_booking', { ref: 'BK-1001' }, { state: groupState, userText: '\u{1F44D}', userHistory: '', senderId: ANA.id, group: true }).result.error, 'confirmation_required');
});

test('consent wording: a negative beats an affirmative, idioms and quoted text do not fool it', () => {
  for (const yes of ['yes', 'yes, go ahead', 'no need to confirm, just book it', 'No need to ask, go for it', 'yes no problem, go ahead', 'Si, adelante']) assert.ok(hasConsent(yes), yes);
  for (const no of ['ok wait dont book yet', 'sure but hold on', 'ok dont cancel it', 'no', 'lol', 'where are we eating', 'ok "yes" is what he said, but wait']) assert.ok(!hasConsent(no), no);
  assert.ok(!hasConsent('you asked "shall I go ahead?"'), 'our own question quoted back is not a yes');
});

test('consent wording: SMS tapback text is never consent', () => {
  const tapbacks = ['Liked “Shall I go ahead and book it?”', 'Loved "Want me to lock it in?"', 'Emphasized “Shall I go ahead?”', 'Disliked “ok, go ahead?”', 'Laughed at "yes"', 'Questioned “Confirm?”', 'Reacted 👍 to “Shall I book it?”', 'Loved an image'];
  for (const text of tapbacks) {
    assert.ok(isTapbackText(text), text);
    assert.ok(!hasConsent(text) && !hasBookingIntent(text), text);
  }
  assert.ok(!isTapbackText('Loved it, go ahead'));
});

test('an earlier quote is only booked by a message that asks for it', () => {
  const state = { turn: 2, refs: {}, quotes: { [quoteKey(SLOT)]: { quoteId: 'q_real', totalFormatted: '$1,815.00', requesters: { '': 1 } } } };
  const args = { ...SLOT, guestName: 'Sam Rivera', guestEmail: 'sam@example.com' };
  const verdict = (userText) => checkWrite('book', args, { state, userText, userHistory: `sam rivera sam@example.com\n${userText.toLowerCase()}` });
  for (const text of ['book it', 'lock it in please', 'can you book it?', 'resérvalo']) assert.equal(verdict(text).allowed, true, text);
  const notAsking = [
    'lol', 'where are we eating', 'haha Ben is always late', 'dont book it', 'Liked “Want me to book it?”',
    // A name and an email are details, not a yes: the scenario is "no booking without a name, an email, and a yes".
    'Sam Rivera, sam@example.com', 'my email is sam@example.com, Sam Rivera. Is that the final price or are there taxes?',
    'I am Sam Rivera, sam@example.com. Let me check with my partner first though, is there parking?', 'should I book it or look at others?',
  ];
  for (const text of notAsking) assert.equal(verdict(text).result?.error, 'confirmation_required', text);
});

test('deadline: a write never starts in the last 6 seconds, a read never in the last 3', () => {
  assert.equal(hasTimeFor('book', 6_000), true);
  assert.equal(hasTimeFor('book', 5_999), false);
  assert.equal(hasTimeFor('cancel_booking', 4_000), false);
  assert.equal(hasTimeFor('get_listing', 4_000), true);
  assert.equal(hasTimeFor('get_listing', 2_999), false);
});

test('deadline: a turn that runs out of budget before its write answers honestly and books nothing', async (t) => {
  const session = newSession();
  await anaGetsAQuote(session);
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  // The model "thinks" for 31 seconds, leaving under 6 seconds of the 36 second budget.
  script.push(() => { const at = realNow() + 31_000; Date.now = () => at; return [bookCall('Ana Lopez', 'ana@example.com')]; });
  const parts = await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes' });
  Date.now = realNow;
  assert.match(parts[0].text, /nothing was booked or changed/);
  assert.equal(wrote(/^POST \/bookings$/), 0);
  assert.deepEqual(session.messages.slice(-2).map((m) => m.role), ['user', 'assistant'], 'the half-finished tool exchange was dropped');
});

test('deadline: a sandbox call gets only what is left of the turn, never the full 15 seconds', async () => {
  const { createPlecClient } = await import('../agent/plec.js');
  const hangs = (url, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });
  const client = createPlecClient({ key: 'k', baseUrl: 'https://sandbox.invalid', fetchImpl: hangs }).withTimeout(30);
  const startedAt = Date.now();
  await assert.rejects(client.getBooking('BK-1001'), (err) => err.error === 'network' && /timed out/.test(err.message));
  assert.ok(Date.now() - startedAt < 2_000);
});

test('a write that is cut off is reported as unknown, never as "nothing was changed"', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  sandbox.cutOff = /^POST \/bookings$/;
  script.push([bookCall('Ana Lopez', 'ana@example.com')], () => { throw new Error('model down'); });
  const parts = await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes' });
  assert.match(lastToolResult(modelRequests.at(-1).messages).message, /NOT known whether the change went through/);
  assert.match(parts[0].text, /can't tell yet if it went through/);
  assert.doesNotMatch(parts[0].text, /nothing was booked/);
});

test('a reply that fails after a booking says what happened in words: no ISO date, no status enum, and not confirmed until paid', async () => {
  const session = newSession();
  await anaGetsAQuote(session);
  script.push([bookCall('Ana Lopez', 'ana@example.com')], () => { throw new Error('model down'); });
  const [words] = await respond({ sessionId: 's', session, sender: ANA, channel: GROUP, text: 'yes' });
  assert.match(words.text, /holding BK-2001 at The Foundry at Fishtown for October 10, \$1,815\.00 all in\. It isn't confirmed until it's paid\./);
  assert.doesNotMatch(words.text, /2026-10-10|pending_payment|18:00/);
  assert.match(words.text, /https:\/\/pay\.invalid\/BK-2001/);
});

test('two searches in one round both earn cards', async () => {
  const session = newSession();
  script.push([call('search_listings', { category: 'dj' }), call('search_listings', { category: 'photographer' })], 'I would go with Gotham dj Co for music and Gotham photographer Co for photos.');
  const parts = await respond({ sessionId: 's', session, text: 'I need a DJ and a photographer in New York for 100 people' });
  assert.deepEqual(parts.filter((p) => p.kind === 'card').map((p) => p.title).sort(), ['Gotham dj Co', 'Gotham photographer Co']);
});

test('input clamp: text is cut at 2000 characters before it reaches the history', async () => {
  assert.equal(clampText('x'.repeat(5000)).length, 2000);
  const session = newSession();
  script.push('That was a lot. What are you planning?');
  await respond({ sessionId: 's', session, text: 'y'.repeat(5000) });
  assert.equal(session.messages[0].content.length, 2000);
});

test('withSessionLock: one session runs in order, other sessions are not held up', async () => {
  const log = [];
  const step = (name, ms) => async () => { log.push(`${name} start`); await new Promise((r) => setTimeout(r, ms)); log.push(`${name} end`); return name; };
  const results = await Promise.all([
    withSessionLock('lock-a', step('a1', 30)),
    withSessionLock('lock-a', step('a2', 5)),
    withSessionLock('lock-b', step('b1', 1)),
    withSessionLock('lock-a', step('a3', 1)),
  ]);
  assert.deepEqual(results, ['a1', 'a2', 'b1', 'a3']);
  assert.deepEqual(log.filter((l) => l.startsWith('a')), ['a1 start', 'a1 end', 'a2 start', 'a2 end', 'a3 start', 'a3 end']);
  assert.ok(log.indexOf('b1 end') < log.indexOf('a1 end'), 'another session ran while a1 held its lock');
});

test('withSessionLock: released when the turn rejects or throws, and idle entries are cleaned up', async () => {
  const failed = withSessionLock('lock-c', async () => { throw new Error('boom'); });
  const threw = withSessionLock('lock-c', () => { throw new Error('sync boom'); });
  const after = withSessionLock('lock-c', () => 'still runs');
  await assert.rejects(failed, /boom/);
  await assert.rejects(threw, /sync boom/);
  assert.equal(await after, 'still runs');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessionLockCount(), 0);
});
