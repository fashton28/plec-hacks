/**
 * The live panels (beside the chat on the front page, and full screen at /stage.html): a read-only view of what
 * the agent is doing right now, for a projector or a second screen.
 *
 * This module is the only thing the brain knows about it. The brain calls the
 * narrate functions below at the moments that matter (heard something, thinking,
 * ran a tool, held a write back, replied) and they turn the brain's own
 * objects into small display events: { type, chatId, data, at }. GET /events
 * relays them as server-sent events.
 *
 * Two rules:
 *   - Narration never affects a turn. Every entry point swallows its own errors.
 *   - The stage is a public page on a public URL, showing strangers'
 *     conversations. Emails, phone numbers and payment links are masked before
 *     an event leaves this file, and speakers are "Guest", never a handle.
 */

import { EventEmitter } from 'node:events';
import { dateInWords, formatCents } from './parts.js';

const bus = new EventEmitter();
bus.setMaxListeners(200);

/** A page that opens mid-conversation replays the recent past so it is never blank while the agent is busy. */
const HISTORY_LIMIT = 80;
const history = [];

/** Hide what identifies or charges a person. Booking references and venue names are fine to show. */
export function mask(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S*\/pay\/\S+/gi, '[payment link]')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1•••@$2')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? `•••${m.replace(/\D/g, '').slice(-2)}` : m));
}

function emit(type, chatId, data = {}) {
  const event = { type, chatId: String(chatId ?? ''), data, at: Date.now() };
  history.push(event);
  if (history.length > HISTORY_LIMIT) history.shift();
  bus.emit('event', event);
}

const safely = (fn) => (...args) => {
  try {
    fn(...args);
  } catch (err) {
    console.warn('[stage] narration failed:', err?.message ?? err);
  }
};

const money = (cents) => (typeof cents === 'number' ? formatCents(cents) : null);
const who = (turn) => (turn?.tag ? `Guest ${turn.tag.replace(/[[\]]/g, '')}` : 'Guest');
const photoOf = (state, listingId) => state?.seen?.[listingId]?.photoUrls?.[0] ?? null;

function planOf(state) {
  const quote = state.lastQuote;
  return { city: state.city ?? null, guests: state.guestCount ?? null, date: state.date ?? null, venue: quote?.listingName ?? null, total: quote?.totalFormatted ?? null };
}

function bookingOf(booking, state) {
  return {
    ref: booking.ref, status: booking.status, paid: booking.payment?.status === 'paid',
    venue: booking.listingName, photoUrl: photoOf(state, booking.listingId),
    date: booking.date, startTime: booking.startTime, endTime: booking.endTime, guests: booking.guestCount,
    total: money(booking.totalCents), refund: money(booking.refundCents),
  };
}

/** One activity row per tool call, in plain words. */
function describeTool(name, args, result, state) {
  switch (name) {
    case 'search_listings': {
      const what = [args.category ?? (args.kind === 'service' ? 'services' : 'venues'), args.city && `in ${args.city}`, args.guests && `for ${args.guests}`].filter(Boolean).join(' ');
      return { kind: 'looked', title: `Searched ${what}`, detail: `${result.results?.length ?? 0} that fit${args.date ? ` on ${dateInWords(args.date)}` : ''}` };
    }
    case 'get_listing': return { kind: 'looked', title: `Read up on ${result.name}`, detail: [result.category, result.neighborhood].filter(Boolean).join(' · ') };
    case 'get_availability': return { kind: 'looked', title: `Checked ${state.seen?.[args.id]?.name ?? 'a listing'} for ${dateInWords(args.date)}`, detail: result.available ? 'open that day' : `not available (${result.reason ?? 'closed'})` };
    case 'quote': return { kind: 'quoted', title: `Quoted ${money(result.totalCents)}`, detail: `${state.seen?.[result.listingId]?.name ?? result.listingId} · ${result.guestCount} guests · all in` };
    case 'book': return { kind: 'booked', title: `Booked ${result.listingName}`, detail: `${result.ref} · ${result.status === 'requested' ? 'waiting on the host' : 'waiting on payment'}` };
    case 'cancel_booking': return { kind: 'booked', title: `Cancelled ${result.ref}`, detail: `refund ${money(result.refundCents ?? 0)}` };
    case 'reschedule_booking': return { kind: 'booked', title: `Moved ${result.ref}`, detail: `${dateInWords(result.date)} · new total ${money(result.totalCents)}` };
    case 'resend_payment_link': return { kind: 'looked', title: `Fresh payment link for ${result.ref}`, detail: 'the guest pays, never the agent' };
    case 'get_booking': return { kind: 'looked', title: `Looked up ${result.ref}`, detail: `${result.listingName} · ${result.status}` };
    case 'list_bookings': return { kind: 'looked', title: 'Looked up bookings', detail: `${result.bookings?.length ?? 0} found` };
    default: return { kind: 'looked', title: name, detail: '' };
  }
}

const HELD = {
  confirmation_required: 'waiting for a clear yes',
  requester_confirmation_required: 'only the person who asked can say yes',
  guest_details_required: 'needs a real name and email first',
  quote_required: 'no quote yet, so no booking',
  sender_unknown: 'could not tell who was asking',
  not_found: 'not theirs to see',
  email_required: 'needs their email first',
};

export const stage = {
  /** A message reached the brain. */
  heard: safely((chatId, turn) => {
    emit('inbound', chatId, { fromName: who(turn), text: mask(turn.userText), channel: turn.imessage ? (turn.group ? 'group chat' : 'iMessage') : 'web chat' });
    emit('typing', chatId);
  }),
  /** A model call is starting. */
  thinking: safely((chatId) => emit('llm_call', chatId)),
  /** A tool ran. `result` is the sandbox's own answer, error or not. */
  tool: safely((chatId, name, args, result, state) => {
    if (result?.error) {
      emit('activity', chatId, { kind: 'issue', title: mask(result.message ?? result.error), detail: `the sandbox said no (${result.error})` });
      return;
    }
    emit('activity', chatId, describeTool(name, args, result, state));
    if (name === 'quote') {
      emit('pending', chatId, {
        venue: state.seen?.[result.listingId]?.name ?? result.listingId, photoUrl: photoOf(state, result.listingId),
        date: result.date, startTime: result.startTime, endTime: result.endTime, guests: result.guestCount,
        lines: [...(result.lineItems ?? []).map((l) => [l.label, money(l.amountCents)]), ['Service fee', money(result.serviceFeeCents)]],
        total: money(result.totalCents),
      });
    }
    if (result?.ref && ['book', 'cancel_booking', 'reschedule_booking', 'get_booking', 'resend_payment_link'].includes(name)) {
      if (name === 'book') emit('pending', chatId, null);
      emit('booking', chatId, { ...bookingOf(result, state), fresh: name === 'book' });
    }
    emit('plan', chatId, planOf(state));
  }),
  /** A code-level gate refused a write or a lookup. This is the agent being careful, so it gets its own row. */
  held: safely((chatId, name, refusal) => {
    emit('activity', chatId, { kind: 'held', title: `Held back on ${name.replace(/_/g, ' ')}`, detail: HELD[refusal?.error] ?? 'not yet' });
  }),
  /** The reply is on its way out. */
  replied: safely((chatId, state, parts) => {
    const text = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
    const cards = parts.filter((p) => p.kind === 'card').map((c) => ({ title: c.title, subtitle: c.subtitle ?? '', photoUrl: c.photoUrls?.[0] ?? null }));
    emit('agent_message', chatId, { text: mask(text), cards });
    emit('plan', chatId, planOf(state));
  }),
  /** A free-form activity row, for the capabilities built on top of the sandbox tools. */
  note: safely((chatId, kind, title, detail) => emit('activity', chatId, { kind, title: mask(title), detail: mask(detail ?? '') })),
  /** In a group, the agent chose not to speak. */
  quiet: safely((chatId, reason) => emit('decision', chatId, { speak: false, reason })),
  reset: safely((chatId) => emit('state_reset', chatId)),
};

/**
 * GET /events: server-sent events. Replays the recent past first, flagged so
 * the page can skip its animations, then streams live.
 */
export function openEventStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, replay = false) => res.write(`data: ${JSON.stringify(replay ? { ...event, replay: true } : event)}\n\n`);
  res.write('retry: 2000\n\n');
  for (const event of history) send(event, true);
  const live = (event) => send(event);
  bus.on('event', live);
  // Proxies and tunnels drop a silent connection; a comment line every 20s keeps it open.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(beat);
    bus.off('event', live);
  });
}

/** For tests. */
export const _internals = { bus, history, emit };
