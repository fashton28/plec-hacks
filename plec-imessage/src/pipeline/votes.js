/**
 * Lightweight voting, counted in code: "2", "2!!", "1 or 2", "#3", "option 1".
 * Only while numbered options are out (plan.shortlist).
 */
import { save } from '../store/state.js';
import { emit } from '../bus.js';

export function parseVote(text, max) {
  const nums = [...String(text).matchAll(/\b([1-9])\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= max);
  if (!nums.length) return null;
  const rest = String(text).toLowerCase().replace(/\b[1-9]\b/g, '').replace(/option|number|#|\bor\b|\band\b|\bfor\b|\bi\b|\bvote\b|\bme\b|[!?.,&+/\s-]|[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
  return rest.length === 0 ? [...new Set(nums)] : null;
}

export function voters(chat) {
  const goh = chat.plan.guestOfHonor?.toLowerCase();
  return chat.participants.filter((p) => p.name && p.name.toLowerCase() !== goh);
}

export function tally(chat) {
  const { shortlist = [], votes = {} } = chat.plan;
  return shortlist.map((id, i) => ({ n: i + 1, venueId: id, voters: votes[id] || [] }));
}

export function tallyText(chat) {
  return tally(chat).map((t) => `${t.n}: ${t.voters.length}${t.voters.length ? ` (${t.voters.join(', ')})` : ''}`).join(', ');
}

/** Returns { recorded, complete, summary } or null when the message is not a vote. */
export function recordVote(chat, message) {
  const plan = chat.plan;
  if (!plan.shortlist?.length || !['options_sent', 'voting'].includes(plan.status)) return null;
  const picks = parseVote(message.text, plan.shortlist.length);
  if (!picks) return null;
  const name = message.fromName;
  for (const id of Object.keys(plan.votes)) plan.votes[id] = plan.votes[id].filter((v) => v !== name);
  for (const n of picks) {
    const id = plan.shortlist[n - 1];
    plan.votes[id] = [...(plan.votes[id] || []), name];
  }
  plan.status = 'voting';
  plan.lastUpdated = Date.now();
  const voted = new Set(Object.values(plan.votes).flat());
  const complete = voters(chat).every((p) => voted.has(p.name));
  save();
  emit('plan', chat.chatId, { plan, changed: ['votes'] });
  return { recorded: true, complete, summary: tallyText(chat) };
}
