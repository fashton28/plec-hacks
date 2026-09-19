/** Offline tests for the public bookings list (agent/bookings-view.js). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { _clearCache, bookingsView, publicBooking } from '../agent/bookings-view.js';

const BOOKING = { ref: 'BK-1001', listingId: 'the-greenhouse-uc', listingName: 'The Greenhouse', status: 'pending_payment', date: '2026-10-10', startTime: '18:00', endTime: '21:00', guestCount: 30, guestName: 'Sam Rivera', guestEmail: 'sam@example.com', notes: 'cake at 9', totalCents: 72600, refundCents: null, payment: { status: 'unpaid', url: 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_secret', sessionId: 'cs_test_secret' }, createdAt: '2026-09-19T19:00:00.000Z' };

test('the public shape shows the event and never the person or the payment link', () => {
  const pub = publicBooking(BOOKING);
  assert.deepEqual(pub, { ref: 'BK-1001', status: 'pending_payment', paid: false, venue: 'The Greenhouse', photoUrl: 'https://picsum.photos/seed/the-greenhouse-uc-1/800/500', date: '2026-10-10', startTime: '18:00', endTime: '21:00', guests: 30, total: '$726.00', refund: null, createdAt: '2026-09-19T19:00:00.000Z' });
  const wire = JSON.stringify(pub);
  for (const secret of ['Sam', 'sam@example.com', 'cake', 'cs_test_secret', '/pay/']) assert.ok(!wire.includes(secret), secret);
  assert.equal(publicBooking({ ...BOOKING, status: 'cancelled', refundCents: 0, payment: { status: 'paid' } }).refund, '$0.00');
});

test('newest first, with counts, cached briefly, and an outage is an honest 502', async () => {
  _clearCache();
  let calls = 0;
  const client = { listBookings: async () => { calls += 1; return { bookings: [BOOKING, { ...BOOKING, ref: 'BK-1002', status: 'confirmed', payment: { status: 'paid' } }, { ...BOOKING, ref: 'BK-1003', status: 'requested', payment: null }, { ...BOOKING, ref: 'BK-1004', status: 'cancelled', refundCents: 72600 }] }; } };
  const first = await bookingsView({ client, now: 1_000 });
  assert.deepEqual(first.body.bookings.map((b) => b.ref), ['BK-1004', 'BK-1003', 'BK-1002', 'BK-1001']);
  assert.deepEqual(first.body.counts, { total: 4, live: 3, confirmed: 1, awaitingPayment: 1, awaitingHost: 1, cancelled: 1 });
  await bookingsView({ client, now: 3_000 });
  assert.equal(calls, 1, 'a second request within the cache window does not touch the sandbox');
  await bookingsView({ client, now: 9_000 });
  assert.equal(calls, 2);
  _clearCache();
  const down = await bookingsView({ client: { listBookings: async () => { throw new Error('sandbox down hk_secret'); } }, now: 1 });
  assert.equal(down.status, 502);
  assert.ok(!JSON.stringify(down.body).includes('hk_secret'));
});
