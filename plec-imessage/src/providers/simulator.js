/**
 * Local provider used by the CLI simulator, the /sim web page and
 * replay-demo. It feeds the exact same pipeline as a real webhook.
 * Outbound messages go onto the bus; the simulator UIs render them.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { emit } from '../bus.js';
import { sendJson } from '../server.js';

export function createSimulatorProvider({ onInbound }) {
  return {
    name: 'simulator',
    capabilities: {
      groupChats: true, readReactions: false, sendReactions: false,
      typingIndicator: true, sendMedia: true, receiveMedia: true,
    },

    registerRoutes(router) {
      // body: { chatId, from, fromName?, text, attachments?: [{url, mimeType}] }
      router.post('/sim/send', async (req, res, { body }) => {
        const messages = this.parseInbound(body);
        sendJson(res, 200, { ok: true, ids: messages.map((m) => m.id) });
        onInbound(messages);
      });
    },

    parseInbound(body) {
      if (!body || typeof body !== 'object' || !body.from) return [];
      return [{
        id: body.id || `sim-${randomUUID()}`,
        chatId: body.chatId || 'sim-group',
        isGroup: body.isGroup ?? true,
        from: String(body.from),
        fromName: body.fromName,
        text: String(body.text ?? ''),
        attachments: Array.isArray(body.attachments) ? body.attachments : [],
        timestamp: body.timestamp || Date.now(),
        source: 'simulator',
      }];
    },

    async sendText(chatId, text) {
      emit('agent_message', chatId, { text });
    },

    async sendMedia(chatId, url, caption) {
      emit('agent_message', chatId, { text: caption || '', mediaUrl: url });
    },

    async sendTyping(chatId) {
      emit('typing', chatId, {});
    },

    /** Accepts data: URLs (from the web UI) and local file paths (from the CLI). */
    async downloadAttachment(url) {
      const m = String(url).match(/^data:([^;]+);base64,(.*)$/s);
      if (m) return { mimeType: m[1], base64: m[2] };
      const path = String(url).replace(/^file:\/\//, '');
      const buf = await readFile(path);
      const ext = path.split('.').pop().toLowerCase();
      const mimeType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic' }[ext] || 'application/octet-stream';
      return { mimeType, base64: buf.toString('base64') };
    },
  };
}
