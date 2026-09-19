/**
 * Every iMessage provider hides behind this shape. The rest of the system
 * only talks to `getProvider()`, so swapping providers is one file.
 *
 * @typedef {object} Provider
 * @property {string} name
 * @property {{ groupChats: boolean, readReactions: boolean, sendReactions: boolean,
 *   typingIndicator: boolean, sendMedia: boolean, receiveMedia: boolean }} capabilities
 * @property {(router: ReturnType<import('../server.js').createRouter>) => void} registerRoutes
 * @property {(body: any) => import('../types.js').InboundMessage[]} parseInbound
 * @property {(chatId: string, text: string) => Promise<void>} sendText
 * @property {(chatId: string, url: string, caption?: string) => Promise<void>} [sendMedia]
 * @property {(chatId: string) => Promise<void>} [sendTyping]
 * @property {(chatId: string, messageId: string, type: string) => Promise<void>} [sendReaction]
 * @property {(url: string) => Promise<{ base64: string, mimeType: string }>} downloadAttachment
 */

let current = null;

/** @param {Provider} provider */
export function setProvider(provider) { current = provider; }

/** @returns {Provider} */
export function getProvider() {
  if (!current) throw new Error('No provider set. Call setProvider() at boot.');
  return current;
}
