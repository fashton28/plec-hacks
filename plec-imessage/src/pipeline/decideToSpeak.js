/**
 * Deterministic rules first, the model's suggestion (from the extraction
 * call) only for gray areas. Every decision is logged and feeds the dashboard.
 */
import { config } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../log.js';
import { save } from '../store/state.js';

const TRIVIAL = /^(?:[\s\p{Emoji_Presentation}\p{Extended_Pictographic}!?.]|lol|lmao|lmfao|haha+|hah|ha|omg|ok|okay|k|kk|ya|yes|yeah|yep|nice|same|true|fr|💀|ty|thx|word|bet)*$/iu;

export function isTrivial(m) {
  if (m.attachments?.length) return false;
  if (m.reaction) return true;
  return TRIVIAL.test(m.text.trim());
}

const names = () => [...new Set(['plec', config.agentName.toLowerCase()])].join('|');
/**
 * Direct address only: "@plec", "plec help", "hey plec", "ok. plec help??", "thoughts plec?".
 * Not a mention: "added plec to help us book".
 */
export function isAddressed(text) {
  const n = names();
  const t = String(text || '');
  return new RegExp(`@(${n})\\b`, 'i').test(t)
    || new RegExp(`(^|[.!?]\\s+|\\b(hey|hi|yo|ok|okay|so|and|pls|please)\\s+)(${n})\\b(?!\\s+(to|is|was|will|can|could|should)\\b)`, 'i').test(t)
    || new RegExp(`\\b(${n})\\s*([?!,:]|$)`, 'i').test(t);
}

export function isMention(chat, m) {
  if (isAddressed(m.text)) return true;
  // Direct reply to the agent's last message within 2 minutes (providers that expose threading).
  if (m.replyToId && chat.transcript.some((t) => t.id === m.replyToId && t.from === 'agent') && chat.lastAgentSpokeAt && m.timestamp - chat.lastAgentSpokeAt < 120_000) return true;
  return false;
}

/**
 * @returns {{ speak: boolean, reason: string, intent: string }}
 */
export function decide(chat, batch, { mentioned, issues = [], suggestion, voteStatus }) {
  if (chat.optedOut) return { speak: false, reason: 'opted out ("plec leave")', intent: 'none' };
  if (issues.length) return { speak: true, reason: `booking issue: ${issues.map((i) => i.summary).join('; ')}`, intent: 'booking_issue' };
  if (mentioned) {
    const intent = suggestion?.speak && suggestion.intent !== 'none' ? suggestion.intent : 'answer_question';
    return { speak: true, reason: 'mentioned directly', intent };
  }
  if (voteStatus?.complete) return { speak: true, reason: `all votes in (${voteStatus.summary})`, intent: 'tally' };
  if (voteStatus?.recorded) return { speak: false, reason: `vote recorded (${voteStatus.summary}), waiting for the rest`, intent: 'none' };
  if (batch.every(isTrivial)) return { speak: false, reason: 'just reactions / lol', intent: 'none' };
  if (suggestion && (!suggestion.speak || suggestion.intent === 'none')) return { speak: false, reason: suggestion.reason || 'nothing to add', intent: 'none' };
  if (chat.lastAgentSpokeAt && Date.now() - chat.lastAgentSpokeAt < 45_000) return { speak: false, reason: `spoke <45s ago (would have: ${suggestion?.reason || 'n/a'})`, intent: 'none' };
  if (suggestion) return { speak: !!suggestion.speak && suggestion.intent !== 'none', reason: suggestion.reason || (suggestion.speak ? 'model says speak' : 'nothing to add'), intent: suggestion.intent || 'none' };
  return { speak: false, reason: 'no signal to speak', intent: 'none' };
}

export function recordDecision(chat, d) {
  chat.decisions = [...(chat.decisions || []), { at: Date.now(), ...d }].slice(-50);
  save();
  emit('decision', chat.chatId, d);
  log(d.speak ? '💬' : '🤫', chat.chatId, `${d.speak ? `speak (${d.intent})` : 'silent'} — ${d.reason}`);
}
