/**
 * Offline stand-ins for the two Spectrum objects the iMessage channel touches:
 * a space (where replies go) and the inbound messages the stream yields. The
 * shapes mirror what @spectrum-ts/imessage 12.8.0 delivers at runtime: extras
 * such as `mentions` sit on the message itself, and `type` and `phone` sit on
 * the space. Nothing here opens a connection.
 *
 * send() builds every ContentBuilder with the real SDK, so a test fails the
 * same way a live send would when content cannot be built (for example an
 * attachment whose MIME type cannot be resolved).
 */

import { resolveContents } from '@spectrum-ts/core';

export const AGENT_PHONE = '+15550000001';
export const ALICE = '+15551110001';
export const BOB = '+15551110002';

let nextId = 0;
const mintId = (prefix) => `${prefix}-${(nextId += 1)}`;

/**
 * A recording space. `failing` decides which calls reject:
 *   typingStart / typingStop / read   true to reject that call
 *   photos                            true to reject every send that carries an attachment
 *   texts                             how many text sends reject before one goes through
 * @param {{ id?: string, type?: 'dm' | 'group', phone?: string, failing?: { typingStart?: boolean, typingStop?: boolean, read?: boolean, photos?: boolean, texts?: number } }} [options]
 */
export function fakeSpace({ id, type = 'dm', phone = AGENT_PHONE, failing = {} } = {}) {
  const space = {
    id: id ?? (type === 'group' ? 'any;+;chat-group-1' : `any;-;${ALICE}`),
    type,
    phone,
    /** Every send that went through: { kind: 'text', text } or { kind: 'photo', name, mimeType, bytes, caption }. */
    sent: [],
    /** Every call in order, failed ones included: 'typing:start', 'typing:stop', 'send:text', 'send:photo'. */
    calls: [],
    textFailuresLeft: failing.texts ?? 0,

    async send(content) {
      const [built] = await resolveContents([content]);
      const record = await describe(built);
      space.calls.push(`send:${record.kind}`);
      if (record.kind === 'photo' && failing.photos) throw new Error('fake: attachment upload failed');
      if (record.kind === 'text' && space.textFailuresLeft > 0) {
        space.textFailuresLeft -= 1;
        throw new Error('fake: text send failed');
      }
      space.sent.push(record);
      return { id: mintId('out'), direction: 'outbound', content: built };
    },
    async startTyping() {
      space.calls.push('typing:start');
      if (failing.typingStart) throw new Error('fake: typing start rejected');
    },
    async stopTyping() {
      space.calls.push('typing:stop');
      if (failing.typingStop) throw new Error('fake: typing stop rejected');
    },
    /** Same contract as the SDK: the start call is not guarded, so a failing line rejects before fn ever runs. */
    async responding(fn) {
      await space.startTyping();
      try {
        return await fn();
      } finally {
        await space.stopTyping().catch(() => {});
      }
    },
  };
  space.newMessage = (content, options) => fakeMessage(space, content, options);
  space.failing = failing;
  return space;
}

/** Texts that reached the chat, in order. */
export const sentTexts = (space) => space.sent.filter((record) => record.kind === 'text').map((record) => record.text);

async function describe(built) {
  if (built.type === 'text') return { kind: 'text', text: built.text };
  const items = built.type === 'group' ? built.items.map((item) => item.content) : [built];
  const picture = items.find((item) => item.type === 'attachment');
  if (!picture) return { kind: built.type };
  const caption = items.find((item) => item.type === 'text')?.text ?? '';
  return { kind: 'photo', name: picture.name, mimeType: picture.mimeType, bytes: (await picture.read()).length, caption };
}

/**
 * One stream event in `space`. Defaults to an inbound message from ALICE.
 * @param {ReturnType<typeof fakeSpace>} space
 * @param {object} content a content object from the helpers below
 * @param {{ sender?: string, direction?: 'inbound' | 'outbound', mentions?: Array<{ address: string, start: number, length: number }>, extras?: object }} [options]
 */
export function fakeMessage(space, content, { sender = ALICE, direction = 'inbound', mentions = [], extras = {} } = {}) {
  const message = {
    ...extras,
    id: mintId('msg'),
    direction,
    content,
    mentions,
    sender: sender ? { __platform: 'imessage', id: sender, address: sender, service: 'iMessage' } : undefined,
    space,
    timestamp: new Date(),
    reads: 0,
    async read() {
      if (space.failing.read) throw new Error('fake: mark read rejected');
      message.reads += 1;
    },
  };
  return message;
}

/** One of the agent's own bubbles, as the SDK resolves a reply, reaction or receipt target. */
export const agentBubble = (space, words = 'Want me to go ahead and book it?') =>
  fakeMessage(space, text(words), { sender: null, direction: 'outbound' });

export const text = (words) => ({ type: 'text', text: words });
export const photo = (name = 'IMG_0001.heic') => ({ type: 'attachment', id: mintId('att'), name, mimeType: 'image/heic', size: 1024, read: async () => Buffer.alloc(0) });
export const voiceNote = () => ({ type: 'voice', id: mintId('voice'), name: 'Audio Message.caf', mimeType: 'audio/x-caf' });
export const contactCard = () => ({ type: 'contact', name: { formatted: 'Sam Rivera' } });
/** A multi-part message (text plus photo): its items are messages in their own right. */
export const grouped = (space, ...contents) => ({ type: 'group', items: contents.map((content) => fakeMessage(space, content)) });
export const inlineReply = (content, target) => ({ type: 'reply', content, target });
export const tapback = (target, emoji = '\u{1F44D}') => ({ type: 'reaction', emoji, target });
export const readReceipt = (target) => ({ type: 'read', target });
export const pollVote = () => ({ type: 'poll_option', title: 'Saturday', selected: true });
export const poll = () => ({ type: 'poll', title: 'Which night?', options: [{ title: 'Friday' }, { title: 'Saturday' }] });
export const unsupported = () => ({ type: 'custom', raw: { imessage_type: 'unsupported-message' } });

/** Rename, avatar change, member added or removed, someone leaving: one of each. */
export const groupEvents = () => [
  { type: 'rename', displayName: 'Party planning' },
  { type: 'avatar', action: 'set' },
  { type: 'addMember', members: [{ id: BOB }] },
  { type: 'removeMember', members: [{ id: BOB }] },
  { type: 'leaveSpace' },
];
