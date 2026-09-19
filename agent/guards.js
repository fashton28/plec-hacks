/**
 * Code-level rules the model cannot talk its way around. The system prompt
 * asks for the same behaviour; this file is what guarantees it.
 *
 *   - Writes (book, cancel, reschedule) only happen with the consent of the
 *     person they belong to. In a group chat that is the person who asked,
 *     never whoever happened to type next.
 *   - A booking only uses a quote the sandbox actually issued, and guest
 *     details that same person actually typed.
 *   - On iMessage, where strangers share one sandbox key, a booking can only
 *     be opened by the conversation that made it or by its guest's email.
 *   - Search arguments are normalised to what the sandbox matches on.
 *
 * Everything here is a pure function of its arguments, so tests/unit.js and
 * tests/identity.unit.js cover it without a network. What counts as a yes or a
 * no is read in consent.js.
 */

import { hasBookingIntent, hasConsent, isNegative } from './consent.js';

export { hasBookingIntent, hasConsent, isAffirmative, isNegative, isTapbackText } from './consent.js';

export const WRITE_TOOLS = new Set(['book', 'cancel_booking', 'reschedule_booking']);
/** Tools that open one booking by reference. */
export const BOOKING_TOOLS = new Set(['get_booking', 'cancel_booking', 'reschedule_booking', 'resend_payment_link']);

/** docs/contract.md caps a message at 2000 characters; a pasted essay must not ride along in every later prompt. */
export const MAX_TEXT_CHARS = 2000;
/** Cut to `max` UTF-16 units without splitting an emoji: half a surrogate pair is not valid text to hand a model. */
export function clampText(text, max = MAX_TEXT_CHARS) {
  return String(text ?? '').slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * A write never STARTS with less than this left in the turn: a sandbox POST
 * that is cut off may or may not have been applied, so running out of time
 * must happen before a write, never during one.
 */
export const WRITE_FLOOR_MS = 6_000;
/** Below this, the model call that has to follow any tool round cannot run, so the round is pointless. */
export const READ_FLOOR_MS = 3_000;

/** May this tool still start with `remainingMs` of the turn budget left? */
export function hasTimeFor(name, remainingMs) {
  return remainingMs >= (WRITE_TOOLS.has(name) ? WRITE_FLOOR_MS : READ_FLOOR_MS);
}

const CITY_ALIASES = [
  [/^(phil+y|phila|philadelphia(,?\s*pa)?|phl)$/i, 'Philadelphia'],
  [/^(nyc|ny|new york( city)?(,?\s*ny)?|manhattan|brooklyn|queens)$/i, 'New York'],
  [/^(dc|d\.c\.|washington,?\s*d\.?c\.?|washington)$/i, 'Washington'],
];

/** "Philly" -> "Philadelphia". The sandbox prefix-matches the three stored names and nothing else. */
export function normalizeCity(city) {
  const raw = String(city ?? '').trim();
  if (!raw) return undefined;
  for (const [pattern, name] of CITY_ALIASES) if (pattern.test(raw)) return name;
  return raw;
}

/** The inputs a quoteId signs. Two calls with the same key are the same quote. */
export function quoteKey({ listingId, date, startTime, endTime, guestCount, packageIds }) {
  return JSON.stringify([listingId, date, startTime, endTime, Number(guestCount), [...(packageIds ?? [])].sort()]);
}

export function normalizeRef(ref) {
  return String(ref ?? '').trim().toUpperCase();
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Every email address in the text, in the order typed. */
export function findEmails(text) {
  return String(text ?? '').match(EMAIL) ?? [];
}
export function findEmail(text) {
  return findEmails(text)[0] ?? null;
}
export function findRefs(text) {
  return [...String(text ?? '').matchAll(/\bBK-\d+\b/gi)].map((m) => m[0].toUpperCase());
}

/**
 * One spelling per person. Everything a speaker owns is filed under their
 * handle, so "+1 555 000 0001" and "+15550000001", or "Ana@iCloud.com" and
 * "ana@icloud.com", must not become two people. Both front doors and the
 * iMessage policy's awaiting lookup go through this.
 * @param {string|null|undefined} id a phone number, an email address or an opaque handle
 * @returns {string|null} null when there is no usable handle
 */
export function canonicalSender(id) {
  const raw = String(id ?? '').trim().toLowerCase();
  if (!raw) return null;
  // A phone number is reduced to "+" and its digits, the form Spectrum normally sends, so spacing and a missing "+" stop mattering.
  return /^\+?[\d\s().-]*\d[\d\s().-]*$/.test(raw) ? `+${raw.replace(/\D/g, '')}` : raw;
}

/** The key per-speaker records are filed under. HTTP has no sender, so everything typed there is one speaker. */
export function speakerKey(senderId) {
  return senderId ?? '';
}

/**
 * Note that a booking reference came up in a speaker's turn, typed or looked up.
 * The entry keeps whose booking it is here (`by`: whoever booked it in this
 * conversation, otherwise whoever raised it first), the first turn each
 * speaker raised it in, who raised it most recently (`last`), and whether this
 * conversation created it.
 * @param {object} refs session.state.refs, mutated in place
 * @param {string} ref
 * @param {{ turn: number, senderId?: string|null, created?: boolean }} seen
 */
export function recordRef(refs, ref, { turn, senderId = null, created = false }) {
  const entry = (refs[normalizeRef(ref)] ??= { by: senderId, raised: {}, created: false, last: speakerKey(senderId) });
  entry.raised[speakerKey(senderId)] ??= turn;
  entry.last = speakerKey(senderId);
  if (created) Object.assign(entry, { created: true, by: senderId });
}

const refuse = (error, message) => ({ allowed: false, result: { error, message } });
/** How the model knows a speaker: the tag their group messages carry. */
const tagOf = (state, senderId) => state.speakers?.[senderId] ?? 'the person who asked';

/**
 * Decide whether a write may run this turn.
 * @param {string} name tool name
 * @param {object} args tool arguments from the model
 * @param {{ state: object, userText: string, userHistory: string, senderId?: string|null, group?: boolean }} ctx
 *   `userText` is the current message. `userHistory` is everything THIS speaker has typed in the
 *   conversation, lower-cased: in a group it must not include what other members typed.
 *   `senderId` is the speaker's handle; without one (HTTP) the conversation has a single speaker.
 * @returns {{ allowed: true, args: object } | { allowed: false, result: { error: string, message: string } }}
 */
export function checkWrite(name, args, { state, userText, userHistory, senderId = null, group = false }) {
  if (!WRITE_TOOLS.has(name)) return { allowed: true, args };
  if (group && !senderId) {
    return refuse('sender_unknown', 'Nothing was changed. This is a group chat and it is not clear who sent that message, so it cannot count as anyone\'s yes. Ask the person who wants this to say so themselves.');
  }

  if (name === 'book') {
    const quote = state.quotes[quoteKey(args)];
    if (!quote) {
      return refuse('quote_required', 'NOT booked. There is no quote for exactly these inputs. Call quote first, tell the user the total, and ask them to confirm.');
    }
    const quotedTurn = quote.requesters[speakerKey(senderId)];
    if (quotedTurn === undefined) {
      const owners = Object.keys(quote.requesters).map((id) => tagOf(state, id)).join(' and ');
      return refuse('requester_confirmation_required', `NOT booked. This quote belongs to ${owners}, and only they can say yes to it. Tell the group, in a friendly line, that you need to hear it from them.`);
    }
    const email = String(args.guestEmail ?? '').trim();
    const name_ = String(args.guestName ?? '').trim();
    const emailTyped = email && userHistory.includes(email.toLowerCase());
    const nameTyped = name_ && name_.toLowerCase().split(/\s+/).some((token) => token.length > 1 && userHistory.includes(token));
    if (!emailTyped || !nameTyped) {
      return refuse('guest_details_required', 'NOT booked. The guest name and email must be typed by the person making the booking. Ask them for whichever is missing; never invent them and never borrow them from someone else in the chat.');
    }
    if (!bookingConsent(userText, { quotedEarlier: quotedTurn < state.turn, thumbsUp: !group })) {
      return refuse('confirmation_required', `NOT booked. The user has not said yes yet. Tell them the total is ${quote.totalFormatted} all in and ask if you should go ahead.`);
    }
    return { allowed: true, args: { ...args, guestName: name_, guestEmail: email, quoteId: quote.quoteId } };
  }

  const ref = normalizeRef(args.ref);
  const cancelling = name === 'cancel_booking';
  const verb = cancelling ? 'cancelled' : 'rescheduled';
  const entry = state.refs[ref];
  const owner = entry && whoseTurn(entry);
  if (entry && owner !== speakerKey(senderId)) {
    return refuse('requester_confirmation_required', `NOT ${verb}. This booking is ${tagOf(state, owner)}'s to change, not the person who just wrote. Tell the group, in a friendly line, that you need to hear it from them.`);
  }
  const raisedTurn = entry?.raised[speakerKey(senderId)];
  const discussedBefore = raisedTurn !== undefined && raisedTurn < state.turn;
  if (!discussedBefore || !hasConsent(userText, { cancelling, thumbsUp: !group })) {
    return refuse('confirmation_required', `NOT ${verb}. Look the booking up, tell the user exactly what would happen (listing, date, and the refund or the new total), ask them to confirm, and act only after they say yes.`);
  }
  return { allowed: true, args: { ...args, ref } };
}

/**
 * Whose yes can change this booking. One made in this conversation stays with
 * the person who booked it: the reply that announced it showed the reference
 * to the whole group, so knowing it proves nothing. Any other booking answers
 * to whoever brought it up last, because that is the person the agent's "want
 * me to cancel it?" was put to; an earlier lookup by someone else does not
 * let their bare yes stand in.
 */
function whoseTurn(entry) {
  return entry.created ? speakerKey(entry.by) : entry.last;
}

/**
 * Has the speaker agreed to book this quote? Either a clear yes, or, once they
 * saw the total in an earlier turn, a message that asks for the booking. Any
 * other later message ("lol", "where are we eating", a name and an email with
 * no yes) is just chat, and a negative always wins.
 */
function bookingConsent(userText, { quotedEarlier, thumbsUp }) {
  if (hasConsent(userText, { thumbsUp })) return true;
  return quotedEarlier && !isNegative(userText) && hasBookingIntent(userText);
}

/**
 * iMessage only. Every texter shares one sandbox key and references are
 * sequential, so without this anyone could read or cancel a stranger's booking
 * by guessing BK-1001. A booking opens for the conversation that created it,
 * or for a speaker who typed the email it was booked under.
 * @param {string} name tool name
 * @param {object} args tool arguments from the model
 * @param {{ refs: object, emails: string[], booking?: object }} ctx
 *   `emails` are the addresses this speaker typed. `booking` is the looked-up booking, which the
 *   caller fetches only when the conversation did not create the reference itself.
 * @returns {{ allowed: true, args: object } | { allowed: false, result: { error: string, message: string } }}
 */
export function checkBookingAccess(name, args, { refs, emails, booking }) {
  const typed = emails.map((email) => email.toLowerCase());
  if (name === 'list_bookings') {
    if (typed.length === 0) {
      return refuse('email_required', 'Nothing was looked up. Bookings are found by the email they were made under. Ask which email they booked with, then call list_bookings again.');
    }
    // The model may only filter by an address this speaker typed; anything else falls back to their latest one.
    const asked = typed.indexOf(String(args.guestEmail ?? '').trim().toLowerCase());
    return { allowed: true, args: { ...args, guestEmail: asked >= 0 ? emails[asked] : emails.at(-1) } };
  }
  if (!BOOKING_TOOLS.has(name)) return { allowed: true, args };

  const guestEmail = String(booking?.guestEmail ?? '').toLowerCase();
  if (refs[normalizeRef(args.ref)]?.created || (guestEmail && typed.includes(guestEmail))) return { allowed: true, args };
  // Deliberately the same answer whether or not the booking exists, so references cannot be probed.
  return refuse('not_found', 'No booking with that reference under an email this person has given. Ask which email they booked with. Say nothing else about that reference.');
}

/** Fill search arguments from what the user already told us, and fix the city spelling. */
export function prepareSearch(args, state) {
  const out = { ...args };
  out.city = normalizeCity(out.city) ?? state.city;
  if (out.guests === undefined && out.kind !== 'service' && state.guestCount) out.guests = state.guestCount;
  if (out.limit === undefined) out.limit = 10;
  for (const key of Object.keys(out)) if (out[key] === undefined || out[key] === '') delete out[key];
  return out;
}
