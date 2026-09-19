/**
 * Deterministic commands, handled before debounce so they feel instant.
 * Also: executing a pending booking action when the ORGANIZER says yes.
 * This is where the safety story lives: the model can only propose, and
 * only this code, on the organizer's yes, executes.
 */
import { config } from '../config.js';
import { getOrganizer } from './ingest.js';
import { executePending, discardPending, publicBooking } from '../tools/bookings.js';
import { sendBubbles } from './outbound.js';
import { newPlan, save } from '../store/state.js';
import { emit } from '../bus.js';
import { log } from '../log.js';
import { prettyDate, prettyTime, money } from '../tools/util.js';

const name = () => config.agentName.toLowerCase();
const addressed = (text) => new RegExp(`^\\s*@?(plec|${name()})\\b[\\s,:!-]*`, 'i');

const YES = /^(yes|yep|yeah|yup|ya|sure|confirm(ed)?|book it|do it|lock it in|switch it|go for it|go ahead|let'?s do it|ok(ay)? (do it|book it|switch it)|sounds good,? (book|do|switch) it)\b/i;
const NO = /^(no|nope|nah|cancel( that)?|wait|hold on|hold off|not yet|don'?t)\b/i;

/**
 * @returns {Promise<'handled'|'forget'|null>} 'handled' = consumed, skip the batch.
 */
export async function handleCommand(chat, message, { respond, reExtract }) {
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

  // Pending confirmation: only the organizer's yes executes.
  if (chat.pendingAction) {
    const plain = isAddressed ? body : text.toLowerCase();
    if (YES.test(plain)) {
      if (!fromOrganizer) {
        await sendBubbles(chat, [`want me to lock it in, ${organizer?.name || 'organizer'}?`]);
        return 'handled';
      }
      log('✅', chat.chatId, `${message.fromName} confirmed ${chat.pendingAction.kind}`);
      const result = await executePending(chat);
      await sendBubbles(chat, result.bubbles);
      return 'handled';
    }
    if (NO.test(plain) && fromOrganizer) {
      discardPending(chat);
      await sendBubbles(chat, ['no problem, nothing booked. tell me what to change']);
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
  if (/^(what'?s the plan|whats the plan|recap|summary|where are we)\b/.test(body)) {
    await respond(chat, { intent: 'summarize', reason: 'asked for a recap: crisp, by name, include any booking and what is still open' });
    return 'handled';
  }
  return null;
}
