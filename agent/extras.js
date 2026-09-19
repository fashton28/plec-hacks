/**
 * Capabilities built ON TOP of the sandbox tools: whole-event packages,
 * calendar invites, a playlist and a shareable invitation page.
 *
 * Nothing here talks to the sandbox directly. Every quote, lookup and booking
 * goes through the brain's own runTool(), so the consent gates, the ownership
 * rules, the turn deadline, the memory and the stage narration all apply to a
 * package exactly as they do to a single booking. A package is many ordinary
 * bookings made carefully, never a way around the rules.
 */

import { findEmails } from './guards.js';
import { formatCents } from './parts.js';
import { createCalendarLink, savePage, getPage, pageEvent, spotifySearchUrl, dateWords, timeWords } from './eventpage.js';
import { publicOrigin } from './origin.js';
import { stage } from './stage.js';

export const EXTRA_WRITES = new Set(['book_package']);

export const extraTools = [
  {
    type: 'function',
    function: {
      name: 'plan_package',
      description:
        'Plan a WHOLE event in one go: pick a venue and one provider for each service the user wants (dj, caterer, photographer, bartender, florist, band, av, "photo booth", planner, bakery ...), quote every one of them for the same date and time window, and return each all-in total plus the combined total against the budget. Use it when the user asks you to plan, organise or book "everything", "the whole thing" or a venue plus services. You need the city, date, start and end time and headcount first; ask for what is missing. It books nothing.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', enum: ['Philadelphia', 'New York', 'Washington'] },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          startTime: { type: 'string', description: 'HH:MM 24 hour' },
          endTime: { type: 'string', description: 'HH:MM 24 hour' },
          guestCount: { type: 'integer' },
          budget: { type: 'number', description: 'Total budget in dollars for everything, if the user gave one' },
          venueId: { type: 'string', description: 'Listing id, when the user already chose the venue' },
          venueCategory: { type: 'string', description: 'Exact venue category the user asked for, e.g. rooftop, loft, bar' },
          services: { type: 'array', items: { type: 'string' }, description: 'Exact service categories wanted, e.g. ["dj","caterer","photographer"]' },
        },
        required: ['city', 'date', 'startTime', 'endTime', 'guestCount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_package',
      description: 'Book every item of the package that plan_package just quoted. Call ONLY after the user has seen the combined total and clearly said yes, and only with the name and email they gave. Each item is an ordinary booking with its own reference and its own payment link or host approval.',
      parameters: { type: 'object', properties: { guestName: { type: 'string' }, guestEmail: { type: 'string' }, notes: { type: 'string' } }, required: ['guestName', 'guestEmail'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_playlist',
      description: 'Put together a playlist for the event from the vibe the user described. You choose 12 to 18 real, well known tracks that fit; each one becomes a link that opens it in Spotify, on the event page. Use it when asked for music or a playlist, and as part of a whole-event package.',
      parameters: {
        type: 'object',
        properties: {
          vibe: { type: 'string', description: 'A few words, e.g. "rooftop golden hour, disco into house"' },
          tracks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' } }, required: ['title', 'artist'] } },
        },
        required: ['vibe', 'tracks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_invitation',
      description: 'Create the shareable invitation page for the event: venue photo, when and where, the lineup, add-to-calendar buttons and the playlist. Use it after booking when the user wants an invite to pass around, and at the end of a whole-event package. Returns the link.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the invite says on top, e.g. "Maya\'s 30th"' },
          hostName: { type: 'string', description: 'Only if the user said who is hosting' },
          message: { type: 'string', description: 'One or two warm sentences to the guests, in the user\'s language' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar_invite',
      description: 'A Google Calendar link for the booked event with everyone\'s email already on the invite. The user opens it and presses Save, and Google emails the invitations from their own account. Use it when they ask to invite people or share more emails. A link is already sent automatically right after a booking.',
      parameters: { type: 'object', properties: { emails: { type: 'array', items: { type: 'string' }, description: 'Emails the user typed in this conversation' } } },
    },
  },
];

export const EXTRA_NAMES = new Set(extraTools.map((t) => t.function.name));

const refusal = (error, message) => ({ error, message });
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const typedEmails = (state) => [...new Set(Object.values(state.typed ?? {}).flatMap((text) => findEmails(text)).map((e) => e.toLowerCase()))];
const activeBookings = (state) => (state.booked ?? []).filter((b) => b.status !== 'cancelled');

/** Keep the list of what this conversation booked in step with the sandbox. Called by the brain for every booking result. */
export function noteBooking(state, name, booking) {
  if (!booking?.ref || !['book', 'cancel_booking', 'reschedule_booking'].includes(name)) return;
  state.booked = [...(state.booked ?? []).filter((b) => b.ref !== booking.ref), booking];
}

/** The booking the event is "at": the venue if there is one, otherwise the first thing booked. */
function anchorBooking(state) {
  const live = activeBookings(state);
  return live.find((b) => state.seen?.[b.listingId]?.kind === 'venue') ?? live[0] ?? null;
}

function calendarEventFor(state) {
  const anchor = anchorBooking(state);
  if (!anchor) return null;
  const page = getPage(state.pageId);
  const listing = state.seen?.[anchor.listingId] ?? {};
  const live = activeBookings(state);
  const lines = live.map((b) => `${b.listingName} (${b.ref}, ${b.status === 'requested' ? 'waiting on the host' : b.status === 'pending_payment' ? 'held until paid' : b.status})`);
  return {
    title: page?.title || `Event at ${anchor.listingName}`,
    date: anchor.date, startTime: anchor.startTime, endTime: anchor.endTime,
    location: [anchor.listingName, listing.address].filter(Boolean).join(', '),
    details: [`${anchor.guestCount} guests.`, ...lines, page ? `Invitation: ${publicOrigin()}/e/${page.id}` : '', 'Planned with PLEC Concierge.'].filter(Boolean).join('\n'),
  };
}

function calendarLink(state, turn, extraEmails = []) {
  const event = calendarEventFor(state);
  if (!event) return null;
  const allowed = new Set(typedEmails(state));
  const emails = [...new Set([...allowed, ...extraEmails.map((e) => String(e).toLowerCase()).filter((e) => allowed.has(e))])];
  const url = `${publicOrigin()}/c/${createCalendarLink(event, emails)}`;
  turn.links = [...(turn.links ?? []).filter((l) => l.label !== 'Add to Google Calendar'), { label: 'Add to Google Calendar', url }];
  return { url, invitees: emails.length };
}

/** Right after a turn that booked something: hand over the calendar link without being asked. */
export function afterBooking(state, turn) {
  if (!turn.writes?.some((w) => w.name === 'book')) return;
  calendarLink(state, turn);
}

async function planPackage(args, { state, turn, runTool }) {
  const { city, date, startTime, endTime, guestCount } = args;
  const budgetCents = Number(args.budget) > 0 ? Math.round(Number(args.budget) * 100) : null;
  const slot = { date, startTime, endTime, guestCount: Number(guestCount) };
  const quoteFor = async (listing) => ({ listing, quote: await runTool('quote', { listingId: listing.id, ...slot }, state, turn) });
  const ok = (r) => r.quote && !r.quote.error;
  // With a budget, the cheapest option that works; without one, the best rated (search order).
  const choose = (results) => { const good = results.filter(ok); return budgetCents ? good.sort((a, b) => a.quote.totalCents - b.quote.totalCents)[0] : good[0]; };
  const why = (results) => results.find((r) => r.quote?.error)?.quote.message ?? 'nothing matched';

  let venueResults;
  if (args.venueId) {
    venueResults = [await quoteFor({ id: args.venueId })];
  } else {
    const found = await runTool('search_listings', { city, kind: 'venue', guests: slot.guestCount, date, category: args.venueCategory, limit: 10 }, state, turn);
    if (found?.error) return found;
    venueResults = await Promise.all((found.results ?? []).slice(0, 4).map(quoteFor));
  }
  // The venue should leave room for the rest: aim for at most 60% of a budget when there are services to pay for.
  const services = [...new Set((args.services ?? []).map((s) => clean(s, 30).toLowerCase()).filter(Boolean))].slice(0, 6);
  const roomy = budgetCents && services.length ? venueResults.filter(ok).filter((r) => r.quote.totalCents <= budgetCents * 0.6) : [];
  const venue = choose(roomy.length ? roomy : venueResults);
  if (!venue) return refusal('no_venue', `No venue could be quoted for that slot. ${why(venueResults)}`);

  const picked = [{ role: 'venue', ...venue }];
  const skipped = [];
  await Promise.all(services.map(async (category) => {
    const found = await runTool('search_listings', { city, kind: 'service', category, date, limit: 3 }, state, turn);
    const results = found?.error ? [] : await Promise.all((found.results ?? []).slice(0, 2).map(quoteFor));
    const best = choose(results);
    if (best) picked.push({ role: category, ...best });
    else skipped.push({ service: category, reason: found?.error ? found.message : why(results) });
  }));

  const combinedCents = picked.reduce((sum, p) => sum + p.quote.totalCents, 0);
  state.package = { slot, budgetCents, combinedCents, items: picked.map((p) => ({ role: p.role, listingId: p.quote.listingId, name: state.seen?.[p.quote.listingId]?.name ?? p.quote.listingId, totalCents: p.quote.totalCents })) };
  turn.packageTotalCents = combinedCents;
  stage.note(turn.chatId, 'quoted', `Built a package: ${formatCents(combinedCents)}`, `${picked.length} bookings for ${slot.guestCount} guests${budgetCents ? `, budget ${formatCents(budgetCents)}` : ''}`);

  return {
    items: state.package.items.map((i) => ({ role: i.role, listingId: i.listingId, name: i.name, totalFormatted: formatCents(i.totalCents), needsHostApproval: state.seen?.[i.listingId]?.instantBook === false })),
    skipped,
    combinedTotalFormatted: formatCents(combinedCents),
    ...(budgetCents ? { budgetFormatted: formatCents(budgetCents), ...(combinedCents > budgetCents ? { overBudgetByFormatted: formatCents(combinedCents - budgetCents) } : { underBudgetByFormatted: formatCents(budgetCents - combinedCents) }) } : {}),
    next: 'Tell the user each item with its all-in total, then the combined total (and how it sits against the budget). Be honest about anything skipped. Ask for the name and email if you do not have them, and for a clear yes. After the yes, call book_package.',
  };
}

async function bookPackage(args, { state, turn, runTool }) {
  const pack = state.package;
  if (!pack?.items?.length) return refusal('no_package', 'There is no quoted package to book. Call plan_package first.');
  const booked = [], failed = [];
  for (const item of pack.items) {
    const result = await runTool('book', { quoteId: 'from-package', listingId: item.listingId, ...pack.slot, guestName: args.guestName, guestEmail: args.guestEmail, ...(args.notes ? { notes: args.notes } : {}) }, state, turn);
    if (result?.error) {
      // A gate said no (no yes yet, missing details): that answer holds for every item, so stop before booking half an event.
      if (!booked.length && /required$|^sender_unknown$/.test(result.error)) return result;
      failed.push({ name: item.name, error: result.error, message: result.message });
    } else {
      booked.push({ ref: result.ref, name: result.listingName, status: result.status, totalFormatted: formatCents(result.totalCents), paymentUrl: result.payment?.url ?? null });
    }
  }
  if (booked.length) state.package = null;
  return { booked, failed, next: 'Give every reference. pending_payment items are held, not confirmed, until paid: their payment links are sent with your reply. requested items wait for the host. Say plainly if anything failed. Then call make_playlist and make_invitation if this is a whole-event package.' };
}

function makePlaylist(args, { state, turn }) {
  const tracks = (Array.isArray(args.tracks) ? args.tracks : []).map((t) => ({ title: clean(t?.title, 90), artist: clean(t?.artist, 90) })).filter((t) => t.title && t.artist).slice(0, 20);
  if (tracks.length < 3) return refusal('tracks_required', 'Pass at least a handful of tracks, each with a title and an artist.');
  const playlist = { vibe: clean(args.vibe, 120), tracks };
  const page = savePage(state.pageId, { title: getPage(state.pageId)?.title ?? 'The playlist', playlist });
  state.pageId = page.id;
  const url = `${publicOrigin()}/e/${page.id}#playlist`;
  turn.links = [...(turn.links ?? []).filter((l) => l.label !== 'Open the playlist'), { label: 'Open the playlist', url }];
  stage.note(turn.chatId, 'spoke', `Made a playlist: ${tracks.length} tracks`, playlist.vibe);
  return { url, tracks: tracks.length, firstTrack: spotifySearchUrl(tracks[0].title, tracks[0].artist), note: 'Each track opens in Spotify from the page. Name three or four of them in your reply, not all.' };
}

async function makeInvitation(args, { state, turn, runTool }) {
  const anchor = anchorBooking(state);
  const slot = anchor ?? (state.package ? { ...state.package.slot, listingId: state.package.items[0].listingId, listingName: state.package.items[0].name } : null);
  if (!slot) return refusal('nothing_to_invite_to', 'There is no booking or package yet, so there is no date, time or place to put on an invitation.');
  // The page shows an address and a map: a search hit has neither, so read the full listing once.
  if (!state.seen?.[slot.listingId]?.address) await runTool('get_listing', { id: slot.listingId }, state, turn);
  const listing = state.seen?.[slot.listingId] ?? {};
  const lineup = activeBookings(state).filter((b) => b.listingId !== slot.listingId).map((b) => ({ name: b.listingName, category: state.seen?.[b.listingId]?.category ?? 'service' }));
  const page = savePage(state.pageId, {
    title: clean(args.title, 80) || `Event at ${slot.listingName}`, hostName: clean(args.hostName, 60), message: clean(args.message, 320),
    date: slot.date, startTime: slot.startTime, endTime: slot.endTime, guests: slot.guestCount,
    venue: { name: listing.name ?? slot.listingName, address: listing.address, neighborhood: listing.neighborhood, city: listing.city, photoUrl: listing.photoUrls?.[0], mapUrl: listing.mapUrl },
    lineup,
  });
  state.pageId = page.id;
  const url = `${publicOrigin()}/e/${page.id}`;
  turn.links = [...(turn.links ?? []).filter((l) => l.label !== 'Open the invitation'), { label: 'Open the invitation', url }];
  if (anchor) calendarLink(state, turn); // refresh, so the calendar event now carries the invitation's title and link
  stage.note(turn.chatId, 'spoke', 'Made the invitation page', `${page.title} · ${dateWords(page.date)}, ${timeWords(page.startTime)}`);
  return { url, note: 'Share this link. It shows the venue, time, lineup, calendar buttons and the playlist. It never shows prices, emails or payment links.' };
}

/** Run one of the tools above. `ctx.runTool` is the brain's own, so every gate and every memory update still applies. */
export async function runExtra(name, args, ctx) {
  try {
    if (name === 'plan_package') return await planPackage(args ?? {}, ctx);
    if (name === 'book_package') return await bookPackage(args ?? {}, ctx);
    if (name === 'make_playlist') return makePlaylist(args ?? {}, ctx);
    if (name === 'make_invitation') return await makeInvitation(args ?? {}, ctx);
    if (name === 'calendar_invite') {
      const link = calendarLink(ctx.state, ctx.turn, Array.isArray(args?.emails) ? args.emails : []);
      return link ? { ...link, note: 'The user opens the link and presses Save; Google then emails the invitations from their account. Only emails typed in this conversation are included.' } : refusal('nothing_booked', 'Nothing is booked yet, so there is no event to put on a calendar.');
    }
    return refusal('unknown_tool', `No tool named ${name}.`);
  } catch (err) {
    if (err?.name === 'LlmError') throw err; // the turn ran out of time: let the brain say so
    console.error(`[extras] ${name} failed:`, err);
    return refusal('failed', `That did not work: ${err?.message ?? err}`);
  }
}
