/**
 * Orchestrator: ingest -> commands -> votes -> debounce -> batch
 * batch = extract plan (+ speak suggestion) -> watchers -> decide -> respond.
 */
import { config } from '../config.js';
import { ingest } from './ingest.js';
import { schedule } from './debounce.js';
import { getChat, save } from '../store/state.js';
import { sendBubbles } from './outbound.js';
import { extractPlan } from './extractPlan.js';
import { decide, isMention, isTrivial, recordDecision } from './decideToSpeak.js';
import { runWatchers } from './watchers.js';
import { respond } from './respond.js';
import { handleCommand } from './commands.js';
import { recordVote } from './votes.js';
import { log } from '../log.js';

const pending = new Map();   // chatId -> { messages, mentioned, votes }
const take = (chatId) => {
  const p = pending.get(chatId) || { messages: [], mentioned: false, vote: null };
  pending.delete(chatId);
  return p;
};

export function introBubbles() {
  const n = config.agentName.toLowerCase();
  return [
    `hey all 👋 I'm ${config.agentName}. I'll quietly keep track of the plan while you chat and help find + book a venue when you're ready.`,
    `just say "${n}" anytime. I only see this chat, and "${n} forget that" wipes the last thing. if you've already been talking, send me screenshots and I'll catch up`,
  ];
}

async function introduce(chat) {
  chat.introduced = true;
  save();
  await sendBubbles(chat, introBubbles());
}

const safeRespond = async (chat, opts, mentioned) => {
  try {
    return await respond(chat, opts);
  } catch (err) {
    log('💥', chat.chatId, `responder failed: ${err.message}`);
    if (mentioned || opts.intent === 'booking_issue') await sendBubbles(chat, ['one sec, my brain glitched. say that again?']);
    return null;
  }
};

const reExtract = (chat) => extractPlan(chat, [], { fromScratch: true });

export async function handleInbound(messages) {
  for (const raw of messages) {
    const result = ingest(raw);
    if (!result) continue;
    const { chat, message, firstInChat, emailShared } = result;
    if (firstInChat && !chat.introduced) await introduce(chat);

    const cmd = await handleCommand(chat, message, { respond: (c, o) => safeRespond(c, o, true), reExtract, emailShared });
    if (cmd === 'handled') {
      if (chat.optedOut) chat.transcript = chat.transcript.filter((m) => m.id !== message.id); // opted out: don't keep what we didn't need to read
      save();
      continue;
    }

    const p = pending.get(chat.chatId) || { messages: [], mentioned: false, vote: null };
    p.messages.push(message);
    const mentioned = isMention(chat, message);
    p.mentioned = p.mentioned || mentioned;
    const vote = recordVote(chat, message);
    if (vote) p.vote = vote;
    pending.set(chat.chatId, p);
    schedule(chat.chatId, mentioned ? config.debounceMentionMs : config.debounceMs, runBatch, { fast: mentioned });
  }
}

async function runBatch(chatId) {
  const { messages: batch, mentioned, vote } = take(chatId);
  if (!batch.length) return;
  const chat = getChat(chatId);
  if (chat.optedOut) return;

  let suggestion;
  const onlyVotes = vote && batch.every((m) => /\d/.test(m.text) && m.text.length < 25);
  if (!batch.every(isTrivial) && !onlyVotes) {
    const r = await extractPlan(chat, batch);
    suggestion = r?.decision;
  }
  const issues = runWatchers(chat);
  const decision = decide(chat, batch, { mentioned, issues, suggestion, voteStatus: vote });
  recordDecision(chat, decision);
  if (!decision.speak) return;
  await safeRespond(chat, { intent: decision.intent, reason: decision.reason, issues }, mentioned);
}
