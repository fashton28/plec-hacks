/**
 * Calls every tool once and prints the result. `--sandbox` also exercises
 * PLEC's live sandbox (search, details, availability, quote; no booking).
 */
process.env.DEMO_TODAY ||= '2026-09-19';
const { runTool } = await import('../src/tools/index.js');
const { executePending } = await import('../src/tools/bookings.js');
const { getChat } = await import('../src/store/state.js');
const { config } = await import('../src/config.js');
const { setQuiet } = await import('../src/log.js');
setQuiet(true);

const chat = getChat('tool-test');
chat.participants = [{ phone: '+15550100001', name: 'Tony', isOrganizer: true }];
const show = (label, r) => console.log(`\n=== ${label}\n${JSON.stringify(r, null, 1).slice(0, 1400)}`);
const pass = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);

const search = await runTool('search_venues', { date: '2026-10-25', headcount: 45, maxPerPerson: 40, accessible: true, vibe: ['dancing'] }, chat);
show('search_venues (Oct 25, 45 ppl, $40/head, accessible, dancing)', search);
show('get_venue_details kiln-loft-fishtown', await runTool('get_venue_details', { venueId: 'kiln-loft-fishtown' }, chat));
const avail = await runTool('check_availability', { venueId: 'kiln-loft-fishtown', date: '2026-10-17' }, chat);
show('check_availability Oct 17 (blocked)', avail);
show('get_quote Kiln 7-11pm 45 ppl', await runTool('get_quote', { venueId: 'kiln-loft-fishtown', date: '2026-10-25', startTime: '19:00', endTime: '23:00', headcount: 45 }, chat));
const over = await runTool('get_quote', { venueId: 'kiln-loft-fishtown', date: '2026-10-25', startTime: '19:00', endTime: '23:00', headcount: 53 }, chat);
show('get_quote Kiln 53 ppl (over capacity)', over);
const curfew = await runTool('get_quote', { venueId: 'halcyon-rooftop-rittenhouse', date: '2026-10-25', startTime: '19:00', endTime: '23:00', headcount: 45 }, chat);
show('get_quote Halcyon Rooftop until 11pm (curfew 10pm)', curfew);
const proposed = await runTool('propose_booking', { venueId: 'kiln-loft-fishtown', date: '2026-10-25', startTime: '19:00', endTime: '23:00', headcount: 45 }, chat);
show('propose_booking', proposed);
const booked = await executePending(chat);
show('executePending (server-side confirm)', booked);
const bookingId = chat.bookings[0]?.id;
const badMod = await runTool('propose_modification', { bookingId, changes: { headcount: 53 } }, chat);
show('propose_modification headcount 53 at Kiln (should fail)', badMod);
const mod = await runTool('propose_modification', { bookingId, changes: { venueId: 'brightwater-hall-nolibs', headcount: 53 } }, chat);
show('propose_modification -> Brightwater Hall, 53', mod);
const switched = await executePending(chat);
show('executePending modify', switched);
show('list_bookings', await runTool('list_bookings', {}, chat));
show('propose_cancellation', await runTool('propose_cancellation', { bookingId }, chat));

console.log('\n--- checks');
pass('search returns Kiln Loft', search.results?.some((r) => r.venueId === 'kiln-loft-fishtown'));
pass('search excludes Ironworks Loft for stairs', search.excluded?.some((e) => e.id === 'ironworks-loft-oldcity'));
pass('blocked date reports nearest open dates', avail.available === false && avail.nearestOpenDates?.length > 0);
pass('over_capacity error {capacity:50, requested:53}', over.error === 'over_capacity' && over.capacity === 50 && over.requested === 53);
pass('past_curfew error on rooftop', curfew.error === 'past_curfew');
pass('propose_booking does not book', proposed.ok && proposed.note.startsWith('NOT booked'));
pass('confirm books it', booked.ok && booked.booking.status === 'confirmed');
pass('headcount 53 at Kiln rejected', badMod.error === 'over_capacity');
pass('switch to Brightwater costs +$300', mod.ok && mod.priceDifference === 300);
pass('switch executed, same ref', switched.ok && switched.booking.venueId === 'brightwater-hall-nolibs' && switched.booking.id === bookingId);

if (process.argv.includes('--sandbox') && config.sandbox.key) {
  config.venueSource = 'sandbox';
  const s = await runTool('search_venues', { date: '2026-10-25', headcount: 45, accessible: true, vibe: ['dancing'] }, chat);
  show('SANDBOX search_venues', { results: s.results?.map((r) => `${r.name} | ${r.fit} | ${r.warnings.join('; ')}`), excluded: s.excluded, error: s.error });
  const first = 'foundry-fishtown';
  if (first) {
    show('SANDBOX get_quote', await runTool('get_quote', { venueId: first, date: '2026-10-25', startTime: '18:00', endTime: '22:00', headcount: 45 }, chat));
    const ov = await runTool('get_quote', { venueId: first, date: '2026-10-25', startTime: '18:00', endTime: '22:00', headcount: 999 }, chat);
    pass(`sandbox over_capacity (${ov.error})`, ov.error === 'over_capacity');
  }
}
process.exit(0);
