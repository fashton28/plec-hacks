/**
 * The rules of the iMessage channel, as pure functions over plain objects.
 *
 * Nothing here imports the Spectrum SDK, touches the network or reads a clock
 * (guards.js, its one import, is just as pure), so every rule can be
 * unit-tested offline (tests/imessage.unit.js). The shell in imessage.js only
 * wires these to a live stream:
 *
 *   readInbound       what did this event say, and is it worth a turn at all?
 *   needsTextNotice   is it a photo or voice note we should own up to not reading?
 *   shouldRespond     in a group, was the agent actually spoken to?
 *   takeBurst         which queued messages belong in the same turn?
 *   planOutbound      which bubbles go out, in what order, and how many?
 */

import { canonicalSender, clampText, isTapbackText } from './guards.js';

/** Longest user text handed to the model. A pasted essay must not blow the prompt or the turn budget. */
export const MAX_INBOUND_CHARS = 2000;
/** How long a question from the agent keeps the floor open for the person it asked. */
export const AWAITING_WINDOW_MS = 10 * 60 * 1000;
/** Cards sent per turn. A group gets fewer, because every bubble lands on everyone's phone. */
export const MAX_CARDS = { dm: 4, group: 3 };

/** A whole word in any alphabet: "plecé" and "plectrum" are other words, "Plec," and "plec's" are the name. */
const AGENT_NAME = /(?<![\p{L}\p{N}])(?:plec|concierge)(?![\p{L}\p{N}])/iu;
/**
 * Places the name turns up without anyone saying it: links (every payment URL
 * the agent sends is on api.plec.ai), email addresses, bare domains, and
 * quoted text, which in a group is usually the agent's own bubble pasted back.
 */
const NOT_PROSE = [/\b(?:https?:\/\/|www\.)\S+/gi, /\S+@\S+/g, /\b[\w-]+(?:\.[\w-]+)+(?:\/\S*)?/g, /["\u201C\u201E\u00AB][^"\u201D\u00BB]*["\u201D\u00BB]/g];
/** Characters that render as nothing: the attachment placeholder Apple leaves in a sticker's text, and zero-width marks. String.trim() keeps them all. */
const INVISIBLE = /[\uFFFC\u200B-\u200D\u2060\uFEFF]/g;
/** User media the agent cannot read. Everything else without text (receipts, tapbacks, votes, group events) is not speech. */
const MEDIA_TYPES = new Set(['attachment', 'voice', 'contact']);
/** Provider flags for traffic no person typed. An auto-reply in particular would ping-pong with the agent forever. */
const MACHINE_FLAGS = ['isSystemMessage', 'isServiceMessage', 'isSpam', 'isAutoReply', 'isCorrupt'];

/**
 * Reduce one stream event to what the brain needs, or null when the event must
 * be ignored in silence: the agent's own messages, read receipts, tapbacks,
 * polls and votes, group renames and member changes, and anything else that
 * carries no text. It is an allowlist on purpose: a content type the SDK adds
 * later is ignored until someone decides what it means.
 * @param {object} message a Spectrum message: { direction, content, sender, mentions, ... }
 * @param {object} space   a Spectrum iMessage space: { id, type: 'dm' | 'group', phone }
 * @returns {{ text: string, sender: { id: string } | undefined, group: boolean, mentionsAgent: boolean, repliesToAgent: boolean } | null}
 */
export function readInbound(message, space) {
  if (!isFromAPerson(message, space)) return null;
  const { content, target } = unwrapReply(message.content);
  const text = clampText(textOf(content), MAX_INBOUND_CHARS).trim();
  // A green-bubble tapback arrives as text (Liked "..."). It is a reaction like any other, not something to answer.
  if (!text || isTapbackText(text)) return null;
  return {
    text,
    sender: senderOf(message),
    group: space?.type === 'group',
    mentionsAgent: mentionsHandle(message.mentions, space?.phone),
    // Only a resolved target says whose bubble it was; the SDK's stub target has no direction and counts as "not ours".
    repliesToAgent: target?.direction === 'outbound',
  };
}

/**
 * True for a DM message that is only media (a photo, a voice note, a contact
 * card). Those deserve one honest "I only read text" line. In a group the same
 * message is just friends sharing photos, so the agent stays out of it.
 * @param {object} message
 * @param {object} space
 * @returns {boolean}
 */
export function needsTextNotice(message, space) {
  if (space?.type === 'group' || !isFromAPerson(message, space)) return false;
  const { content } = unwrapReply(message.content);
  if (textOf(content)) return false;
  const items = content?.type === 'group' ? itemsOf(content).map((item) => item?.content) : [content];
  return items.some((item) => MEDIA_TYPES.has(item?.type));
}

/**
 * Whether the agent should take this turn. A DM is always addressed to it. In
 * a group it speaks only when spoken to: named, @mentioned, replied to, or when
 * this same person is answering a question the agent asked them recently.
 * @param {{ text: string, sender?: { id: string }, group: boolean, mentionsAgent: boolean, repliesToAgent: boolean }} inbound
 * @param {{ awaiting?: Record<string, number> } | undefined} state session.state; respond() maintains `awaiting`
 * @param {number} now epoch milliseconds
 * @returns {boolean}
 */
export function shouldRespond(inbound, state, now) {
  if (!inbound.group) return true;
  if (inbound.mentionsAgent || inbound.repliesToAgent || namesAgent(inbound.text)) return true;
  // respond() files the open question under the canonical handle, so look it up the same way.
  const askedAt = state?.awaiting?.[canonicalSender(inbound.sender?.id) ?? ''];
  return typeof askedAt === 'number' && now >= askedAt && now - askedAt < AWAITING_WINDOW_MS;
}

/**
 * People text in bursts ("hey" / "wait" / "actually friday"). Split a space's
 * queue into the messages that open the next turn (the unbroken run from the
 * sender at the head of the line) and the rest. The run stops at the first
 * message from anyone else: in a group, Alice's later "yes do it" must not
 * jump ahead of Bob's "no wait" that arrived before it.
 * @template {{ senderKey: string }} T
 * @param {T[]} queue
 * @returns {{ burst: T[], rest: T[] }}
 */
export function takeBurst(queue) {
  const other = queue.findIndex((item) => item.senderKey !== queue[0]?.senderKey);
  const end = other === -1 ? queue.length : other;
  return { burst: queue.slice(0, end), rest: queue.slice(end) };
}

/**
 * Fold a burst from one sender into a single inbound: the texts joined with
 * newlines, and addressed to the agent if any one of them was.
 * @param {Array<NonNullable<ReturnType<typeof readInbound>>>} inbounds at least one
 * @returns {NonNullable<ReturnType<typeof readInbound>>}
 */
export function mergeInbound(inbounds) {
  return {
    ...inbounds[0],
    text: clampText(inbounds.map((inbound) => inbound.text).join('\n'), MAX_INBOUND_CHARS).trim(),
    mentionsAgent: inbounds.some((inbound) => inbound.mentionsAgent),
    repliesToAgent: inbounds.some((inbound) => inbound.repliesToAgent),
  };
}

/**
 * Contract parts (docs/contract.md) as an ordered list of iMessage sends.
 *
 * - The words go first and in one bubble, so the answer reads before any photo loads.
 * - One bubble per card: its first photo with the caption attached. Cards and
 *   gallery photos are capped, tighter in a group.
 * - Links are always plain text and never a rich link: a rich link makes
 *   Photon's sending client fetch the URL for a preview, and the sandbox says
 *   payment links must not be prefetched. A link the text already carries is
 *   dropped, so the payment URL goes out exactly once.
 * @param {Array<object>} parts
 * @param {{ group?: boolean }} [channel]
 * @returns {Array<{ kind: 'text', text: string } | { kind: 'photo', url: string, caption: string }>}
 */
export function planOutbound(parts, { group = false } = {}) {
  const limit = group ? MAX_CARDS.group : MAX_CARDS.dm;
  const ofKind = (kind) => parts.filter((part) => part?.kind === kind);
  const words = ofKind('text').map((part) => String(part.text ?? '').trim()).filter(Boolean).join('\n\n');

  const steps = words ? [{ kind: 'text', text: words }] : [];
  steps.push(...galleryOf(ofKind('image').slice(0, limit)));
  steps.push(...ofKind('card').slice(0, limit).map(cardStep));
  for (const link of ofKind('link')) {
    if (link.url && !words.includes(link.url)) steps.push({ kind: 'text', text: [link.label, link.url].filter(Boolean).join(': ') });
  }
  return steps;
}

/** A card is one bubble: its first photo with title, subtitle and map link as the caption, or just those words when it has no photo. */
function cardStep(card) {
  const caption = [card.title, card.subtitle, card.url].filter(Boolean).join('\n');
  const url = card.photoUrls?.[0];
  return url ? { kind: 'photo', url, caption } : { kind: 'text', text: caption };
}

/** parts.js repeats the listing name on every gallery photo; say it once per run and let the rest be bare pictures. */
function galleryOf(images) {
  return images.map((image, index) => {
    const caption = String(image.caption ?? '').trim();
    const repeated = index > 0 && caption === String(images[index - 1].caption ?? '').trim();
    return { kind: 'photo', url: image.url, caption: repeated ? '' : caption };
  });
}

/** Inbound, not machine traffic, and not the line's own number echoed back. */
function isFromAPerson(message, space) {
  if (!message?.content || message.direction !== 'inbound') return false;
  if (MACHINE_FLAGS.some((flag) => message[flag] === true)) return false;
  return !sameHandle(message.sender?.id, space?.phone);
}

/** An inline (threaded) reply wraps the real content; unwrap it and keep the bubble it points at. */
function unwrapReply(content) {
  return content?.type === 'reply' ? { content: content.content, target: content.target } : { content, target: undefined };
}

/** Said by name, in the person's own prose. */
function namesAgent(text) {
  return AGENT_NAME.test(NOT_PROSE.reduce((prose, pattern) => prose.replace(pattern, ' '), text));
}

/** The words in a message: a text bubble, or the text items of a text-plus-attachment message. */
function textOf(content) {
  if (content?.type === 'text') return String(content.text ?? '').replace(INVISIBLE, '').trim();
  if (content?.type !== 'group') return '';
  return itemsOf(content).map((item) => textOf(item?.content)).filter(Boolean).join('\n');
}

/** The SDK validates `items`, but one malformed record must not throw out of the stream loop. */
function itemsOf(content) {
  return Array.isArray(content.items) ? content.items : [];
}

function senderOf(message) {
  const id = String(message.sender?.id ?? '').trim();
  return id ? { id } : undefined;
}

/** On a shared-pool line space.phone is the sentinel "shared", so a mention can only be matched on a dedicated number. */
function mentionsHandle(mentions, phone) {
  return Array.isArray(mentions) && mentions.some((mention) => sameHandle(mention?.address, phone));
}

function sameHandle(a, b) {
  const left = normaliseHandle(a);
  return left !== '' && left !== 'shared' && left === normaliseHandle(b);
}

function normaliseHandle(handle) {
  return String(handle ?? '').trim().toLowerCase();
}
