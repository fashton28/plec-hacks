/**
 * Group calendar itinerary. After a booking, PLEC turns the plan into events
 * (setup, vendors, arrive/hide, party, deadlines, cleanup), each with only the
 * people it's meant for, and puts them on the organizer's Google Calendar with
 * the opted-in guests as attendees.
 *
 * Same safety split as bookings: propose_itinerary only parks a pending action;
 * invites go out from executeCalendarPending(), called by commands.js on the
 * organizer's yes. Later booking changes re-sync the same events (found by
 * extendedProperties.private.plecBookingId), so there are never duplicates.
 *
 * No Google env vars (or Google fails)? We still send "add to calendar" links
 * and an .ics feed, so the demo never breaks on calendar setup.
 */
import { randomUUID } from 'node:crypto';
import { config, today } from '../config.js';
import { save } from '../store/state.js';
import { emit } from '../bus.js';
import { log } from '../log.js';
import { getOrganizer } from '../pipeline/ingest.js';
import { getVenueDetails } from './venues.js';
import { addDays, prettyDate, prettyTime, toMin, money } from './util.js';

const TZ = 'America/New_York';
const PENDING_TTL_MS = 30 * 60 * 1000;
const OFFER_WINDOW_MS = 48 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const VOLUNTEER_RE = /\b(i'?ll|i can|i will|i'?m happy to|count me in)\b[^.?!\n]{0,30}\b(help|set ?up|decorat|come early|clean)/i;
const VENDORS = [
  { match: /^catering/, key: 'vendor-catering', label: 'Caterer arrives', before: 90 },
  { match: /^dj/, key: 'vendor-dj', label: 'DJ arrives', before: 60 },
  { match: /^bartender/, key: 'vendor-bartender', label: 'Bartender arrives', before: 30 },
  { match: /^photographer/, key: 'vendor-photographer', label: 'Photographer arrives', before: 15 },
  { match: /^custom-cake/, key: 'vendor-cake', label: 'Cake delivery', before: 60 },
];

const firstName = (s) => String(s || '').trim().toLowerCase().split(/\s+/)[0];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Minutes after midnight of `date` (may exceed 1440) -> local "YYYY-MM-DDTHH:MM:00". */
const local = (date, mins) => `${addDays(date, Math.floor(mins / 1440))}T${hhmm(((mins % 1440) + 1440) % 1440)}:00`;
const clock = (localIso) => prettyTime(localIso.slice(11, 16));
const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret && config.google.refreshToken);
export const isValidEmail = (e) => EMAIL_RE.test(String(e || ''));

// ---------------------------------------------------------------- who gets what

const isGuestOfHonor = (chat, p) => !!chat.plan.guestOfHonor && firstName(p.name) === firstName(chat.plan.guestOfHonor);

/** Participants who may ever be invited. On a surprise, never the guest of honor. */
function invitable(chat) {
  return chat.participants.filter((p) => !(chat.plan.isSurprise && isGuestOfHonor(chat, p)));
}

function detectVolunteers(chat) {
  const names = new Set();
  for (const m of chat.transcript) {
    if (m.from === 'agent' || !VOLUNTEER_RE.test(m.text || '')) continue;
    const p = chat.participants.find((x) => x.phone === m.from);
    if (p?.name) names.add(firstName(p.name));
  }
  return names;
}

function activeBooking(chat, bookingId) {
  const live = chat.bookings.filter((b) => b.status !== 'cancelled');
  return bookingId ? chat.bookings.find((b) => b.id === bookingId) : live[live.length - 1];
}

function ensureCal(chat, bookingId) {
  chat.calendar ||= {};
  const cal = chat.calendar;
  if (bookingId && cal.bookingId !== bookingId) Object.assign(cal, { bookingId, status: undefined, items: [] });
  cal.icsToken ||= randomUUID().replace(/-/g, '').slice(0, 12);
  cal.options ||= {};
  return cal;
}

// ---------------------------------------------------------------- itinerary

/** Build the full itinerary for a booking. Pure data: no sending. */
async function buildItinerary(chat, b) {
  const plan = chat.plan;
  const organizer = getOrganizer(chat);
  const opts = chat.calendar?.options || {};
  const v = (await getVenueDetails({ venueId: b.venueId }).catch(() => ({}))).venue || {};

  const people = invitable(chat);
  const volunteers = new Set([...(opts.volunteers || []).map(firstName), ...detectVolunteers(chat)]);
  const audiences = {
    organizer: people.filter((p) => p === organizer),
    crew: people.filter((p) => p === organizer || volunteers.has(firstName(p.name))),
    guests: people,
  };

  const goh = plan.guestOfHonor;
  const what = plan.eventType || 'party';
  const eventName = goh ? `${goh}'s ${what}` : what.charAt(0).toUpperCase() + what.slice(1);
  const location = [b.venueName, v.address || v.neighborhood, config.defaultCity].filter(Boolean).join(', ');
  const policies = [v.curfew && `curfew ${prettyTime(v.curfew)}`, v.alcohol && `alcohol: ${v.alcohol}`].filter(Boolean).join(' · ');
  const details = (lead) => [
    ...(lead ? [lead, ''] : []),
    `${b.venueName}${v.neighborhood ? `, ${v.neighborhood}` : ''}`,
    `Confirmation: ${b.id}`,
    `Headcount: ${b.headcount}`,
    ...(v.parking ? [`Parking: ${v.parking}`] : []),
    ...(policies ? [`Policies: ${policies}`] : []),
    '', 'Planned with PLEC 🎉',
  ].join('\n');

  const start = toMin(b.startTime);
  let end = toMin(b.endTime);
  if (end <= start) end += 1440;

  const items = [];
  const timed = (key, audience, from, to, title, label, lead) => items.push({ key, audience, allDay: false, start: local(b.date, from), end: local(b.date, to), title, label, location, description: details(lead) });
  const allDay = (key, date, title, label, lead) => {
    if (date >= today() && date < b.date) items.push({ key, audience: 'organizer', allDay: true, date, title, label, location, description: details(lead) });
  };

  timed('setup', 'crew', start - 120, start - 30, `Setup + decorating: ${eventName}`, 'setup + decorating', 'Setup crew: come early to decorate.');
  for (const s of b.services || []) {
    const vendor = VENDORS.find((x) => x.match.test(s));
    if (vendor && !items.some((i) => i.key === vendor.key)) timed(vendor.key, 'organizer', start - vendor.before, start - vendor.before + 30, `${vendor.label} (${b.venueName})`, vendor.label.toLowerCase(), `${vendor.label}. Meet them at the door.`);
  }
  if (plan.isSurprise && goh) {
    timed('arrive', 'guests', start - 15, start, `Be there by ${prettyTime(hhmm(start - 15))}, ${goh} arrives at ${prettyTime(b.startTime)} 🤫`, `be there, ${goh} arrives at ${prettyTime(b.startTime)}`, `It's a surprise! ${goh} arrives at ${prettyTime(b.startTime)}. Don't text ${goh} about it 🤫`);
  }
  timed('party', 'guests', start, end, `${eventName}${plan.isSurprise ? ' (surprise 🤫)' : ''} 🎉`, 'the party', plan.isSurprise ? `Surprise! Keep it quiet${goh ? ` around ${goh}` : ''} 🤫` : '');
  timed('cleanup', 'crew', end, end + 30, `Cleanup at ${b.venueName}`, 'cleanup', 'Cleanup crew.');

  if (b.deposit && b.status !== 'requested') allDay('deposit', [addDays(today(), 3), addDays(b.date, -1)].sort()[0], `Deposit due: ${money(b.deposit)} for ${b.venueName}`, `deposit due (${money(b.deposit)})`, b.paymentUrl ? `Pay here: ${b.paymentUrl}` : '');
  if (b.total > (b.deposit || 0)) allDay('final-payment', addDays(b.date, -7), `Final payment due: ${b.venueName} (${money(b.total)} total)`, 'final payment due');
  allDay('rsvp', addDays(b.date, -10), `RSVP deadline: ${eventName}`, 'RSVP deadline', `Lock the headcount (booked for ${b.headcount}).`);

  // Decoy: only when the organizer asked for it, only for the guest of honor, no party details.
  if (plan.isSurprise && isValidEmail(opts.decoyEmail)) {
    items.push({
      key: 'decoy', audience: 'decoy', allDay: false, start: local(b.date, start), end: local(b.date, start + 120),
      title: opts.decoyTitle || `Dinner with ${organizer?.name || 'friends'}`, label: `decoy for ${goh || 'the guest of honor'}`,
      location, description: 'See you there!', attendees: [opts.decoyEmail.toLowerCase()], invitees: [goh || 'guest of honor'],
    });
  }

  for (const item of items) {
    if (item.audience === 'decoy') continue;
    const list = audiences[item.audience] || [];
    item.attendees = [...new Set(list.map((p) => p.email).filter(Boolean))].filter((e) => e !== opts.decoyEmail?.toLowerCase());
    item.invitees = list.filter((p) => p.email || p === organizer).map((p) => p.name);
  }
  return items.sort((x, y) => (x.allDay ? x.date : x.start).localeCompare(y.allDay ? y.date : y.start));
}

function whoLabel(chat, item) {
  if (item.audience === 'guests') return 'everyone';
  if (item.audience === 'organizer') return getOrganizer(chat)?.name || 'organizer';
  if (item.audience === 'decoy') return 'decoy';
  return item.invitees.join(', ') || getOrganizer(chat)?.name;
}

function itinerarySummary(chat, b, items) {
  const timedLines = items.filter((i) => !i.allDay).map((i) => `${clock(i.start)}${i.key === 'party' ? `-${clock(i.end)}` : ''} ${i.label} (${whoLabel(chat, i)})`);
  const deadlines = items.filter((i) => i.allDay).map((i) => i.label);
  const invited = invitable(chat).filter((p) => p.email && p !== getOrganizer(chat)).map((p) => p.name);
  const lines = [
    `calendar plan for ${prettyDate(b.date)} at ${b.venueName}:`,
    ...timedLines,
    deadlines.length ? `+ reminders for ${getOrganizer(chat)?.name || 'the organizer'}: ${deadlines.join(', ')}` : '',
    invited.length ? `invites go to ${joinNames(invited)}` : 'nobody has shared an email yet, so it will just be links',
    chat.plan.isSurprise && chat.plan.guestOfHonor ? `${chat.plan.guestOfHonor} gets nothing 🤫` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** What the stage sees: no emails. */
function publicItems(items) {
  return items.map(({ key, title, label, audience, allDay, date, start, end, location, invitees }) => ({ key, title, label, audience, allDay, date, start, end, location, invitees }));
}

function emitCalendar(chat) {
  const cal = chat.calendar;
  emit('calendar', chat.chatId, {
    bookingId: cal.bookingId, status: cal.status, linksOnly: !!cal.linksOnly, items: publicItems(cal.items || []),
    guestOfHonor: chat.plan.isSurprise ? chat.plan.guestOfHonor : undefined,
  });
}

// ---------------------------------------------------------------- links + .ics

const compact = (localIso) => localIso.replace(/[-:]/g, '');

/** Google Calendar "add event" template URL for one item. */
export function templateUrl(item) {
  const dates = item.allDay
    ? `${item.date.replace(/-/g, '')}/${addDays(item.date, 1).replace(/-/g, '')}`
    : `${compact(item.start)}/${compact(item.end)}`;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: item.title, dates, ctz: TZ, location: item.location || '', details: item.description || '' });
  return `https://calendar.google.com/calendar/render?${q}`;
}

const base = () => config.publicBaseUrl.replace(/\/+$/, '');
const icsUrl = (cal) => `${base()}/ics/${cal.bookingId}.ics?k=${cal.icsToken}`;
/** Short link that 302s to the (long) template URL, so iMessage bubbles stay readable. */
const shortLink = (cal, item) => `${base()}/cal/${cal.bookingId}/${item.key}?k=${cal.icsToken}`;

function linkBubbles(chat) {
  const cal = chat.calendar;
  const guestItems = (cal.items || []).filter((i) => i.audience === 'guests');
  const lines = guestItems.map((i) => `${i.label}: ${shortLink(cal, i)}`);
  lines.push(`iPhone / Apple Calendar: ${icsUrl(cal)}`);
  return lines.join('\n');
}

const icsEscape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Fold content lines at 75 octets (RFC 5545), never splitting a character. */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZ}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function buildIcs(cal, items, sequence) {
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PLEC//Group Itinerary//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...VTIMEZONE];
  for (const i of items) {
    lines.push('BEGIN:VEVENT', `UID:${cal.bookingId}-${i.key}@plec`, `DTSTAMP:${stamp}`, `SEQUENCE:${sequence}`);
    if (i.allDay) lines.push(`DTSTART;VALUE=DATE:${i.date.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${addDays(i.date, 1).replace(/-/g, '')}`);
    else lines.push(`DTSTART;TZID=${TZ}:${compact(i.start)}`, `DTEND;TZID=${TZ}:${compact(i.end)}`);
    lines.push(`SUMMARY:${icsEscape(i.title)}`, `LOCATION:${icsEscape(i.location)}`, `DESCRIPTION:${icsEscape(i.description)}`);
    for (const mins of i.allDay ? [3 * 1440, 1440] : [1440, 120]) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(i.title)}`, `TRIGGER:-PT${mins}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Find the chat's calendar by booking id + token (the token keeps guessable ids private). */
function findCalendar(chats, bookingId, token) {
  for (const chat of chats) {
    const cal = chat.calendar;
    if (cal?.bookingId === bookingId && cal.icsToken && cal.icsToken === token && cal.items?.length) return { chat, cal };
  }
  return null;
}

/** GET /ics/PB-1001.ics?k=token -> the guest-facing events as an .ics file. */
export function icsResponse(chats, pathname, token) {
  const m = pathname.match(/^\/ics\/([\w-]+)\.ics$/);
  const hit = m && findCalendar(chats, m[1], token);
  if (!hit || hit.cal.status === 'cancelled') return null;
  const b = hit.chat.bookings.find((x) => x.id === hit.cal.bookingId);
  return { filename: `${m[1]}.ics`, body: buildIcs(hit.cal, hit.cal.items.filter((i) => i.audience === 'guests'), b?.history?.length || 0) };
}

/** GET /cal/PB-1001/party?k=token -> 302 to the Google template URL. */
export function templateRedirect(chats, pathname, token) {
  const m = pathname.match(/^\/cal\/([\w-]+)\/([\w-]+)$/);
  const hit = m && findCalendar(chats, m[1], token);
  const item = hit?.cal.items.find((i) => i.key === m[2] && i.audience === 'guests');
  return item ? templateUrl(item) : null;
}

// ---------------------------------------------------------------- Google Calendar (REST over fetch)

let token = null;
async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, refresh_token: config.google.refreshToken, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`google token: ${j.error || r.status}${j.error_description ? ` (${j.error_description})` : ''}`);
  token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function gcal(method, path = '', { query = {}, body } = {}) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.google.calendarId)}/events${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 204 || (method === 'DELETE' && r.status === 410)) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`google ${method} events${path}: ${r.status} ${j.error?.message || ''}`.trim());
  return j;
}

function toGoogle(bookingId, i) {
  return {
    summary: i.title,
    location: i.location,
    description: i.description,
    start: i.allDay ? { date: i.date } : { dateTime: i.start, timeZone: TZ },
    end: i.allDay ? { date: addDays(i.date, 1) } : { dateTime: i.end, timeZone: TZ },
    attendees: i.attendees.map((email) => ({ email })),
    reminders: { useDefault: false, overrides: (i.allDay ? [3 * 1440, 1440] : [1440, 120]).map((minutes) => ({ method: 'popup', minutes })) },
    extendedProperties: { private: { plecBookingId: bookingId, plecItemKey: i.key } },
  };
}

/** Only the fields that differ from what Google has (so unchanged events send no update emails). */
function changedFields(existing, next) {
  const when = (x) => x?.date || String(x?.dateTime || '').slice(0, 19);
  const emails = (list) => (list || []).map((a) => a.email.toLowerCase()).sort().join(',');
  const patch = {};
  for (const f of ['summary', 'location', 'description']) if ((existing[f] || '') !== (next[f] || '')) patch[f] = next[f];
  if (when(existing.start) !== when(next.start) || when(existing.end) !== when(next.end)) Object.assign(patch, { start: next.start, end: next.end });
  if (emails(existing.attendees) !== emails(next.attendees)) patch.attendees = next.attendees;
  return patch;
}

async function listEvents(bookingId) {
  const r = await gcal('GET', '', { query: { privateExtendedProperty: `plecBookingId=${bookingId}`, maxResults: '250', showDeleted: 'false' } });
  return r?.items || [];
}

/** Upsert: patch events we already made, insert new ones, delete ones that no longer apply. */
async function pushToGoogle(bookingId, items) {
  const byKey = new Map((await listEvents(bookingId)).map((e) => [e.extendedProperties?.private?.plecItemKey, e]));
  const counts = { created: 0, updated: 0, removed: 0 };
  for (const i of items) {
    const body = toGoogle(bookingId, i);
    const existing = byKey.get(i.key);
    byKey.delete(i.key);
    if (!existing) {
      await gcal('POST', '', { query: { sendUpdates: 'all' }, body });
      counts.created += 1;
      continue;
    }
    const patch = changedFields(existing, body);
    if (Object.keys(patch).length) {
      await gcal('PATCH', `/${existing.id}`, { query: { sendUpdates: 'all' }, body: patch });
      counts.updated += 1;
    }
  }
  for (const stale of byKey.values()) {
    await gcal('DELETE', `/${stale.id}`, { query: { sendUpdates: 'all' } });
    counts.removed += 1;
  }
  return counts;
}

/** Push to Google if we can; otherwise (or on failure) fall back to links. Never throws. */
async function deliver(chat, bookingId, items) {
  if (!googleConfigured()) {
    log('📅', chat.chatId, 'Google Calendar not configured, sent links only.');
    return { linksOnly: true };
  }
  try {
    const counts = await pushToGoogle(bookingId, items);
    log('📅', chat.chatId, `google calendar ${bookingId}: +${counts.created} ~${counts.updated} -${counts.removed}`);
    return { linksOnly: false, counts };
  } catch (err) {
    log('💥', chat.chatId, `google calendar failed, sent links only: ${err.message}`);
    return { linksOnly: true, error: err.message };
  }
}

// ---------------------------------------------------------------- the flow

/** Called right after a booking is confirmed. Returns the bubble that asks for emails. */
export function offerCalendar(chat, booking) {
  const cal = ensureCal(chat, booking.id);
  cal.status = 'offered';
  cal.offeredAt = Date.now();
  save();
  return "want this on your calendars? reply with your email and I'll send invites 📅";
}

/** Should an email in this message count as opting in? */
export function calendarOfferOpen(chat) {
  const cal = chat.calendar;
  return !!cal?.offeredAt && Date.now() - cal.offeredAt < OFFER_WINDOW_MS && cal.status !== 'cancelled';
}

/** Everyone who could be invited has shared an email. */
export function everyoneOptedIn(chat) {
  const people = invitable(chat).filter((p) => p !== getOrganizer(chat));
  return people.length > 0 && people.every((p) => p.email);
}

/** Model tool: build the itinerary and park it for the organizer's yes. Sends nothing. */
export async function proposeItinerary(chat, { bookingId, volunteers, decoyEmail, decoyTitle } = {}) {
  const b = activeBooking(chat, bookingId);
  if (!b || b.status === 'cancelled') return { error: 'no_active_booking', message: 'book a venue first, then offer calendar invites' };
  if (chat.pendingAction && chat.pendingAction.kind !== 'calendar_create') {
    return { error: 'confirmation_pending', message: 'the organizer still has to answer the booking question first' };
  }
  const cal = ensureCal(chat, b.id);
  if (Array.isArray(volunteers) && volunteers.length) cal.options.volunteers = volunteers.map(String);
  if (decoyEmail !== undefined) {
    if (!chat.plan.isSurprise) return { error: 'not_a_surprise', message: 'a decoy event only makes sense for a surprise' };
    if (!isValidEmail(decoyEmail)) return { error: 'bad_email', message: 'decoyEmail is not a valid email' };
    cal.options.decoyEmail = decoyEmail.toLowerCase();
    if (decoyTitle) cal.options.decoyTitle = String(decoyTitle).slice(0, 80);
  }
  cal.items = await buildItinerary(chat, b);
  cal.status = 'proposed';
  const summaryText = itinerarySummary(chat, b, cal.items);
  chat.pendingAction = { id: `pa-${randomUUID().slice(0, 8)}`, kind: 'calendar_create', payload: { bookingId: b.id }, summaryText, requestedAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS };
  save();
  emit('pending', chat.chatId, chat.pendingAction);
  emitCalendar(chat);
  const organizer = getOrganizer(chat);
  return {
    ok: true, pendingActionId: chat.pendingAction.id, summaryText, confirmFrom: organizer?.name,
    optedIn: invitable(chat).filter((p) => p.email).map((p) => p.name),
    noEmailYet: invitable(chat).filter((p) => !p.email && p !== organizer).map((p) => p.name),
    note: 'NOT sent yet. Send this summary and ask the organizer by name to reply yes.',
  };
}

/** Server only: the organizer said yes to calendar_create. Returns templated bubbles. */
export async function executeCalendarPending(chat) {
  const pa = chat.pendingAction;
  chat.pendingAction = undefined;
  emit('pending', chat.chatId, null);
  if (!pa || Date.now() > pa.expiresAt) {
    save();
    return { ok: false, bubbles: ['that one expired, say "plec send invites" and I\'ll put it together again'] };
  }
  const b = activeBooking(chat, pa.payload.bookingId);
  if (!b || b.status === 'cancelled') {
    save();
    return { ok: false, bubbles: ["that booking isn't active anymore, so I didn't send anything"] };
  }
  const cal = ensureCal(chat, b.id);
  cal.items = await buildItinerary(chat, b); // fresh: picks up emails that arrived after the proposal
  const r = await deliver(chat, b.id, cal.items);
  Object.assign(cal, { status: 'sent', linksOnly: r.linksOnly, sentAt: Date.now() });
  save();
  emitCalendar(chat);

  const organizer = getOrganizer(chat);
  const invited = invitable(chat).filter((p) => p.email && p !== organizer).map((p) => p.name);
  const noEmail = invitable(chat).filter((p) => !p.email && p !== organizer).map((p) => p.name);
  const bubbles = [];
  if (!r.linksOnly) {
    bubbles.push(invited.length ? `done ✅ invites sent to ${joinNames(invited)}. check your calendars` : `done ✅ it's all on your calendar, ${organizer?.name || 'organizer'}`);
    if (noEmail.length) bubbles.push(`${joinNames(noEmail)}, no email from you so tap to add 👇`);
  } else {
    bubbles.push('here\'s the plan for your calendars 📅 tap to add 👇');
  }
  if (r.linksOnly || noEmail.length) bubbles.push(linkBubbles(chat));
  return { ok: true, bubbles };
}

/**
 * Called automatically after a booking change the organizer already confirmed:
 * patch the same events (no duplicates), no second confirmation.
 * Returns bubbles to send (empty when there was nothing on anyone's calendar).
 */
export async function syncItinerary(chat, { bookingId } = {}) {
  const cal = chat.calendar;
  const b = activeBooking(chat, bookingId || cal?.bookingId);
  if (!cal || !b || cal.bookingId !== b.id) return { ok: false, skipped: true, bubbles: [] };
  if (b.status === 'cancelled') return cancelItinerary(chat, { bookingId: b.id });
  const before = (cal.items || []).find((i) => i.key === 'party');
  cal.items = await buildItinerary(chat, b);
  if (!['sent', 'updated'].includes(cal.status)) {
    // Proposed but not sent yet: just refresh what the organizer will confirm.
    if (cal.status === 'proposed' && chat.pendingAction?.kind === 'calendar_create') chat.pendingAction.summaryText = itinerarySummary(chat, b, cal.items);
    save();
    if (cal.status === 'proposed') emitCalendar(chat);
    return { ok: true, skipped: true, bubbles: [] };
  }
  const after = cal.items.find((i) => i.key === 'party');
  const r = await deliver(chat, b.id, cal.items);
  Object.assign(cal, { status: 'updated', linksOnly: r.linksOnly, updatedAt: Date.now() });
  save();
  emitCalendar(chat);
  const moved = before && after && before.location !== after.location;
  if (!r.linksOnly) return { ok: true, bubbles: [moved ? 'updated everyone\'s calendar with the new spot 📍' : 'updated everyone\'s calendar ✅'] };
  return { ok: true, bubbles: [`calendar links updated${moved ? ' with the new spot 📍' : ''}, re-add if you already did 👇`, linkBubbles(chat)] };
}

/** Called automatically when a booking is cancelled. */
export async function cancelItinerary(chat, { bookingId } = {}) {
  const cal = chat.calendar;
  if (!cal || (bookingId && cal.bookingId !== bookingId) || !['sent', 'updated', 'proposed'].includes(cal.status)) return { ok: false, skipped: true, bubbles: [] };
  const wasSent = cal.status !== 'proposed';
  if (chat.pendingAction?.kind === 'calendar_create') {
    chat.pendingAction = undefined;
    emit('pending', chat.chatId, null);
  }
  let removed = 0;
  if (wasSent && googleConfigured() && !cal.linksOnly) {
    try {
      for (const e of await listEvents(cal.bookingId)) {
        await gcal('DELETE', `/${e.id}`, { query: { sendUpdates: 'all' } });
        removed += 1;
      }
    } catch (err) {
      log('💥', chat.chatId, `google calendar cancel failed: ${err.message}`);
    }
  }
  cal.status = 'cancelled';
  save();
  emitCalendar(chat);
  if (!wasSent) return { ok: true, bubbles: [] };
  return { ok: true, removed, bubbles: [removed ? 'took it off everyone\'s calendar too 🗓️' : 'if you added it to your calendar, you can delete it now 🗓️'] };
}

/** One line for the responder's context. Names only, never emails. */
export function calendarContext(chat) {
  const cal = chat.calendar;
  if (!cal?.status) return '';
  const organizer = getOrganizer(chat);
  const shared = invitable(chat).filter((p) => p.email).map((p) => p.name);
  const missing = invitable(chat).filter((p) => !p.email && p !== organizer).map((p) => p.name);
  return `CALENDAR: ${cal.status}${cal.linksOnly ? ' (links only)' : ''} for ${cal.bookingId}. shared email: ${shared.join(', ') || 'nobody yet'}. no email yet: ${missing.join(', ') || 'nobody'}`;
}
