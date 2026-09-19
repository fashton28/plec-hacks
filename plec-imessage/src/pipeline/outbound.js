/**
 * The one way the agent talks: format -> typing -> send sequentially -> record.
 */
import { getProvider } from '../providers/Provider.js';
import { formatBubbles } from '../style/format.js';
import { appendTranscript, save } from '../store/state.js';
import { log } from '../log.js';

let delayRange = [600, 1200];
/** replay --fast sets [0, 0]. */
export function setBubbleDelay(min, max) { delayRange = [min, max]; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

export async function sendBubbles(chat, bubbles, { mediaUrls = [] } = {}) {
  const provider = getProvider();
  const parts = formatBubbles(bubbles);
  if (!parts.length) return [];
  for (let i = 0; i < parts.length; i += 1) {
    if (provider.capabilities.typingIndicator && provider.sendTyping) {
      try { await provider.sendTyping(chat.chatId); } catch { /* typing is cosmetic */ }
    }
    const [min, max] = delayRange;
    if (max > 0) await sleep(min + Math.random() * (max - min));
    try {
      await provider.sendText(chat.chatId, parts[i]);
    } catch (err) {
      log('💥', chat.chatId, `send failed: ${err.message}`);
      continue;
    }
    seq += 1;
    appendTranscript(chat, {
      id: `agent-${Date.now()}-${seq}`, chatId: chat.chatId, isGroup: true, from: 'agent',
      fromName: 'PLEC', text: parts[i], attachments: [], timestamp: Date.now(), source: 'agent',
    });
    log('📤', chat.chatId, `PLEC: ${parts[i].replace(/\n/g, ' ⏎ ')}`);
  }
  for (const url of mediaUrls.slice(0, 3)) {
    if (provider.capabilities.sendMedia && provider.sendMedia) {
      try { await provider.sendMedia(chat.chatId, url); } catch (err) { log('💥', chat.chatId, `media send failed: ${err.message}`); }
    }
  }
  chat.lastAgentSpokeAt = Date.now();
  chat.messagesSinceAgentSpoke = 0;
  save();
  return parts;
}
