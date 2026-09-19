/**
 * In-memory state, snapshotted to data/state.json after every change and
 * reloaded on boot, so a restart mid-demo loses nothing.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../config.js';
import { emit } from '../bus.js';
import { log } from '../log.js';

const FILE = join(ROOT, 'data', 'state.json');
const TRANSCRIPT_CAP = 300;
const SEEN_CAP = 1000;

/** @type {Map<string, import('../types.js').ChatState>} */
const chats = new Map();
let bookingSeq = 1000;

export function newPlan() {
  return {
    dateOptions: [], vibe: [], dealbreakers: [], personConstraints: [], openQuestions: [],
    decisions: [], shortlist: [], votes: {}, status: 'gathering', lastUpdated: Date.now(),
  };
}

function newChat(chatId) {
  return {
    chatId, participants: [], transcript: [], plan: newPlan(), pendingAction: undefined,
    bookings: [], introduced: false, lastAgentSpokeAt: undefined, messagesSinceAgentSpoke: 0,
    optedOut: false, seenIds: [], decisions: [],
  };
}

/** @returns {import('../types.js').ChatState} */
export function getChat(chatId) {
  let chat = chats.get(chatId);
  if (!chat) {
    chat = newChat(chatId);
    chats.set(chatId, chat);
  }
  return chat;
}

export const hasChat = (chatId) => chats.has(chatId);
export const allChats = () => [...chats.values()];

export function appendTranscript(chat, message) {
  chat.transcript.push(message);
  if (chat.transcript.length > TRANSCRIPT_CAP) chat.transcript.splice(0, chat.transcript.length - TRANSCRIPT_CAP);
}

/** Returns true if the id was already seen (and records it otherwise). */
export function seenBefore(chat, id) {
  if (!id) return false;
  if (chat.seenIds.includes(id)) return true;
  chat.seenIds.push(id);
  if (chat.seenIds.length > SEEN_CAP) chat.seenIds.splice(0, chat.seenIds.length - SEEN_CAP);
  return false;
}

export function nextBookingId() {
  bookingSeq += 1;
  return `PB-${bookingSeq}`;
}

export function resetChat(chatId) {
  chats.delete(chatId);
  save();
  emit('state_reset', chatId, {});
}

export function resetAll() {
  const ids = [...chats.keys()];
  chats.clear();
  bookingSeq = 1000;
  save();
  for (const id of ids) emit('state_reset', id, {});
}

let timer = null;
/** Debounced atomic snapshot (write tmp, rename). */
export function save() {
  clearTimeout(timer);
  timer = setTimeout(flushSave, 150);
}

export function flushSave() {
  clearTimeout(timer);
  try {
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    const snapshot = { bookingSeq, chats: Object.fromEntries(chats) };
    writeFileSync(FILE + '.tmp', JSON.stringify(snapshot, null, 1));
    renameSync(FILE + '.tmp', FILE);
  } catch (err) {
    log('💥', null, `state snapshot failed: ${err.message}`);
  }
}

export function load() {
  if (!existsSync(FILE)) return 0;
  try {
    const snapshot = JSON.parse(readFileSync(FILE, 'utf8'));
    bookingSeq = snapshot.bookingSeq ?? 1000;
    for (const [id, chat] of Object.entries(snapshot.chats ?? {})) chats.set(id, { ...newChat(id), ...chat });
    return chats.size;
  } catch (err) {
    log('💥', null, `could not read ${FILE}, starting empty: ${err.message}`);
    return 0;
  }
}
