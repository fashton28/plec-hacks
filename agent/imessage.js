/**
 * The iMessage channel, on Photon's Spectrum Cloud (https://photon.codes/docs).
 *
 * It is a second front door to the same brain. This file is only the shell:
 * it reads the message stream, asks the pure rules in imessage-policy.js what
 * each event means and whether to speak, runs one respond() turn under the
 * session lock, and sends what the policy planned. The HTTP contract in
 * server.js is untouched, so the evaluator and the chat page keep working.
 *
 *   stream -> readInbound -> per-chat queue -> withSessionLock
 *          -> shouldRespond -> respond -> planOutbound -> send
 *
 * What the installed SDK (12.8.0) does, as read from its code, since the docs
 * promise nothing about the stream's delivery: it de-duplicates by message id
 * and resumes from a cursor after a dropped connection, and it keeps that
 * cursor in memory only. So messages sent while this process is down are not
 * replayed on restart. Avoid restarting mid-demo, or ask the person to resend.
 * The SDK also installs its own SIGINT/SIGTERM handlers, which stop the stream
 * and exit the process within about three seconds.
 *
 * Configuration, read when startIMessage() runs:
 *   SPECTRUM_PROJECT_ID       Project Settings on https://app.photon.codes
 *   SPECTRUM_PROJECT_SECRET   same page; treat it like a password
 *
 *   IMESSAGE_DEBUG=1          log the content type of every event that is dropped (never its text)
 *
 * Without the first two, the channel is off and the HTTP server runs alone.
 */

import { Spectrum, attachment, group, text } from '@spectrum-ts/core';
import { imessage } from '@spectrum-ts/imessage';
import { respond } from './agent.js';
import { canonicalSender } from './guards.js';
import { mergeInbound, needsTextNotice, planOutbound, readInbound, shouldRespond, takeBurst } from './imessage-policy.js';
import { getSession, withSessionLock } from './session.js';
import { stage } from './stage.js';

/** Photon's inbound guidance: let a burst of texts settle, then answer whatever accumulated as one turn. */
const SETTLE_MS = 1_000;
/** Photon's deliverability guidance: "Pace messages naturally. Don't fire several within seconds." */
const PACE_MS = 700;
/** About 100 KB each, so the whole catalogue's photos fit comfortably. */
const MAX_CACHED_PHOTOS = 300;
const PHOTO_FETCH_TIMEOUT_MS = 8_000;
const RETRY_MS = 500;
/** How long stop() lets in-flight turns finish before it closes the connection under them. */
const STOP_GRACE_MS = 10_000;
/** The SDK already de-duplicates within one process; this is cheap insurance against answering one message id twice. */
const SEEN_LIMIT = 2_000;

const TEXT_ONLY_NOTICE = "I can only read text for now, so I couldn't open that. Tell me what you're after and I'm on it.";
const TURN_FAILED_NOTICE = 'Ugh, something broke on my end. Mind sending that once more?';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let active = null;

/**
 * Connect to Spectrum and answer messages until stopped. Resolves once
 * connected; never throws, because a broken iMessage channel must not take the
 * HTTP agent down with it.
 * @returns {Promise<{ stop: () => Promise<void> } | null>} null when disabled or unreachable
 */
export async function startIMessage() {
  if (active) return active;
  const projectId = process.env.SPECTRUM_PROJECT_ID || '';
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET || '';
  if (!projectId || !projectSecret) {
    console.log('iMessage:    off (set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env to turn it on)');
    return null;
  }

  let app;
  try {
    app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
  } catch (err) {
    console.error(`iMessage:    could not connect to Spectrum: ${err?.message ?? err}`);
    return null;
  }
  console.log(`iMessage:    connected to Spectrum project "${app.config.name}"`);

  const channel = createChannel({ respond, withSessionLock, getSession, debug: process.env.IMESSAGE_DEBUG === '1' });
  listen(app, channel).catch((err) => console.error('[imessage] message stream ended:', err));

  let stopping;
  active = {
    stop: () => (stopping ??= (async () => {
      channel.close();
      await Promise.race([channel.idle(), sleep(STOP_GRACE_MS)]);
      await app.stop();
      active = null;
    })()),
  };
  return active;
}

/** Stop the channel started by startIMessage(): let in-flight turns finish, then disconnect. Safe to call when it is off. */
export async function stopIMessage() {
  await active?.stop();
}

async function listen(app, channel) {
  for await (const [space, message] of app.messages) channel.accept(space, message);
}

/**
 * The channel without its connection: everything between "a stream event
 * arrived" and "bubbles went out". The brain, the session store, the lock, the
 * photo loader and the timings are injected, so the whole flow runs offline
 * against fakes (tests/imessage.unit.js).
 * @param {object} deps
 * @param {(input: { sessionId: string, text: string, session: object, sender?: { id: string }, channel: { kind: 'imessage', group: boolean } }) => Promise<object[]>} deps.respond
 * @param {<T>(sessionId: string, fn: () => Promise<T>) => Promise<T>} deps.withSessionLock
 * @param {(sessionId: string) => { state: object }} deps.getSession
 * @param {(url: string) => Promise<{ bytes: Buffer, mimeType: string }>} [deps.loadPhoto]
 * @param {number} [deps.settleMs] wait before each turn so a burst can finish arriving
 * @param {number} [deps.paceMs]   pause between bubbles
 * @param {number} [deps.retryMs]  pause before the one retry of a failed text
 * @param {boolean} [deps.debug]   log the content type of dropped events, to watch receipts and tapbacks arrive without answering them
 * @param {() => number} [deps.now]
 * @param {Pick<Console, 'log' | 'warn' | 'error'>} [deps.log]
 * @returns {{ accept: (space: object, message: object) => void, idle: () => Promise<void>, close: () => void }}
 */
export function createChannel({ respond, withSessionLock, getSession, loadPhoto = fetchPhoto, settleMs = SETTLE_MS, paceMs = PACE_MS, retryMs = RETRY_MS, debug = false, now = Date.now, log = console }) {
  /** One lane per chat: turns inside a chat run in order, chats run in parallel. */
  const lanes = new Map();
  const seen = new Set();
  let closed = false;

  /**
   * Queue one stream event, or drop it when it is not someone talking to us.
   * It never throws: the stream loop calls it for every event, and one record
   * the rules choke on must not end iMessage for the life of the process.
   */
  function accept(space, message) {
    if (closed) return;
    try {
      enqueue(space, message);
    } catch (err) {
      log.error(`[imessage ${tagOf(space?.id)}] could not read an event, skipping it:`, err);
    }
  }

  function enqueue(space, message) {
    const inbound = readInbound(message, space);
    if (!inbound && !needsTextNotice(message, space)) {
      // The type only, never the words: enough to see receipts and tapbacks arrive and confirm nothing answers them.
      if (debug) log.log(`[imessage ${tagOf(space?.id)}] dropped ${message?.direction ?? 'unknown'} ${message?.content?.type ?? 'unknown'}`);
      return;
    }
    if (isRepeat(message.id)) return;

    // Filed under the same spelling the brain uses, so one person's burst is not split by a differently formatted handle.
    const item = { senderKey: canonicalSender(message.sender?.id) ?? '', inbound, message, space };
    const lane = lanes.get(space.id);
    if (lane) {
      lane.queue.push(item);
      return;
    }
    const opened = { queue: [item], done: null };
    lanes.set(space.id, opened);
    opened.done = drain(space.id, opened);
  }

  async function idle() {
    while (lanes.size) await Promise.all([...lanes.values()].map((lane) => lane.done));
  }

  async function drain(spaceId, lane) {
    while (lane.queue.length) {
      if (settleMs) await sleep(settleMs);
      // Split at the moment the turn starts, not when a message arrives, so texts that land while an earlier turn is still running join the next one.
      const { burst, rest } = takeBurst(lane.queue);
      lane.queue = rest;
      await runTurn(burst).catch((err) => log.error(`[imessage ${tagOf(spaceId)}] turn crashed:`, err));
    }
    lanes.delete(spaceId);
  }

  async function runTurn(burst) {
    const { space } = burst.at(-1);
    const spoken = burst.filter((item) => item.inbound);
    // Media with no words anywhere in the burst: say so once. When words came with it, answering them is the better reply.
    if (!spoken.length) {
      await sendText(space, TEXT_ONLY_NOTICE);
      return;
    }

    const startedAt = now();
    const inbound = mergeInbound(spoken.map((item) => item.inbound));
    const sessionId = `imessage:${space.id}`;
    let parts;
    try {
      parts = await withSessionLock(sessionId, () => takeTurn(space, sessionId, inbound, spoken.at(-1).message));
    } catch (err) {
      log.error(`[imessage ${tagOf(space.id)}] turn failed after ${now() - startedAt}ms:`, err);
      await sendText(space, TURN_FAILED_NOTICE);
      return;
    }
    if (!parts) return;

    const steps = planOutbound(parts, { group: inbound.group });
    // Start every photo download now, so the cards go out as fast as the line takes them instead of one fetch at a time.
    for (const step of steps) if (step.kind === 'photo') photo(step.url).catch(() => {});
    for (const [index, step] of steps.entries()) {
      if (index && paceMs) await sleep(paceMs);
      await sendStep(space, step);
    }
    log.log(`[imessage ${tagOf(space.id)}] ${now() - startedAt}ms  ${spoken.length} message(s) -> ${steps.map((step) => step.kind).join(',') || 'nothing'}`);
  }

  /**
   * The part of a turn that holds the session lock. Returns null, having
   * touched nothing, when the group was not talking to the agent: no read
   * receipt, no typing bubble, no model call.
   */
  async function takeTurn(space, sessionId, inbound, lastMessage) {
    const session = getSession(sessionId);
    if (!shouldRespond(inbound, session.state, now())) {
      stage.quiet(sessionId, 'nobody was talking to PLEC');
      return null;
    }

    // Read receipts and the typing bubble are polish. A line that rejects them must still get its answer.
    await Promise.all([quietly('mark read', () => lastMessage.read()), quietly('typing start', () => space.startTyping())]);
    try {
      // No outer deadline: respond() bounds itself, and abandoning it here would let the next turn start on a session it is still writing to.
      return await respond({ sessionId, text: inbound.text, session, sender: inbound.sender, channel: { kind: 'imessage', group: inbound.group } });
    } finally {
      await quietly('typing stop', () => space.stopTyping());
    }
  }

  /**
   * Listing photos never change, so each URL is downloaded once per process.
   * The promise is cached, which also lets a turn start all its downloads
   * together. A failed download is forgotten so the next turn can retry it.
   */
  const photos = new Map();
  function photo(url) {
    if (!photos.has(url)) {
      if (photos.size >= MAX_CACHED_PHOTOS) photos.delete(photos.keys().next().value);
      photos.set(url, loadPhoto(url).catch((err) => {
        photos.delete(url);
        throw err;
      }));
    }
    return photos.get(url);
  }

  /** A photo that cannot be sent still owes the person its caption. */
  async function sendStep(space, step) {
    if (step.kind === 'text') {
      await sendText(space, step.text);
      return;
    }
    try {
      // send() resolves undefined, without throwing, when the platform skipped the content.
      if (await space.send(await photoContent(step))) return;
      log.warn(`[imessage ${tagOf(space.id)}] photo skipped by the platform, sending its caption`);
    } catch (err) {
      log.warn(`[imessage ${tagOf(space.id)}] photo failed (${err?.message ?? err}), sending its caption`);
    }
    if (step.caption) await sendText(space, step.caption);
  }

  async function sendText(space, words) {
    try {
      await space.send(words);
    } catch {
      if (retryMs) await sleep(retryMs);
      await space.send(words).catch((err) => log.error(`[imessage ${tagOf(space.id)}] text failed twice, giving up:`, err));
    }
  }

  /** The SDK reads a MIME type off the URL's file extension and listing photos have none, so load the bytes here and name them. */
  async function photoContent(step) {
    const { bytes, mimeType } = await photo(step.url);
    const picture = attachment(bytes, { name: `photo.${extensionOf(mimeType)}`, mimeType });
    return step.caption ? group(picture, text(step.caption)) : picture;
  }

  async function quietly(what, action) {
    try {
      await action();
    } catch (err) {
      log.warn(`[imessage] ${what} failed, carrying on: ${err?.message ?? err}`);
    }
  }

  function isRepeat(id) {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
    return false;
  }

  return { accept, idle, close: () => { closed = true; } };
}

/**
 * Download a photo and trust the server's Content-Type over the URL's shape.
 * @param {string} url
 * @returns {Promise<{ bytes: Buffer, mimeType: string }>}
 */
export async function fetchPhoto(url) {
  const res = await fetch(new URL(url), { redirect: 'follow', signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`photo fetch returned ${res.status}`);
  const mimeType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) throw new Error(`not an image: ${mimeType || 'no content type'}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType };
}

/** image/jpeg -> jpg, image/svg+xml -> svg. Only cosmetic: the MIME type is passed explicitly. */
function extensionOf(mimeType) {
  const subtype = mimeType.split('/')[1] ?? '';
  return subtype.replace('jpeg', 'jpg').replace(/[^a-z0-9].*$/, '') || 'img';
}

const tagOf = (spaceId) => String(spaceId).slice(-8);
