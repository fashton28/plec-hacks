/**
 * Normalize, dedupe, ignore our own messages, resolve names, store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, config } from '../config.js';
import { getChat, appendTranscript, seenBefore, save } from '../store/state.js';
import { emit } from '../bus.js';
import { log, maskPhone } from '../log.js';

let contacts = {};
try {
  contacts = JSON.parse(readFileSync(join(ROOT, 'data', 'contacts.json'), 'utf8'));
} catch { contacts = {}; }

const normPhone = (p) => String(p ?? '').replace(/[^\d+]/g, '');
export const isAgentSender = (from) => from === 'agent' || (config.agentPhone && normPhone(from) === normPhone(config.agentPhone));

export function contactName(phone) {
  return contacts[phone] || contacts[normPhone(phone)];
}

const ORGANIZER_RE = /\b(i'?m|i am) (the one )?(organi[sz]ing|booking|paying|planning)|\bi'?ll (pay|book|organi[sz]e|handle the booking)|\bi'?m (the )?organi[sz]er\b/i;

/** The organizer: DEMO_ORGANIZER_PHONE, else who declared it, else the first sender. */
export function getOrganizer(chat) {
  return chat.participants.find((p) => p.isOrganizer) || chat.participants[0];
}

function upsertParticipant(chat, message) {
  let p = chat.participants.find((x) => x.phone === message.from);
  if (!p) {
    p = { phone: message.from, name: message.fromName };
    if (config.organizerPhone && normPhone(config.organizerPhone) === normPhone(message.from)) p.isOrganizer = true;
    chat.participants.push(p);
  } else if (!p.name && message.fromName) {
    p.name = message.fromName;
  }
  if (!chat.participants.some((x) => x.isOrganizer) && ORGANIZER_RE.test(message.text)) {
    p.isOrganizer = true;
    log('👑', chat.chatId, `${p.name || maskPhone(p.phone)} is the organizer`);
  }
  return p;
}

/**
 * @param {import('../types.js').InboundMessage} message
 * @returns {{ chat: import('../types.js').ChatState, message: import('../types.js').InboundMessage, firstInChat: boolean } | null}
 */
export function ingest(message) {
  if (!message || !message.chatId || !message.from) return null;
  if (isAgentSender(message.from)) {
    log('🔁', message.chatId, 'ignored our own message');
    return null;
  }
  const chat = getChat(message.chatId);
  if (seenBefore(chat, message.id)) {
    log('♻️', message.chatId, `duplicate ${message.id} ignored`);
    return null;
  }
  const known = chat.participants.find((p) => p.phone === message.from);
  message.fromName = message.fromName || contactName(message.from) || known?.name || maskPhone(message.from);
  message.attachments = message.attachments || [];
  const firstInChat = chat.transcript.filter((m) => m.from !== 'agent').length === 0 && !chat.introduced;

  upsertParticipant(chat, message);
  appendTranscript(chat, message);
  chat.messagesSinceAgentSpoke += 1;
  save();
  emit('inbound', chat.chatId, { id: message.id, from: message.from, fromName: message.fromName, text: message.text, attachments: message.attachments.map((a) => ({ mimeType: a.mimeType, url: a.url.startsWith('data:') ? a.url : '' })) });
  log('📥', chat.chatId, `${message.fromName}: ${message.text.slice(0, 120)}${message.attachments.length ? ` [+${message.attachments.length} attachment]` : ''}`);
  return { chat, message, firstInChat };
}
