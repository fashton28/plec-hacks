/**
 * Orchestrator: ingest -> (commands) -> debounce -> batch.
 * Phase 1: the batch just echoes, proving the plumbing end to end.
 */
import { config } from '../config.js';
import { ingest } from './ingest.js';
import { schedule } from './debounce.js';
import { getChat } from '../store/state.js';
import { sendBubbles } from './outbound.js';

const pendingBatch = new Map();

export async function handleInbound(messages) {
  for (const raw of messages) {
    const result = ingest(raw);
    if (!result) continue;
    const { chat, message } = result;
    if (!pendingBatch.has(chat.chatId)) pendingBatch.set(chat.chatId, []);
    pendingBatch.get(chat.chatId).push(message);
    schedule(chat.chatId, config.debounceMs, runBatch);
  }
}

async function runBatch(chatId) {
  const batch = pendingBatch.get(chatId) ?? [];
  pendingBatch.set(chatId, []);
  if (!batch.length) return;
  const chat = getChat(chatId);
  await sendBubbles(chat, [`echo (${batch.length} msg): ` + batch.map((m) => `${m.fromName}: ${m.text}`).join(' | ')]);
}
