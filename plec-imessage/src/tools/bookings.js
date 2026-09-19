/**
 * Booking tools. The model can only PROPOSE: every propose_* validates through
 * a real quote and parks a PendingAction. Execution happens in executePending(),
 * which is called by server code (commands.js) when the organizer says yes.
 * That split is the safety story: the LLM can never book on its own.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { save, nextBookingId } from '../store/state.js';
import { emit } from '../bus.js';
import { getOrganizer } from '../pipeline/ingest.js';
import { getQuote, getVenueDetails, source } from './venues.js';
import { sandbox, PlecError } from './sandboxClient.js';
import { prettyDate, prettyTime, money, money2, daysUntil } from './util.js';

const PENDING_TTL_MS = 30 * 60 * 1000;

const organizerName = (chat) => getOrganizer(chat)?.name || 'the organizer';
const contactEmail = (chat) => chat.plan.contactEmail || config.organizerEmail || '';

function setPending(chat, kind, payload, summaryText) {
  chat.pendingAction = { id: `pa-${randomUUID().slice(0, 8)}`, kind, payload, summaryText, requestedAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS };
  chat.plan.status = 'awaiting_confirmation';
  save();
  emit('pending', chat.chatId, chat.pendingAction);
  return chat.pendingAction;
}

function lineItemsText(q) {
  return q.lineItems.map((li) => `${li.label} ${money2(li.amount)}`).join(' + ');
}

function bookingSummary(q) {
  const lines = [
    `${q.venueName}`,
    `${prettyDate(q.date)}, ${prettyTime(q.startTime)}-${prettyTime(q.endTime)}, ${q.headcount} people`,
    `${lineItemsText(q)} = ${money2(q.total)} (${money2(q.perPerson)}/person)`,
    q.depositPercent === 100 ? `paid via a PLEC Checkout link, held until it's paid` : `deposit ${money(q.deposit)} (${q.depositPercent}%) to hold it`,
    `cancellation: ${q.cancellation}`,
  ];
  if (q.warnings?.length) lines.push(`heads up: ${q.warnings.join('; ')}`);
  return lines.join('\n');
}

async function venueFacts(venueId) {
  const d = await getVenueDetails({ venueId });
  const v = d.venue || {};
  return { venueCapacity: v.capacity?.standing ?? v.capacity?.max, venueAccessible: v.accessible ?? null, venueCurfew: v.curfew, venueNeighborhood: v.neighborhood };
}

// ---------------------------------------------------------------- tools the model can call

export async function proposeBooking(chat, args) {
  const q = await getQuote(args);
  if (q.error) return q;
  if (source() === 'sandbox' && !contactEmail(chat)) {
    return { error: 'guest_email_required', message: `ask ${organizerName(chat)} for the email the booking should go under, then propose again` };
  }
  const summaryText = bookingSummary(q);
  const pa = setPending(chat, 'create_booking', { quote: q }, summaryText);
  return { ok: true, pendingActionId: pa.id, summaryText, confirmFrom: organizerName(chat), note: 'NOT booked yet. Send this summary and ask the organizer by name to reply yes.' };
}

export async function proposeModification(chat, { bookingId, changes = {} }) {
  const b = chat.bookings.find((x) => x.id === bookingId && x.status !== 'cancelled');
  if (!b) return { error: 'unknown_booking', bookingId, bookings: chat.bookings.map((x) => ({ id: x.id, venue: x.venueName, status: x.status })) };
  const next = {
    venueId: changes.venueId || b.venueId, date: changes.date || b.date,
    startTime: changes.startTime || b.startTime, endTime: changes.endTime || b.endTime,
    headcount: changes.headcount || b.headcount, services: changes.services || b.services,
  };
  const q = await getQuote(next);
  if (q.error) return q;
  const diff = q.total - b.total;
  const what = [];
  if (next.venueId !== b.venueId) what.push(`${b.venueName} -> ${q.venueName}`);
  if (next.date !== b.date) what.push(`${prettyDate(b.date)} -> ${prettyDate(next.date)}`);
  if (next.startTime !== b.startTime || next.endTime !== b.endTime) what.push(`${prettyTime(next.startTime)}-${prettyTime(next.endTime)}`);
  if (next.headcount !== b.headcount) what.push(`${b.headcount} -> ${next.headcount} people`);
  const summaryText = [`change ${b.id}: ${what.join(', ') || 'no change'}`, bookingSummary(q), `difference: ${diff >= 0 ? '+' : '-'}${money2(Math.abs(diff))}`].join('\n');
  const pa = setPending(chat, 'modify_booking', { bookingId, quote: q }, summaryText);
  return { ok: true, pendingActionId: pa.id, summaryText, priceDifference: diff, confirmFrom: organizerName(chat), note: 'NOT changed yet. Ask the organizer by name to confirm.' };
}

export async function proposeCancellation(chat, { bookingId }) {
  const b = chat.bookings.find((x) => x.id === bookingId && x.status !== 'cancelled');
  if (!b) return { error: 'unknown_booking', bookingId };
  const days = daysUntil(b.date);
  const summaryText = `cancel ${b.venueName} on ${prettyDate(b.date)} (${b.id})\n${days} days out. policy: ${b.cancellation}`;
  const pa = setPending(chat, 'cancel_booking', { bookingId }, summaryText);
  return { ok: true, pendingActionId: pa.id, summaryText, daysOut: days, confirmFrom: organizerName(chat) };
}

export function listBookings(chat) {
  return { bookings: chat.bookings.map(publicBooking) };
}

export function publicBooking(b) {
  return {
    id: b.id, venueId: b.venueId, venueName: b.venueName, date: b.date, startTime: b.startTime, endTime: b.endTime,
    headcount: b.headcount, services: b.services, total: b.total, deposit: b.deposit, status: b.status,
    venueCapacity: b.venueCapacity, paymentUrl: b.paymentUrl, cancellation: b.cancellation,
  };
}

// ---------------------------------------------------------------- execution (server only)

function bookingFromQuote(chat, q, facts, extra = {}) {
  return {
    id: nextBookingId(), chatId: chat.chatId, venueId: q.venueId, venueName: q.venueName,
    date: q.date, startTime: q.startTime, endTime: q.endTime, headcount: q.headcount, services: q.services,
    priceBreakdown: Object.fromEntries(q.lineItems.map((li) => [li.label, li.amount])),
    total: q.total, deposit: q.deposit, cancellation: q.cancellation, status: 'confirmed',
    createdAt: Date.now(), history: [{ at: Date.now(), change: 'created' }], ...facts, ...extra,
  };
}

async function sandboxBook(chat, q) {
  // Re-quote right before booking: the sandbox wants a fresh quoteId with identical inputs.
  const fresh = await sandbox.quote({ listingId: q.venueId, date: q.date, startTime: q.startTime, endTime: q.endTime, guestCount: q.headcount, packageIds: q.services || [] });
  const r = await sandbox.book({
    quoteId: fresh.quoteId, listingId: q.venueId, date: q.date, startTime: q.startTime, endTime: q.endTime,
    guestCount: q.headcount, packageIds: q.services || [], guestName: organizerName(chat), guestEmail: contactEmail(chat),
    notes: chat.plan.eventType ? `${chat.plan.eventType}${chat.plan.guestOfHonor ? ` for ${chat.plan.guestOfHonor}` : ''}` : undefined,
  });
  return { sandboxRef: r.ref, status: r.status, paymentUrl: r.payment?.url, total: r.totalCents / 100, deposit: r.totalCents / 100 };
}

function paymentLine(b, chat) {
  if (b.status === 'pending_payment') return `it's held, and it confirms once ${organizerName(chat)} pays here: ${b.paymentUrl}`;
  if (b.status === 'requested') return `the venue still has to approve it, nothing to pay yet. I'll tell you when they do`;
  return `${money(b.deposit)} deposit due to hold it, ${money(b.total)} total`;
}

/**
 * Execute the pending action. Called only by commands.js after the organizer said yes.
 * Returns the bubbles to send (templated: no model call, no chance to embellish).
 */
export async function executePending(chat) {
  const pa = chat.pendingAction;
  if (!pa) return { ok: false, bubbles: ['nothing waiting on a yes right now'] };
  if (Date.now() > pa.expiresAt) {
    chat.pendingAction = undefined;
    save();
    return { ok: false, bubbles: ['that one expired (30 min), want me to re-check prices and propose it again?'] };
  }
  try {
    if (pa.kind === 'create_booking') {
      const q = pa.payload.quote;
      const recheck = await getQuote(q);
      if (recheck.error) throw Object.assign(new Error(recheck.message || recheck.error), { detail: recheck });
      const facts = await venueFacts(q.venueId);
      const extra = source() === 'sandbox' ? await sandboxBook(chat, q) : {};
      const b = bookingFromQuote(chat, recheck, facts, extra);
      chat.bookings.push(b);
      chat.pendingAction = undefined;
      chat.plan.status = 'booked';
      chat.plan.decisions = [...new Set([...(chat.plan.decisions || []), `booked ${b.venueName} for ${prettyDate(b.date)}`])];
      save();
      emit('booking', chat.chatId, b);
      return {
        ok: true, booking: b,
        bubbles: [`done ✅ ${b.venueName}, ${prettyDate(b.date)} ${prettyTime(b.startTime)}-${prettyTime(b.endTime)} for ${b.headcount}. ref ${b.id}`, paymentLine(b, chat)],
      };
    }
    if (pa.kind === 'modify_booking') {
      const b = chat.bookings.find((x) => x.id === pa.payload.bookingId);
      const q = await getQuote(pa.payload.quote);
      if (q.error) throw Object.assign(new Error(q.message || q.error), { detail: q });
      const before = `${b.venueName} ${prettyDate(b.date)} ${b.headcount}ppl ${money(b.total)}`;
      if (source() === 'sandbox') {
        if (q.venueId !== b.venueId || q.headcount !== b.headcount) {
          const extra = await sandboxBook(chat, q); // new slot first, then release the old one
          if (b.sandboxRef) await sandbox.cancelBooking(b.sandboxRef).catch(() => null);
          Object.assign(b, extra);
        } else {
          const r = await sandbox.rescheduleBooking(b.sandboxRef, { date: q.date, startTime: q.startTime, endTime: q.endTime });
          Object.assign(b, { status: r.status, paymentUrl: r.payment?.url || b.paymentUrl, total: r.totalCents / 100 });
        }
      }
      const facts = q.venueId !== b.venueId ? await venueFacts(q.venueId) : {};
      Object.assign(b, {
        venueId: q.venueId, venueName: q.venueName, date: q.date, startTime: q.startTime, endTime: q.endTime,
        headcount: q.headcount, services: q.services, priceBreakdown: Object.fromEntries(q.lineItems.map((li) => [li.label, li.amount])),
        cancellation: q.cancellation, ...facts,
        ...(source() === 'mock' ? { total: q.total, deposit: q.deposit } : {}),
      });
      b.history.push({ at: Date.now(), change: `${before} -> ${b.venueName} ${prettyDate(b.date)} ${b.headcount}ppl ${money(b.total)}` });
      chat.pendingAction = undefined;
      chat.plan.status = 'booked';
      save();
      emit('booking', chat.chatId, b);
      return { ok: true, booking: b, bubbles: [`switched ✅ ${b.venueName}, ${prettyDate(b.date)} ${prettyTime(b.startTime)}-${prettyTime(b.endTime)} for ${b.headcount}. same ref ${b.id}`, paymentLine(b, chat)] };
    }
    if (pa.kind === 'cancel_booking') {
      const b = chat.bookings.find((x) => x.id === pa.payload.bookingId);
      let refund = '';
      if (source() === 'sandbox' && b.sandboxRef) {
        const r = await sandbox.cancelBooking(b.sandboxRef);
        refund = ` refund ${money2((r.refundCents || 0) / 100)}`;
      }
      b.status = 'cancelled';
      b.history.push({ at: Date.now(), change: 'cancelled' });
      chat.pendingAction = undefined;
      chat.plan.status = 'gathering';
      save();
      emit('booking', chat.chatId, b);
      return { ok: true, booking: b, bubbles: [`cancelled ${b.venueName} (${b.id}).${refund || ` per their policy: ${b.cancellation}`}`] };
    }
  } catch (err) {
    const detail = err instanceof PlecError ? `${err.error}: ${err.message}` : err.detail ? JSON.stringify(err.detail) : err.message;
    chat.pendingAction = undefined;
    chat.plan.status = chat.bookings.some((b) => b.status !== 'cancelled') ? 'booked' : 'options_sent';
    save();
    return { ok: false, error: detail, bubbles: [`hm, that didn't go through: ${String(detail).slice(0, 160)}. nothing was booked or charged. want me to find another option?`] };
  }
  return { ok: false, bubbles: ['not sure what to do with that one'] };
}

export function discardPending(chat) {
  const had = chat.pendingAction;
  chat.pendingAction = undefined;
  chat.plan.status = chat.bookings.some((b) => b.status !== 'cancelled') ? 'booked' : chat.plan.shortlist?.length ? 'voting' : 'gathering';
  save();
  emit('pending', chat.chatId, null);
  return had;
}
