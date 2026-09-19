/**
 * Deterministic commands, handled before debounce so they feel instant.
 * Also: executing a pending booking action when the ORGANIZER says yes.
 * This is where the safety story lives: the model can only propose, and
 * only this code, on the organizer's yes, executes.
 */
import { config } from '../config.js';
import { getOrganizer } from './ingest.js';
import { executePending, discardPending, publicBooking } from '../tools/bookings.js';
import { offerCalendar, proposeItinerary, executeCalendarPending, syncItinerary, cancelItinerary, everyoneOptedIn } from '../tools/calendar.js';
import { offerPlaylist, isPlaylistMessage } from '../tools/playlist.js';
import { sendBubbles } from './outbound.js';
import { newPlan, save } from '../store/state.js';
import { emit } from '../bus.js';
import { log } from '../log.js';
import { prettyDate, prettyTime, money } from '../tools/util.js';

const name = () => config.agentName.toLowerCase();
const addressed = (text) => new RegExp(`^\\s*@?(plec|${name()})\\b[\\s,:!-]*`, 'i');

const YES = /^(yes|yep|yeah|yup|ya|sure|confirm(ed)?|book it|do it|lock it in|switch it|go for it|go ahead|let'?s do it|send (them|it|'?em|the invites)|ok(ay)? (do it|book it|switch it)|sounds good,? (book|do|switch) it)\b/i;
const NO = /^(no|nope|nah|cancel( that)?|wait|hold on|hold off|not yet|don'?t)\b/i;

/**
 * @returns {Promise<'handled'|'forget'|null>} 'handled' = consumed, skip the batch.
 */
export async function handleCommand(chat, message, { respond, reExtract, emailShared }) {
  const text = message.text.trim();
  const isAddressed = addressed(text).test(text);
  const body = text.replace(addressed(text), '').trim().toLowerCase();
  const organizer = getOrganizer(chat);
  const fromOrganizer = organizer && organizer.phone === message.from;

  // Come back works even when opted out.
  if (isAddressed && /^(come back|you can come back|return|unpause)\b/.test(body)) {
    chat.optedOut = false;
    save();
    await sendBubbles(chat, ["I'm back 👋 picking up where we left off"]);
    return 'handled';
  }
  if (chat.optedOut) return 'handled';

  // Calendar opt-in (ingest already saved the email): ack, and once everyone's in, propose the itinerary.
  if (emailShared) {
    const ack = [`got it ${emailShared.name} 📅`];
    if (everyoneOptedIn(chat) && !chat.pendingAction) {
      const r = await proposeItinerary(chat);
      if (r.ok) ack.push(r.summaryText, `${organizer?.name || 'organizer'}, want me to send the invites? reply yes`);
    }
    await sendBubbles(chat, ack);
    if (emailShared.rest.length < 20) return 'handled';
  }

  // Pending confirmation: only the organizer's yes executes.
  // Playlist asks ("plec no country", "yesss" to the playlist) go to the batch instead, except the organizer's plain yes.
  const plain = isAddressed ? body : text.toLowerCase();
  const forPlaylist = isPlaylistMessage(chat, message) && !(fromOrganizer && YES.test(plain) && !/playlist|song|music/.test(plain));
  if (chat.pendingAction && !forPlaylist) {
    const isCalendar = chat.pendingAction.kind === 'calendar_create';
    if (YES.test(plain)) {
      if (!fromOrganizer) {
        await sendBubbles(chat, [isCalendar ? `want me to send them, ${organizer?.name || 'organizer'}?` : `want me to lock it in, ${organizer?.name || 'organizer'}?`]);
        return 'handled';
      }
      log('✅', chat.chatId, `${message.fromName} confirmed ${chat.pendingAction.kind}`);
      if (isCalendar) {
        const result = await executeCalendarPending(chat);
        await sendBubbles(chat, result.bubbles);
        return 'handled';
      }
      const kind = chat.pendingAction.kind;
      const result = await executePending(chat);
      if (result.ok && kind === 'create_booking') result.bubbles.push(`${offerCalendar(chat, result.booking)}\n${offerPlaylist(chat)}`);
      await sendBubbles(chat, result.bubbles);
      // The organizer already confirmed the booking change, so the calendar follows without asking again.
      if (result.ok && kind === 'modify_booking') await sendBubbles(chat, (await syncItinerary(chat, { bookingId: result.booking.id })).bubbles);
      if (result.ok && kind === 'cancel_booking') await sendBubbles(chat, (await cancelItinerary(chat, { bookingId: result.booking.id })).bubbles);
      return 'handled';
    }
    if (NO.test(plain) && fromOrganizer) {
      discardPending(chat);
      if (isCalendar && chat.calendar) chat.calendar.status = 'offered';
      await sendBubbles(chat, [isCalendar ? 'no problem, no invites sent. tell me what to change' : 'no problem, nothing booked. tell me what to change']);
      return 'handled';
    }
  }

  if (!isAddressed) return null;

  if (/^(forget that|forget the last thing|delete that)\b/.test(body)) {
    const idx = chat.transcript.findLastIndex((m) => m.from === message.from && m.id !== message.id);
    if (idx >= 0) chat.transcript.splice(idx, 1);
    chat.transcript = chat.transcript.filter((m) => m.id !== message.id);
    save();
    await sendBubbles(chat, ['done, forgot that']);
    await reExtract(chat);
    return 'handled';
  }
  if (/^(forget everything|wipe everything|start over|reset)\b/.test(body)) {
    const active = chat.bookings.filter((b) => b.status !== 'cancelled');
    chat.transcript = [];
    chat.plan = newPlan();
    if (active.length) chat.plan.status = 'booked';
    chat.pendingAction = undefined;
    chat.flaggedIssues = [];
    save();
    emit('plan', chat.chatId, { plan: chat.plan, changed: ['*'] });
    await sendBubbles(chat, [`wiped the chat history and the plan 🧹${active.length ? ` I kept your booking${active.length > 1 ? 's' : ''} (${active.map((b) => b.id).join(', ')}) so nothing gets lost` : ''}`]);
    return 'handled';
  }
  if (/^(leave|stop|go away|pause|shh+|be quiet)\b/.test(body)) {
    chat.optedOut = true;
    save();
    await sendBubbles(chat, [`ok, going quiet and not reading along. say "${name()} come back" anytime ✌️`]);
    return 'handled';
  }
  if (/^(bookings|my bookings|what did we book|list bookings)\b/.test(body)) {
    const list = chat.bookings.map(publicBooking);
    await sendBubbles(chat, [list.length
      ? list.map((b) => `${b.id}: ${b.venueName}, ${prettyDate(b.date)} ${prettyTime(b.startTime)}-${prettyTime(b.endTime)}, ${b.headcount} ppl, ${money(b.total)} (${b.status.replace('_', ' ')})`).join('\n')
      : 'nothing booked yet']);
    return 'handled';
  }
  if (/^(send (the )?(calendar )?invites|(add|put) (this|it|the plan) (on|to) (our|the|everyone'?s) calendars?|calendar invites)\b/.test(body)) {
    const r = await proposeItinerary(chat);
    await sendBubbles(chat, r.ok
      ? [r.summaryText, `${organizer?.name || 'organizer'}, want me to send the invites? reply yes${r.noEmailYet.length ? ` (${r.noEmailYet.join(', ')}: reply with your email first if you want one)` : ''}`]
      : [r.message || "can't do calendar invites yet, nothing's booked"]);
    return 'handled';
  }
  if (/^(what'?s the plan|whats the plan|recap|summary|where are we)\b/.test(body)) {
    await respond(chat, { intent: 'summarize', reason: 'asked for a recap: crisp, by name, include any booking and what is still open' });
    return 'handled';
  }
  return null;
}
