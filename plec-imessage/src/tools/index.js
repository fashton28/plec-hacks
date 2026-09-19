/**
 * OpenAI-style tool definitions for the responder, plus the dispatcher.
 * send_messages is the final tool; respond.js handles it (it ends the turn).
 */
import { searchVenues, getVenueDetails, checkAvailability, getQuote, listServices } from './venues.js';
import { proposeBooking, proposeModification, proposeCancellation, listBookings } from './bookings.js';
import { proposeItinerary, syncItinerary } from './calendar.js';
import { createPartyPlaylist, addSongs, removeOrVeto, getPlaylistSummary } from './playlist.js';

const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const strArr = (description) => ({ type: 'array', items: { type: 'string' }, description });

const bookingInputs = {
  venueId: str('venue id from search_venues'),
  date: str('YYYY-MM-DD'),
  startTime: str('HH:MM 24h, e.g. 19:00'),
  endTime: str('HH:MM 24h, e.g. 23:00 (24:00 = midnight)'),
  headcount: int('number of guests'),
  services: strArr('optional add-on service ids (see get_venue_details / services list)'),
};

export const TOOL_DEFS = [
  fn('search_venues', 'Find venues that fit the group. Returns up to 5 ranked matches with a fit line and warnings, plus notable venues excluded (and why). Call this before proposing options. Pass everything you know from the plan.', {
    date: str('YYYY-MM-DD if a date is settled'),
    headcount: int('expected guests'),
    maxBudget: { type: 'number', description: 'total budget in dollars' },
    maxPerPerson: { type: 'number', description: 'budget per person in dollars' },
    area: str('neighborhood preference'),
    vibe: strArr('vibe words, e.g. ["dancing","cozy"]'),
    indoor: bool('must be indoor'),
    outdoor: bool('wants outdoor'),
    accessible: bool('someone needs step-free / wheelchair access'),
    lateNight: bool('wants to party past 10:30pm'),
  }),
  fn('get_venue_details', 'Full record for one venue: policies (curfew, alcohol, catering, cancellation, rain plan), amenities, accessibility, parking.', { venueId: str('venue id') }, ['venueId']),
  fn('check_availability', 'Is this venue open on this date? If not, gives the nearest open dates.', { venueId: str('venue id'), date: str('YYYY-MM-DD') }, ['venueId', 'date']),
  fn('get_quote', 'Exact itemized price, deposit and total. Validates hours, curfew, minimum hours and capacity; errors say exactly what is wrong.', bookingInputs, ['venueId', 'date', 'startTime', 'endTime', 'headcount']),
  fn('propose_booking', 'Validate a booking and create a pending confirmation. NEVER books: returns the summary text you must show the organizer, who then replies yes. Call only once the group has picked a venue.', bookingInputs, ['venueId', 'date', 'startTime', 'endTime', 'headcount']),
  fn('propose_modification', 'Propose changing an existing booking (venue, date, time, headcount). Validates everything and creates a pending confirmation for the organizer.', {
    bookingId: str('booking id, e.g. PB-1001'),
    changes: { type: 'object', description: 'only the fields that change', properties: { venueId: str('new venue id'), date: str('YYYY-MM-DD'), startTime: str('HH:MM'), endTime: str('HH:MM'), headcount: int('new headcount') }, additionalProperties: false },
  }, ['bookingId', 'changes']),
  fn('propose_cancellation', 'Propose cancelling a booking; the summary includes refund terms. The organizer must confirm.', { bookingId: str('booking id') }, ['bookingId']),
  fn('list_bookings', 'Bookings for this chat.', {}),
  fn('propose_itinerary', 'After a booking: build the calendar itinerary (setup, vendors, arrival, party, deadlines, cleanup), each event only for the people it concerns, and create a pending confirmation. NEVER sends: returns the summary to show the organizer, who replies yes. Only people who replied with their email get invites; the guest of honor of a surprise never does.', {
    bookingId: str('booking id; defaults to the active booking'),
    volunteers: strArr('names of people who offered to help set up / clean up'),
    decoyEmail: str('ONLY if the organizer asked for a decoy event for the guest of honor of a surprise: their email'),
    decoyTitle: str('decoy event title, e.g. "Dinner with Tony". Never mention the party'),
  }),
  fn('sync_itinerary', 'Re-sync calendar events with the current booking (time, venue, headcount, attendees). Runs automatically after booking changes; call it only if someone reports their calendar is out of date.', { bookingId: str('booking id') }),
  fn('create_party_playlist', 'After a booking, once anyone in the group says yes to a playlist: create it (surprise-safe title), seed ~15 songs that fit the plan, and return the link + seed list. Not risky: no organizer confirmation needed.', {}),
  fn('add_songs', 'Add songs people asked for. Each request is the raw ask ("Espresso", "some Bad Bunny", "mr brightside") plus who asked. Returns added (credit them by name), ambiguous (ask their question once), notFound (say so, never guess), duplicates and vetoed.', {
    requests: { type: 'array', items: { type: 'object', properties: { text: str('what they asked for'), requestedBy: str('first name of who asked') }, required: ['text', 'requestedBy'], additionalProperties: false }, description: 'every song request in this batch' },
  }, ['requests']),
  fn('remove_or_veto', 'Remove a song ("remove that" = the last song someone added, "remove Espresso") or save a veto rule ("no country", "no Drake") that also removes matching songs and blocks future ones.', { text: str('the ask, e.g. "remove that" or "no country"'), requestedBy: str('first name') }, ['text']),
  fn('get_playlist_summary', 'Playlist link, song count, total length, last 5 added with who added them, vetoes.', {}),
  fn('send_messages', 'FINAL tool: send your iMessage reply and end the turn. 1-3 short plain-text bubbles.', {
    bubbles: strArr('1-3 plain text bubbles, no markdown'),
    shortlist: strArr('ONLY when you just proposed numbered venue options: their venue ids in the exact order you numbered them (1, 2, 3)'),
  }, ['bubbles']),
];

/** Run one tool; always returns JSON-able data (errors included, never throws). */
export async function runTool(name, args, chat) {
  try {
    switch (name) {
      case 'search_venues': return await searchVenues(args);
      case 'get_venue_details': {
        const r = await getVenueDetails(args);
        return r.venue ? { ...r, services: listServices().map((s) => ({ id: s.id, name: s.name, price: s.price, priceModel: s.priceModel })) } : r;
      }
      case 'check_availability': return await checkAvailability(args);
      case 'get_quote': return await getQuote(args);
      case 'propose_booking': return await proposeBooking(chat, args);
      case 'propose_modification': return await proposeModification(chat, args);
      case 'propose_cancellation': return await proposeCancellation(chat, args);
      case 'list_bookings': return listBookings(chat);
      case 'propose_itinerary': return await proposeItinerary(chat, args);
      case 'sync_itinerary': {
        const r = await syncItinerary(chat, args);
        return { ok: r.ok, skipped: !!r.skipped, note: r.bubbles.length ? `synced; tell the group: ${r.bubbles[0]}` : 'nothing on anyone\'s calendar yet' };
      }
      case 'create_party_playlist': return await createPartyPlaylist(chat);
      case 'add_songs': return await addSongs(chat, args);
      case 'remove_or_veto': return await removeOrVeto(chat, args);
      case 'get_playlist_summary': return getPlaylistSummary(chat);
      default: return { error: 'unknown_tool', name };
    }
  } catch (err) {
    return { error: 'tool_failed', message: String(err?.message || err) };
  }
}
