/** Offline tests for packages, calendar links, the playlist and the invitation page (agent/extras.js, agent/eventpage.js, agent/origin.js). */

import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { EXTRA_NAMES, afterBooking, noteBooking, runExtra } from '../agent/extras.js';
import { _stores, addRsvp, getCalendarLink, getPage, googleCalendarUrl, icsFile, renderPage, savePage, spotifySearchUrl } from '../agent/eventpage.js';
import { _forget, noteRequestOrigin, publicOrigin } from '../agent/origin.js';

const EVENT = { title: "Maya's 30th", date: '2026-10-10', startTime: '18:00', endTime: '23:00', location: 'The Foundry at Fishtown, 1400 N Front St', details: 'BK-1001' };
const SLOT = { date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40 };

/** A stand-in for the brain's runTool: a tiny catalogue with prices, and a book that can be told to refuse. */
function fakeBrain({ refuseBook = null, failBook = [] } = {}) {
  const listings = {
    'foundry-fishtown': { id: 'foundry-fishtown', name: 'The Foundry at Fishtown', kind: 'venue', category: 'loft', cents: 181500, address: '1400 N Front St, Philadelphia, PA', city: 'Philadelphia', neighborhood: 'Fishtown', photoUrls: ['https://picsum.photos/seed/foundry-fishtown-1/800/500'], mapUrl: 'https://maps.example/foundry', instantBook: true },
    'old-city-ballroom': { id: 'old-city-ballroom', name: 'Old City Ballroom', kind: 'venue', category: 'ballroom', cents: 374000, instantBook: false },
    'too-small': { id: 'too-small', name: 'Tiny Room', kind: 'venue', category: 'lounge', error: { error: 'over_capacity', message: 'Tiny Room holds 25 at most.' } },
    'dj-marco-reyes': { id: 'dj-marco-reyes', name: 'DJ Marco Reyes', kind: 'service', category: 'dj', cents: 82500 },
    'night-owl-sound': { id: 'night-owl-sound', name: 'Night Owl Sound', kind: 'service', category: 'dj', cents: 110000 },
    'la-esquina-catering': { id: 'la-esquina-catering', name: 'La Esquina Catering', kind: 'service', category: 'caterer', cents: 198000 },
  };
  const calls = [];
  let ref = 1000;
  const runTool = async (name, args, state) => {
    calls.push({ name, args });
    if (name === 'search_listings') {
      const results = Object.values(listings).filter((l) => l.kind === args.kind && (!args.category || l.category === args.category));
      for (const l of results) state.seen[l.id] = { ...state.seen[l.id], id: l.id, name: l.name, kind: l.kind, category: l.category, instantBook: l.instantBook };
      return { results: results.map(({ id, name, kind, category }) => ({ id, name, kind, category })) };
    }
    if (name === 'get_listing') { state.seen[args.id] = { ...state.seen[args.id], ...listings[args.id] }; return listings[args.id]; }
    if (name === 'quote') { const l = listings[args.listingId]; return l.error ?? { quoteId: `q_${l.id}`, listingId: l.id, ...SLOT, totalCents: l.cents }; }
    if (name === 'book') {
      if (refuseBook) return refuseBook;
      if (failBook.includes(args.listingId)) return { error: 'slot_taken', message: 'That slot is taken.' };
      const l = listings[args.listingId];
      const booking = { ref: `BK-${(ref += 1)}`, listingId: l.id, listingName: l.name, status: l.instantBook === false ? 'requested' : 'pending_payment', ...SLOT, totalCents: l.cents, guestName: args.guestName, guestEmail: args.guestEmail, payment: l.instantBook === false ? null : { status: 'unpaid', url: `https://pay.example/${l.id}` } };
      noteBooking(state, 'book', booking);
      return booking;
    }
    throw new Error(`unexpected tool ${name}`);
  };
  return { runTool, calls };
}
const newCtx = (brain, typed = '') => ({ state: { seen: {}, typed: { '': typed } }, turn: { chatId: 't', writes: [] }, runTool: brain.runTool });
const plan = (ctx, extra = {}) => runExtra('plan_package', { city: 'Philadelphia', ...SLOT, services: ['dj', 'caterer'], ...extra }, ctx);

test('the extra tools are registered', () => {
  assert.deepEqual([...EXTRA_NAMES].sort(), ['book_package', 'calendar_invite', 'get_rsvps', 'make_invitation', 'make_playlist', 'plan_package']);
});

test('plan_package quotes a venue and one provider per service for the same slot, and adds them up', async () => {
  const brain = fakeBrain();
  const ctx = newCtx(brain);
  const result = await plan(ctx);
  assert.deepEqual(result.items.map((i) => [i.role, i.listingId, i.totalFormatted]), [['venue', 'foundry-fishtown', '$1,815.00'], ['dj', 'dj-marco-reyes', '$825.00'], ['caterer', 'la-esquina-catering', '$1,980.00']]);
  assert.equal(result.combinedTotalFormatted, '$4,620.00');
  assert.equal(ctx.turn.packageTotalCents, 462000);
  assert.ok(brain.calls.filter((c) => c.name === 'quote').every((c) => c.args.date === SLOT.date && c.args.startTime === '18:00' && c.args.guestCount === 40));
  assert.equal(brain.calls.filter((c) => c.name === 'book').length, 0, 'planning books nothing');
});

test('a venue that cannot be quoted is passed over, and a budget picks the cheaper options and reports the gap', async () => {
  const ctx = newCtx(fakeBrain());
  const result = await plan(ctx, { budget: 4000 });
  assert.equal(result.items[0].listingId, 'foundry-fishtown', 'the cheaper venue, never the one that failed its quote');
  assert.equal(result.budgetFormatted, '$4,000.00');
  assert.equal(result.overBudgetByFormatted, '$620.00');
  const roomy = await plan(newCtx(fakeBrain()), { budget: 9000 });
  assert.equal(roomy.underBudgetByFormatted, '$4,380.00');
});

test('a service nobody can provide is reported, not invented', async () => {
  const result = await plan(newCtx(fakeBrain()), { services: ['dj', 'florist'] });
  assert.deepEqual(result.items.map((i) => i.role), ['venue', 'dj']);
  assert.deepEqual(result.skipped.map((s) => s.service), ['florist']);
});

test('book_package goes through the ordinary book gate: a refusal books nothing at all', async () => {
  const brain = fakeBrain({ refuseBook: { error: 'confirmation_required', message: 'NOT booked. The user has not said yes yet.' } });
  const ctx = newCtx(brain);
  await plan(ctx);
  const result = await runExtra('book_package', { guestName: 'Sam Rivera', guestEmail: 'sam@example.com' }, ctx);
  assert.equal(result.error, 'confirmation_required');
  assert.equal(brain.calls.filter((c) => c.name === 'book').length, 1, 'it stops at the first gate refusal');
  assert.ok(ctx.state.package, 'the package is still there for the real yes');
});

test('book_package books every item, and says so honestly when one fails', async () => {
  const brain = fakeBrain({ failBook: ['la-esquina-catering'] });
  const ctx = newCtx(brain);
  await plan(ctx);
  const result = await runExtra('book_package', { guestName: 'Sam Rivera', guestEmail: 'sam@example.com' }, ctx);
  assert.deepEqual(result.booked.map((b) => [b.name, b.status]), [['The Foundry at Fishtown', 'pending_payment'], ['DJ Marco Reyes', 'pending_payment']]);
  assert.deepEqual(result.failed.map((f) => [f.name, f.error]), [['La Esquina Catering', 'slot_taken']]);
  assert.equal((await runExtra('book_package', { guestName: 'Sam', guestEmail: 'sam@example.com' }, ctx)).error, 'no_package', 'a package cannot be booked twice');
});

test('a booking turn gets a calendar link whose invitees are only emails people typed', async () => {
  const brain = fakeBrain();
  const ctx = newCtx(brain, 'book it for sam@example.com and invite Ana@Example.com');
  await plan(ctx, { services: [] });
  await runExtra('book_package', { guestName: 'Sam Rivera', guestEmail: 'sam@example.com' }, ctx);
  ctx.turn.writes.push({ name: 'book' });
  afterBooking(ctx.state, ctx.turn);
  const link = ctx.turn.links.find((l) => l.label === 'Add to Google Calendar');
  const stored = getCalendarLink(link.url.split('/c/')[1]);
  assert.deepEqual(stored.emails.sort(), ['ana@example.com', 'sam@example.com']);
  assert.equal(stored.event.title, 'Event at The Foundry at Fishtown');
  const more = await runExtra('calendar_invite', { emails: ['stranger@evil.com', 'ana@example.com'] }, ctx);
  assert.equal(more.invitees, 2, 'an email nobody typed is never invited');
  assert.equal(ctx.turn.links.filter((l) => l.label === 'Add to Google Calendar').length, 1, 'one calendar button, the latest');
  assert.equal((await runExtra('calendar_invite', {}, newCtx(fakeBrain()))).error, 'nothing_booked');
});

test('the Google Calendar link and the .ics file carry the event in Eastern time', () => {
  const url = new URL(googleCalendarUrl(EVENT, ['a@example.com', 'a@example.com', 'b@example.com']));
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(url.searchParams.get('dates'), '20261010T180000/20261010T230000');
  assert.equal(url.searchParams.get('ctz'), 'America/New_York');
  assert.equal(url.searchParams.get('add'), 'a@example.com,b@example.com');
  assert.equal(url.searchParams.get('text'), "Maya's 30th");
  const ics = icsFile(EVENT, 'abc');
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261010T180000\r\n/);
  assert.match(ics, /SUMMARY:Maya's 30th\r\n/);
  assert.match(ics, /LOCATION:The Foundry at Fishtown\\, 1400 N Front St\r\n/);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR') && ics.endsWith('END:VCALENDAR'));
});

test('the playlist keeps real-looking tracks only and links each one to Spotify', async () => {
  const ctx = newCtx(fakeBrain());
  assert.equal((await runExtra('make_playlist', { vibe: 'x', tracks: [{ title: 'One' }] }, ctx)).error, 'tracks_required');
  const tracks = Array.from({ length: 25 }, (_, i) => ({ title: `Song ${i}`, artist: 'Artist' }));
  const result = await runExtra('make_playlist', { vibe: 'rooftop disco', tracks: [...tracks, { title: '', artist: 'Nobody' }] }, ctx);
  assert.equal(result.tracks, 20, 'capped');
  assert.equal(getPage(ctx.state.pageId).playlist.vibe, 'rooftop disco');
  assert.equal(spotifySearchUrl('Dancing Queen', 'ABBA'), 'https://open.spotify.com/search/Dancing%20Queen%20ABBA');
  assert.match(ctx.turn.links[0].url, /\/e\/[A-Za-z0-9_-]+#playlist$/);
});

test('the invitation page shows the event and never a price, an email or a payment link', async () => {
  const brain = fakeBrain();
  const ctx = newCtx(brain, 'sam@example.com');
  assert.equal((await runExtra('make_invitation', { title: 'x' }, ctx)).error, 'nothing_to_invite_to');
  await plan(ctx, { services: ['dj'] });
  await runExtra('book_package', { guestName: 'Sam Rivera', guestEmail: 'sam@example.com' }, ctx);
  await runExtra('make_playlist', { vibe: 'disco', tracks: [{ title: 'Dancing Queen', artist: 'ABBA' }, { title: 'Le Freak', artist: 'Chic' }, { title: 'September', artist: 'Earth, Wind & Fire' }] }, ctx);
  const made = await runExtra('make_invitation', { title: '<script>alert(1)</script> Maya\'s 30th', hostName: 'Sam', message: 'Come celebrate "Maya" & friends' }, ctx);
  const page = getPage(made.url.split('/e/')[1]);
  assert.equal(page.venue.address, '1400 N Front St, Philadelphia, PA', 'the full listing was read for the address');
  assert.deepEqual(page.lineup, [{ name: 'DJ Marco Reyes', category: 'dj' }]);
  const html = renderPage(page, 'https://demo.trycloudflare.com');
  assert.ok(!html.includes('<script>alert'), 'titles are escaped');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Maya&#39;s 30th/);
  assert.match(html, /Saturday, October 10, 2026/);
  assert.match(html, /6pm to 11pm/);
  assert.match(html, /og:image" content="https:\/\/picsum.photos\/seed\/foundry-fishtown-1/);
  assert.match(html, /Dancing Queen/);
  assert.match(html, /\/e\/[A-Za-z0-9_-]+\.ics/);
  for (const secret of ['sam@example.com', '$1,815', '1815', 'pay.example', 'BK-10']) assert.ok(!html.includes(secret), `leaked ${secret}`);
  assert.ok(!/[?&;]add=/.test(html), 'the public calendar button invites nobody');
});

test('records are capped so a public endpoint cannot grow without bound', () => {
  for (let i = 0; i < 2100; i += 1) savePage(null, { title: `p${i}` });
  assert.ok(_stores.pages.size <= 2000);
});

test('the public origin is only learned from hosts we trust', () => {
  _forget();
  delete process.env.PUBLIC_URL;
  noteRequestOrigin({ host: 'evil.example.com' });
  assert.match(publicOrigin(), /^http:\/\/localhost:\d+$/);
  noteRequestOrigin({ host: 'localhost:8787' });
  assert.equal(publicOrigin(), 'http://localhost:8787');
  noteRequestOrigin({ host: 'quiet-otter.trycloudflare.com' });
  assert.equal(publicOrigin(), 'https://quiet-otter.trycloudflare.com');
  noteRequestOrigin({ host: 'localhost:8787' });
  assert.equal(publicOrigin(), 'https://quiet-otter.trycloudflare.com', 'a tunnel address is never replaced by localhost');
  process.env.PUBLIC_URL = 'https://plec.example.com/';
  assert.equal(publicOrigin(), 'https://plec.example.com');
  delete process.env.PUBLIC_URL;
});

test('RSVPs: a name answers once, bad input is refused, and the host can ask the agent who is coming', async () => {
  const page = savePage(null, { title: 'Party' });
  assert.deepEqual(addRsvp(page.id, { name: '  Ana   Gomez ', going: 'yes' }, 'ip1').rsvps, { yes: ['Ana Gomez'], maybe: [], no: [] });
  addRsvp(page.id, { name: 'Ben', going: 'maybe' }, 'ip1');
  assert.deepEqual(addRsvp(page.id, { name: 'ana gomez', going: 'no' }, 'ip1').rsvps, { yes: [], maybe: ['Ben'], no: ['ana gomez'] }, 'answering again changes the answer');
  assert.equal(addRsvp(page.id, { name: 'A', going: 'yes' }, 'ip1').status, 400);
  assert.equal(addRsvp(page.id, { name: 'Cara', going: 'definitely' }, 'ip1').status, 400);
  assert.equal(addRsvp('missing-id', { name: 'Cara', going: 'yes' }, 'ip1').status, 404);
  for (let i = 0; i < 25; i += 1) addRsvp(page.id, { name: `Guest ${i}`, going: 'yes' }, 'flood');
  assert.equal(addRsvp(page.id, { name: 'One More', going: 'yes' }, 'flood').status, 429);
  const html = renderPage(getPage(page.id), 'https://x.trycloudflare.com');
  assert.match(html, /id="rsvp-form"/);
  // The page's script lives inside a template string, where one lost backslash turns a regex into a comment. Compile it.
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new vm.Script(inline), 'the invitation page script must parse');
  assert.ok(!html.includes('<script>alert'), 'still escaped');
  addRsvp(page.id, { name: '<img src=x onerror=alert(1)>', going: 'yes' }, 'ip2');
  assert.ok(!renderPage(getPage(page.id), 'https://x').includes('<img src=x'), 'a hostile name never becomes markup');

  const ctx = { state: { seen: {}, typed: {}, pageId: page.id }, turn: { chatId: 't', writes: [] }, runTool: async () => ({}) };
  const asked = await runExtra('get_rsvps', {}, ctx);
  assert.equal(asked.counts.maybe, 1);
  assert.ok(asked.coming.includes('Guest 0'));
  assert.equal((await runExtra('get_rsvps', {}, { ...ctx, state: { seen: {}, typed: {} } })).error, 'no_invitation');
});
