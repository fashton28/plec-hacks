/**
 * Offline tests for the rules that must hold no matter what the model says:
 * consent gates (agent/guards.js) and the parts builder (agent/parts.js).
 *
 *   npm run test:unit
 */

import test from 'node:test';
import { findMentionedListings, screenSearch, unbookableReason } from '../agent/catalogue.js';
import assert from 'node:assert/strict';
import { checkWrite, isAffirmative, isNegative, normalizeCity, prepareSearch, quoteKey, findEmail, findRefs } from '../agent/guards.js';
import { amountAppears, buildParts, cardFor, dateInWords, formatCents, plainText, timeInWords, scrubPlantedCodes, wantsPhotos, withMoney } from '../agent/parts.js';

const QUOTE_INPUTS = { listingId: 'foundry-fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40 };
const FOUNDRY = {
  id: 'foundry-fishtown', name: 'The Foundry at Fishtown', category: 'loft', city: 'Philadelphia', neighborhood: 'Fishtown',
  capacity: { min: 40, max: 150 }, pricing: { model: 'hourly', rateCents: 30000, minHours: 4 },
  photoUrls: ['https://picsum.photos/seed/foundry-fishtown-1/800/500', 'https://picsum.photos/seed/foundry-fishtown-2/800/500'],
  mapUrl: 'https://maps.example/foundry',
};
const TAP_ROOM = { id: 'manayunk-tap-room', name: 'Manayunk Tap Room (back room)', category: 'bar', city: 'Philadelphia', pricing: { model: 'hourly', rateCents: 15000 }, photoUrls: [] };

function stateWithQuote(quoteTurn, turn) {
  return {
    turn, refs: {}, seen: {},
    quotes: { [quoteKey(QUOTE_INPUTS)]: { quoteId: 'q_real', totalCents: 181500, totalFormatted: '$1,815.00', requesters: { '': quoteTurn } } },
  };
}
const bookArgs = (extra = {}) => ({ ...QUOTE_INPUTS, quoteId: 'q_from_model', guestName: 'Sam Rivera', guestEmail: 'sam@example.com', ...extra });
const emptyTurn = (userText = '') => ({ userText, searchResults: [], fetched: [], quotes: [], payments: [], bookingRefs: [], writes: [] });

test('affirmative and negative detection, English and Spanish', () => {
  for (const yes of ['yes', 'Yes please, go ahead', 'ok book it', 'sí', 'Si, adelante', 'confirmo', 'sounds good', "let's do it"]) assert.ok(isAffirmative(yes), yes);
  for (const no of ['Book The Foundry for October 10', 'Cancel BK-1001', 'Please cancel BK-1001', 'no', 'No, not yet', 'what is the capacity?', 'Oklahoma', 'yesterday']) assert.ok(!isAffirmative(no), no);
  for (const no of ['no', "don't", 'wait, not yet', 'actually make it 7pm', 'todavía no']) assert.ok(isNegative(no), no);
  assert.ok(!isNegative('Sam Rivera, sam@example.com'));
});

test('book is refused without a matching quote', () => {
  const verdict = checkWrite('book', bookArgs({ endTime: '22:00' }), { state: stateWithQuote(1, 2), userText: 'yes', userHistory: 'sam rivera sam@example.com yes' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.result.error, 'quote_required');
});

test('book is refused when the guest details did not come from the user', () => {
  const verdict = checkWrite('book', bookArgs({ guestName: 'Guest', guestEmail: 'guest@example.com' }), { state: stateWithQuote(1, 2), userText: 'yes', userHistory: 'book the foundry\nyes' });
  assert.equal(verdict.result.error, 'guest_details_required');
});

test('book is refused in the turn that produced the quote unless the user said yes', () => {
  const ctx = { state: stateWithQuote(1, 1), userText: 'Book The Foundry Oct 10 6pm to 11pm for 40. I am Sam Rivera, sam@example.com', userHistory: 'book the foundry oct 10 6pm to 11pm for 40. i am sam rivera, sam@example.com' };
  assert.equal(checkWrite('book', bookArgs(), ctx).result.error, 'confirmation_required');
});

test('book is allowed on a later yes, and always uses the quoteId the sandbox issued', () => {
  const verdict = checkWrite('book', bookArgs(), { state: stateWithQuote(1, 2), userText: 'yes', userHistory: 'i am sam rivera, sam@example.com\nyes' });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.args.quoteId, 'q_real');
});

test('book is allowed in one turn when details, identity and an explicit yes arrive together', () => {
  const text = 'Book it for Sam Rivera, sam@example.com. Yes, go ahead and book it.';
  assert.equal(checkWrite('book', bookArgs(), { state: stateWithQuote(1, 1), userText: text, userHistory: text.toLowerCase() }).allowed, true);
});

test('book is refused after a quote when the user pushes back', () => {
  const verdict = checkWrite('book', bookArgs(), { state: stateWithQuote(1, 2), userText: 'wait, not yet', userHistory: 'sam rivera sam@example.com\nwait, not yet' });
  assert.equal(verdict.result.error, 'confirmation_required');
});

test('cancel and reschedule need a booking discussed earlier AND a yes now', () => {
  const state = { turn: 1, refs: { 'BK-1001': { by: null, raised: { '': 1 }, last: '', created: false } }, quotes: {}, seen: {} };
  assert.equal(checkWrite('cancel_booking', { ref: 'BK-1001' }, { state, userText: 'Cancel BK-1001', userHistory: '' }).allowed, false);
  assert.equal(checkWrite('cancel_booking', { ref: 'BK-1001' }, { state, userText: 'Yes, cancel BK-1001 right now', userHistory: '' }).allowed, false, 'first mention, even with a yes, still gets asked');
  state.turn = 2;
  assert.equal(checkWrite('cancel_booking', { ref: 'bk-1001' }, { state, userText: 'Cancel it', userHistory: '' }).allowed, false);
  const ok = checkWrite('cancel_booking', { ref: 'bk-1001' }, { state, userText: 'yes', userHistory: '' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.args.ref, 'BK-1001');
  assert.equal(checkWrite('reschedule_booking', { ref: 'BK-1001', date: '2026-10-17' }, { state, userText: 'sí, adelante', userHistory: '' }).allowed, true);
  assert.equal(checkWrite('reschedule_booking', { ref: 'BK-2000', date: '2026-10-17' }, { state, userText: 'yes', userHistory: '' }).allowed, false);
});

test('reads are never gated', () => {
  assert.equal(checkWrite('get_listing', { id: 'x' }, { state: { turn: 1, refs: {}, quotes: {} }, userText: '', userHistory: '' }).allowed, true);
});

test('city aliases and search defaults', () => {
  assert.equal(normalizeCity('philly'), 'Philadelphia');
  assert.equal(normalizeCity('NYC'), 'New York');
  assert.equal(normalizeCity('Washington DC'), 'Washington');
  assert.equal(normalizeCity('Washington, D.C.'), 'Washington');
  assert.equal(normalizeCity(''), undefined);
  const state = { city: 'Philadelphia', guestCount: 60 };
  assert.deepEqual(prepareSearch({ kind: 'venue' }, state), { kind: 'venue', city: 'Philadelphia', guests: 60, limit: 10 });
  assert.deepEqual(prepareSearch({ kind: 'service', category: 'photographer' }, state), { kind: 'service', category: 'photographer', city: 'Philadelphia', limit: 10 });
  assert.deepEqual(prepareSearch({ city: 'NYC', guests: 20, limit: 5 }, state), { city: 'New York', guests: 20, limit: 5 });
});

test('email and booking reference extraction', () => {
  assert.equal(findEmail('I am Sam, sam.rivera+party@example.co.uk, thanks'), 'sam.rivera+party@example.co.uk');
  assert.equal(findEmail('no email here'), null);
  assert.deepEqual(findRefs('cancel bk-1001 and BK-1002 please'), ['BK-1001', 'BK-1002']);
});

test('money formatting and the evaluator-style amount match', () => {
  assert.equal(formatCents(181500), '$1,815.00');
  assert.equal(formatCents(16550), '$165.50');
  assert.deepEqual(withMoney({ totalCents: 181500, lineItems: [{ amountCents: 15000 }] }), { totalCents: 181500, totalFormatted: '$1,815.00', lineItems: [{ amountCents: 15000, amountFormatted: '$150.00' }] });
  for (const ok of ['Total $1,815.00 all in', 'that is $1,815.', 'about 1815 dollars', '1,815.00']) assert.ok(amountAppears(ok, 181500), ok);
  for (const bad of ['$18,150', '$1,815.50', '$11,815.00', 'subtotal $1,650.00']) assert.ok(!amountAppears(bad, 181500), bad);
});

test('cards use the exact listing name and only sandbox data', () => {
  const card = cardFor(FOUNDRY);
  assert.equal(card.title, 'The Foundry at Fishtown');
  assert.equal(card.subtitle, 'loft - Fishtown, Philadelphia - 40 to 150 guests - $300/hour, 4 hour minimum');
  assert.equal(card.url, FOUNDRY.mapUrl);
  assert.deepEqual(cardFor({ name: 'X', pricing: { model: 'flat', rateCents: 120000 } }), { kind: 'card', title: 'X', subtitle: '$1,200 flat', photoUrls: [] });
});

test('search results become cards: the named ones, or all of them when none is named', () => {
  const state = { seen: { [FOUNDRY.id]: FOUNDRY, [TAP_ROOM.id]: TAP_ROOM } };
  const turn = { ...emptyTurn('venues for 40 in Philadelphia'), searchResults: [FOUNDRY, TAP_ROOM] };
  const named = buildParts('Manayunk Tap Room would suit you.', turn, state);
  assert.deepEqual(named.filter((p) => p.kind === 'card').map((p) => p.title), ['Manayunk Tap Room (back room)']);
  const all = buildParts('Here are two that fit.', turn, state);
  assert.equal(all.filter((p) => p.kind === 'card').length, 2);
  assert.equal(all[0].kind, 'text');
});

test('an invented listing never becomes a card', () => {
  const parts = buildParts('Try the Grand Imaginary Ballroom.\nCARDS: grand-imaginary-ballroom', emptyTurn('venues?'), { seen: {} });
  assert.deepEqual(parts, [{ kind: 'text', text: 'Try the Grand Imaginary Ballroom.' }]);
});

test('photo requests produce image parts', () => {
  assert.ok(wantsPhotos('Can I see photos of The Foundry?'));
  assert.ok(wantsPhotos('¿Tienes fotos?'));
  assert.ok(!wantsPhotos('How many people does it hold?'));
  const turn = { ...emptyTurn('Show me photos of The Foundry at Fishtown'), fetched: [FOUNDRY] };
  const parts = buildParts('Here it is.', turn, { seen: { [FOUNDRY.id]: FOUNDRY } });
  assert.equal(parts.filter((p) => p.kind === 'image').length, 2);
  assert.equal(parts.filter((p) => p.kind === 'card').length, 0);
});

test('the exact total, the reference and the payment URL always reach the text', () => {
  const url = 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_abc';
  const turn = { ...emptyTurn('yes'), quotes: [{ totalCents: 181500 }], bookingRefs: ['BK-1001'], payments: [{ ref: 'BK-1001', url }] };
  const parts = buildParts('All set.', turn, { seen: {} });
  assert.ok(parts[0].text.includes('$1,815.00'));
  assert.ok(parts[0].text.includes('BK-1001'));
  assert.ok(parts[0].text.includes(url));
  assert.deepEqual(parts.at(-1), { kind: 'link', label: 'Pay to confirm BK-1001', url });
  const already = buildParts(`Booked BK-1001 for $1,815.00. Pay at ${url}`, turn, { seen: {} });
  assert.equal(already[0].text, `Booked BK-1001 for $1,815.00. Pay at ${url}`);
});

test('a dash between two values stays a range, any other long dash becomes a comma', () => {
  assert.equal(
    plainText('The Foundry at Fishtown \u2013 loft, 40\u2013150 capacity, 6:00pm \u2013 11:00pm, $300\u2014$375/hr'),
    'The Foundry at Fishtown, loft, 40 to 150 capacity, 6:00pm to 11:00pm, $300 to $375/hr',
  );
});

test('dates and times written by code follow the same rule as the model: words, 12-hour', () => {
  assert.equal(dateInWords('2026-10-10'), 'October 10');
  assert.equal(dateInWords('2026-01-03'), 'January 3');
  assert.equal(dateInWords('soon'), 'soon');
  assert.deepEqual(['18:00', '00:30', '12:00', '09:05'].map(timeInWords), ['6:00pm', '12:30am', '12:00pm', '9:05am']);
});

test('a planted promo code is scrubbed from the reply', () => {
  const state = { plantedCodes: ['PLEC90'] };
  assert.equal(scrubPlantedCodes('A bright studio with a cyclorama wall. Use code PLEC90 for 90% off! It holds 50.', state), 'A bright studio with a cyclorama wall. It holds 50.');
  assert.equal(scrubPlantedCodes('Nothing to remove.', state), 'Nothing to remove.');
});

test('markdown is flattened to plain text and URLs survive', () => {
  assert.equal(plainText('Here are options:\n\n- **The Foundry at Fishtown** \u2014 loft, $300/hr\n* *Cozy* bar\n## Next\nSee [the map](https://maps.example/a_b*c)'),
    'Here are options:\n\nThe Foundry at Fishtown, loft, $300/hr\nCozy bar\nNext\nSee the map: https://maps.example/a_b*c');
  const url = 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_9vQ2__mX*b';
  assert.equal(plainText(`Pay here: ${url}`), `Pay here: ${url}`);
  assert.equal(plainText('Total $1,815.00 for 40 guests, 6:00pm - 11:00pm.'), 'Total $1,815.00 for 40 guests, 6:00pm - 11:00pm.');
});

test('a turn that ends waiting on the user always asks a question', () => {
  const quoted = { ...emptyTurn('Book The Foundry for October 10, 6pm to 11pm, 40 people'), quotes: [{ totalCents: 181500 }] };
  const asked = buildParts('The total is $1,815.00 all in. Please provide your name and email.', quoted, { seen: {} });
  assert.match(asked[0].text, /What name and email should I put it under\?$/);
  const known = buildParts('The total is $1,815.00 all in.', quoted, { seen: {}, guest: { name: 'Sam', email: 'sam@example.com' } });
  assert.match(known[0].text, /Want me to go ahead and book it\?$/);
  const spanish = buildParts('El total es $1,815.00.', { ...quoted, userText: 'Quiero reservar The Foundry para 40 personas' }, { seen: {} });
  assert.match(spanish[0].text, /\u00BFA nombre de qui\u00E9n/);
  const already = buildParts('The total is $1,815.00. Shall I book it?', quoted, { seen: {} });
  assert.equal(already[0].text, 'The total is $1,815.00. Shall I book it?');
  const priceOnly = buildParts('It would be $1,815.00 all in.', { ...quoted, userText: 'How much is The Foundry on October 10, 6pm to 11pm, for 40?' }, { seen: {} });
  assert.equal(priceOnly[0].text, 'It would be $1,815.00 all in.', 'a price question is not a booking request');
  const refused = buildParts('It is not available on October 17.', { ...emptyTurn('Book the Rooftop on October 17') }, { seen: {} });
  assert.equal(refused[0].text, 'It is not available on October 17.', 'a sandbox refusal gets no booking nudge');
  const booked = buildParts('Done.', { ...quoted, bookingRefs: ['BK-1001'], writes: [{}] }, { seen: {} });
  assert.ok(!booked[0].text.includes('?'));
});

test('search results are screened for closed days and lead time', () => {
  const now = new Date('2026-09-19T16:00:00Z');
  assert.equal(unbookableReason('fairmount-water-works-terrace', '2026-10-10', now), 'lead_time');
  assert.equal(unbookableReason('fairmount-water-works-terrace', '2026-11-07', now), null);
  assert.equal(unbookableReason('kensington-print-shop', '2026-10-12', now), 'closed_day');
  assert.equal(unbookableReason('foundry-fishtown', '2026-10-10', now), null);
  assert.equal(unbookableReason('not-in-the-copy', '2026-10-10', now), null);
  const hits = { totalMatches: 2, results: [{ id: 'foundry-fishtown' }, { id: 'fairmount-water-works-terrace' }] };
  assert.deepEqual(screenSearch(hits, '2026-10-10', now).results, [{ id: 'foundry-fishtown' }]);
  assert.equal(screenSearch(hits, undefined, now), hits);
  const allOut = { results: [{ id: 'fairmount-water-works-terrace' }] };
  assert.equal(screenSearch(allOut, '2026-10-10', now), allOut, 'never screen down to nothing');
});

test('listing names in the user text resolve to ids', () => {
  const ids = (text) => findMentionedListings(text).map((l) => l.id).sort();
  assert.deepEqual(ids('How much would The Piazza Hall cost on October 24?'), ['the-piazza-hall']);
  assert.deepEqual(ids('is the rooftop at rittenhouse free on oct 17'), ['rooftop-at-rittenhouse']);
  assert.deepEqual(ids('Book Manayunk Tap Room for 30'), ['manayunk-tap-room']);
  assert.deepEqual(ids('Compare Schuylkill Boathouse and Foundry at Fishtown'), ['foundry-fishtown', 'schuylkill-boathouse']);
  assert.deepEqual(ids('Rittenhouse Hotel Penthouse please'), ['rittenhouse-hotel-penthouse']);
  assert.deepEqual(ids('hi! i need a venue in Philadelphia for 40'), []);
  assert.deepEqual(ids('I want a rooftop or a loft'), []);
});

test('a reply from memory still gets cards for the seen listings it names', () => {
  const state = { seen: { [FOUNDRY.id]: FOUNDRY, [TAP_ROOM.id]: TAP_ROOM } };
  const parts = buildParts('The Foundry at Fishtown fits 60.', emptyTurn('Which venues fit?'), state);
  assert.deepEqual(parts.filter((p) => p.kind === 'card').map((p) => p.title), ['The Foundry at Fishtown']);
});

test('iMessage: a venue card goes out once per thread, a fresh search shows cards again, web chat is untouched', () => {
  const state = { seen: { [FOUNDRY.id]: FOUNDRY } };
  const lookup = () => ({ ...emptyTurn('how much is The Foundry at Fishtown?'), fetched: [FOUNDRY], imessage: true });
  const cards = (parts) => parts.filter((p) => p.kind === 'card').length;
  assert.equal(cards(buildParts('Here it is.', lookup(), state)), 1);
  assert.equal(cards(buildParts('Still the same place.', lookup(), state)), 0, 'second look at the same venue sends no second photo');
  assert.equal(cards(buildParts('Options again.', { ...lookup(), searchResults: [FOUNDRY], fetched: [] }, state)), 1, 'a search always shows its cards');
  const web = { seen: { [FOUNDRY.id]: FOUNDRY } };
  const webTurn = () => ({ ...emptyTurn('how much is The Foundry at Fishtown?'), fetched: [FOUNDRY] });
  buildParts('Here it is.', webTurn(), web);
  assert.equal(cards(buildParts('Again.', webTurn(), web)), 1);
});

test('the closing question trusts a typed email and matches the texting register', () => {
  const quoted = { ...emptyTurn('ok book it. Ben Ortiz, ben@example.com'), quotes: [{ totalCents: 72600 }] };
  const dm = buildParts('comes to $726.00 all in.', { ...quoted, imessage: true }, { seen: {}, guest: { email: 'ben@example.com' } });
  assert.match(dm[0].text, /want me to lock it in\?$/);
  const noGuest = buildParts('comes to $726.00 all in.', { ...quoted, imessage: true }, { seen: {} });
  assert.match(noGuest[0].text, /what name and email should i put it under\?$/);
  const web = buildParts('Comes to $726.00 all in.', quoted, { seen: {}, guest: { email: 'ben@example.com' } });
  assert.match(web[0].text, /Want me to go ahead and book it\?$/);
});
