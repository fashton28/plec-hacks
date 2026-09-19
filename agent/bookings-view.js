/**
 * GET /api/bookings: every booking in the team's sandbox, for the public "All bookings" page (chat/bookings.html).
 *
 * Bookings belong to the sandbox key, not to a channel, so this one list covers the web chat, iMessage and anything
 * else that booked through this agent. The page is public, so what leaves here is the event, never the person: no
 * guest name, no email, no notes and no payment link (a payment link lets whoever holds it press Pay).
 *
 * Answers are cached for a few seconds: a public page that polls must not be able to spend the sandbox's rate limit.
 */

import { plec } from './plec.js';
import { formatCents } from './parts.js';

const CACHE_MS = 4_000;
let cache = { at: 0, body: null };

/** The public shape of one booking. Exported for the unit test. */
export function publicBooking(b) {
  return {
    ref: b.ref, status: b.status, paid: b.payment?.status === 'paid',
    venue: b.listingName, photoUrl: `https://picsum.photos/seed/${encodeURIComponent(b.listingId)}-1/800/500`,
    date: b.date, startTime: b.startTime, endTime: b.endTime, guests: b.guestCount,
    total: formatCents(b.totalCents), refund: typeof b.refundCents === 'number' ? formatCents(b.refundCents) : null,
    createdAt: b.createdAt,
  };
}

/** @returns {Promise<{ status: number, body: object }>} */
export async function bookingsView({ client = plec, now = Date.now() } = {}) {
  if (cache.body && now - cache.at < CACHE_MS) return { status: 200, body: cache.body };
  try {
    const { bookings } = await client.listBookings();
    const list = (bookings ?? []).map(publicBooking).reverse(); // newest first
    const live = list.filter((b) => b.status !== 'cancelled');
    cache = { at: now, body: { bookings: list, counts: { total: list.length, live: live.length, confirmed: live.filter((b) => b.status === 'confirmed').length, awaitingPayment: live.filter((b) => b.status === 'pending_payment').length, awaitingHost: live.filter((b) => b.status === 'requested').length, cancelled: list.length - live.length } } };
    return { status: 200, body: cache.body };
  } catch (err) {
    console.error('[bookings] could not list:', err?.message ?? err);
    return { status: 502, body: { error: 'sandbox_unreachable', message: 'Could not read the bookings just now.' } };
  }
}

/** For tests. */
export function _clearCache() { cache = { at: 0, body: null }; }
