/**
 * Offline tests for the iMessage channel: the pure rules in
 * agent/imessage-policy.js, then the whole shell in agent/imessage.js driven
 * through fakes (tests/fakes/spectrum.js) with the brain stubbed. Nothing here
 * connects to Spectrum or calls a model.
 *
 *   node --test tests/imessage.unit.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { attachment } from '@spectrum-ts/core';
import { createChannel, fetchPhoto } from '../agent/imessage.js';
import { AWAITING_WINDOW_MS, MAX_INBOUND_CHARS, mergeInbound, needsTextNotice, planOutbound, readInbound, shouldRespond, takeBurst } from '../agent/imessage-policy.js';
import {
  AGENT_PHONE, ALICE, BOB, agentBubble, contactCard, fakeSpace, groupEvents, grouped, inlineReply, photo, poll, pollVote,
  readReceipt, sentTexts, tapback, text, unsupported, voiceNote,
} from './fakes/spectrum.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PAY_URL = 'https://api.plec.ai/hackathon/sandbox/pay/ps_123';
const PICSUM = 'https://picsum.photos/seed/foundry-fishtown-1/800/500';
const SILENT = { log() {}, warn() {}, error() {} };
const NOW = 1_800_000_000_000;

const card = (n, extra = {}) => ({ kind: 'card', title: `Venue ${n}`, subtitle: `Loft - Philadelphia - $${n}00/hour`, photoUrls: [`https://picsum.photos/seed/venue-${n}/800/500`], ...extra });

/** Content that is not someone talking: none of it may ever produce a reply, in a DM or a group. */
function notSpeech(space) {
  const bubble = agentBubble(space);
  return [
    readReceipt(bubble), tapback(bubble), pollVote(), poll(), unsupported(), ...groupEvents(),
    { type: 'edit', target: bubble, content: text('edited') }, { type: 'unsend', target: bubble },
    { type: 'typing', state: 'start' }, { type: 'richlink', url: 'https://example.com' }, { type: 'markdown', markdown: '**hi**' },
    inlineReply(tapback(bubble), bubble), text('   '),
    // What a sticker or a still-transferring attachment leaves behind: text made only of characters that render as nothing.
    text('\uFFFC'), text('\u200B'), text(' \u200D\uFEFF '),
    // A green-bubble member's tapback arrives as text.
    text('Liked \u201CWant me to go ahead and book it?\u201D'), text('Loved an image'), text('Emphasized \u201CPlec here, want me to book it?\u201D'),
  ];
}

/** A channel wired to a stubbed brain. `reply` is the parts to return, or a function of the respond() input. */
function harness({ reply = [{ kind: 'text', text: 'On it.' }], state = {}, loadPhoto = async () => ({ bytes: PNG, mimeType: 'image/png' }), settleMs = 0 } = {}) {
  const turns = [];
  const locks = [];
  const session = { messages: [], state };
  const channel = createChannel({
    respond: async (input) => {
      turns.push(input);
      return typeof reply === 'function' ? reply(input) : reply;
    },
    withSessionLock: async (sessionId, fn) => {
      locks.push(sessionId);
      return fn();
    },
    getSession: () => session,
    loadPhoto,
    settleMs,
    paceMs: 0,
    retryMs: 0,
    now: () => NOW,
    log: SILENT,
  });
  return { channel, turns, locks, session };
}

// ---------------------------------------------------------------- readInbound

test('readInbound: a DM text becomes a turn with the sender and no group flags', () => {
  const space = fakeSpace();
  assert.deepEqual(readInbound(space.newMessage(text('  a loft for 40 in Philly  ')), space), {
    text: 'a loft for 40 in Philly', sender: { id: ALICE }, group: false, mentionsAgent: false, repliesToAgent: false,
  });
});

test('readInbound: receipts, tapbacks, polls, votes, group events and empty text are all ignored', () => {
  for (const space of [fakeSpace(), fakeSpace({ type: 'group' })]) {
    for (const content of notSpeech(space)) {
      assert.equal(readInbound(space.newMessage(content), space), null, `${space.type} ${content.type}`);
      assert.equal(needsTextNotice(space.newMessage(content), space), false, `${space.type} ${content.type} notice`);
    }
  }
});

test('readInbound: outbound messages, echoes of our own line and machine traffic are ignored', () => {
  const space = fakeSpace();
  assert.equal(readInbound(space.newMessage(text('hello'), { direction: 'outbound' }), space), null);
  assert.equal(readInbound(space.newMessage(text('hello'), { sender: AGENT_PHONE }), space), null);
  for (const flag of ['isSystemMessage', 'isServiceMessage', 'isSpam', 'isAutoReply', 'isCorrupt']) {
    assert.equal(readInbound(space.newMessage(text('I am driving'), { extras: { [flag]: true } }), space), null, flag);
  }
});

test('readInbound: an inline reply is unwrapped, and knows whether it answers one of our bubbles', () => {
  const space = fakeSpace({ type: 'group' });
  const toAgent = readInbound(space.newMessage(inlineReply(text('yes, book it'), agentBubble(space))), space);
  assert.equal(toAgent.text, 'yes, book it');
  assert.equal(toAgent.repliesToAgent, true);

  const toFriend = readInbound(space.newMessage(inlineReply(text('lol same'), space.newMessage(text('so tired'), { sender: BOB }))), space);
  assert.equal(toFriend.repliesToAgent, false);

  const stubTarget = { id: 'guid', content: { type: 'custom', raw: { imessage_type: 'reply-target', stub: true } } };
  assert.equal(readInbound(space.newMessage(inlineReply(text('ok'), stubTarget)), space).repliesToAgent, false);
});

test('readInbound: text sent with a photo keeps its text, also inside an inline reply', () => {
  const space = fakeSpace();
  assert.equal(readInbound(space.newMessage(grouped(space, photo(), text('something like this?'))), space).text, 'something like this?');
  const replied = inlineReply(grouped(space, text('like this one'), photo()), agentBubble(space));
  assert.equal(readInbound(space.newMessage(replied), space).text, 'like this one');
});

test('readInbound: text is clamped, a mention of our number is seen, a missing sender is undefined', () => {
  const space = fakeSpace({ type: 'group' });
  assert.equal(readInbound(space.newMessage(text('x'.repeat(5000))), space).text.length, MAX_INBOUND_CHARS);
  const cutMidEmoji = readInbound(space.newMessage(text(`${'x'.repeat(1999)}\u{1F600}${'y'.repeat(3000)}`)), space).text;
  assert.ok(cutMidEmoji.isWellFormed() && cutMidEmoji.length === 1999, 'a clamp that lands inside an emoji drops the whole emoji');

  const mention = (address) => [{ address, start: 0, length: 5 }];
  assert.equal(readInbound(space.newMessage(text('@Plec hi'), { mentions: mention(AGENT_PHONE) }), space).mentionsAgent, true);
  assert.equal(readInbound(space.newMessage(text('@Bob hi'), { mentions: mention(BOB) }), space).mentionsAgent, false);

  const sharedLine = fakeSpace({ type: 'group', phone: 'shared' });
  assert.equal(readInbound(sharedLine.newMessage(text('hi'), { mentions: mention('shared') }), sharedLine).mentionsAgent, false);
  assert.equal(readInbound(space.newMessage(text('hi'), { sender: null }), space).sender, undefined);
});

test('needsTextNotice: only for media with no words, and only in a DM', () => {
  const dm = fakeSpace();
  for (const content of [photo(), voiceNote(), contactCard(), grouped(dm, photo(), photo()), inlineReply(photo(), agentBubble(dm))]) {
    assert.equal(needsTextNotice(dm.newMessage(content), dm), true, content.type);
    assert.equal(readInbound(dm.newMessage(content), dm), null, content.type);
  }
  assert.equal(needsTextNotice(dm.newMessage(grouped(dm, photo(), text('this one'))), dm), false);
  assert.equal(needsTextNotice(dm.newMessage(photo(), { direction: 'outbound' }), dm), false);
  const group = fakeSpace({ type: 'group' });
  assert.equal(needsTextNotice(group.newMessage(photo()), group), false);
});

// -------------------------------------------------------------- shouldRespond

const inGroup = (extra = {}) => ({ text: 'what time works for everyone', sender: { id: ALICE }, group: true, mentionsAgent: false, repliesToAgent: false, ...extra });

test('shouldRespond: always in a DM', () => {
  assert.equal(shouldRespond(inGroup({ group: false }), {}, NOW), true);
  assert.equal(shouldRespond(inGroup({ group: false }), undefined, NOW), true);
});

test('shouldRespond: a group is silent until the agent is named, mentioned or replied to', () => {
  assert.equal(shouldRespond(inGroup(), {}, NOW), false);
  assert.equal(shouldRespond(inGroup(), undefined, NOW), false);
  for (const named of ['plec find us a loft', 'hey PLEC, any rooftops?', 'ask the Concierge', '@plec yes']) {
    assert.equal(shouldRespond(inGroup({ text: named }), {}, NOW), true, named);
  }
  for (const notNamed of ['plectrum guitars are cool', 'the concierges were rude', 'complected', 'plec\u00E9']) {
    assert.equal(shouldRespond(inGroup({ text: notNamed }), {}, NOW), false, notNamed);
  }
  assert.equal(shouldRespond(inGroup({ mentionsAgent: true }), {}, NOW), true);
  assert.equal(shouldRespond(inGroup({ repliesToAgent: true }), {}, NOW), true);
});

test('shouldRespond: the name inside a link, an email address or a quoted bubble is not someone calling the agent', () => {
  const pasted = [
    `did you pay ${PAY_URL} yet?`, 'mail me at sam@plec.ai', 'see www.concierge.com/x', 'https://example.com/plec', 'it is on plec.ai somewhere',
    'he wrote \u201Cplec here, want me to book it?\u201D lol',
  ];
  for (const words of pasted) assert.equal(shouldRespond(inGroup({ text: words }), {}, NOW), false, words);
  for (const words of ['the concierge desk at the hotel', 'Plec, find a loft', `plec is ${PAY_URL} still good?`]) {
    assert.equal(shouldRespond(inGroup({ text: words }), {}, NOW), true, words);
  }
});

test('shouldRespond: the open question is found however the handle is spelled', () => {
  const state = { awaiting: { '+15550000001': NOW - 1_000, 'ana@icloud.com': NOW - 1_000 } };
  for (const id of ['+15550000001', '+1 (555) 000-0001', '15550000001', ' +15550000001 ', 'Ana@iCloud.com']) {
    assert.equal(shouldRespond(inGroup({ text: 'yes', sender: { id } }), state, NOW), true, id);
  }
});

test('shouldRespond: an open question keeps the floor for the person asked, for ten minutes', () => {
  const state = { awaiting: { [ALICE]: NOW - 60_000 } };
  assert.equal(shouldRespond(inGroup({ text: 'yes' }), state, NOW), true);
  assert.equal(shouldRespond(inGroup({ text: 'yes', sender: { id: BOB } }), state, NOW), false, 'someone else');
  assert.equal(shouldRespond(inGroup({ text: 'yes', sender: undefined }), state, NOW), false, 'no sender');
  assert.equal(shouldRespond(inGroup({ text: 'yes' }), state, NOW - 60_000 + AWAITING_WINDOW_MS), false, 'expired');
  assert.equal(shouldRespond(inGroup({ text: 'yes' }), state, NOW - 60_000 + AWAITING_WINDOW_MS - 1), true, 'last millisecond');
  assert.equal(shouldRespond(inGroup({ text: 'yes' }), { awaiting: { [ALICE]: NOW + 5_000 } }, NOW), false, 'timestamp from the future');
});

// ---------------------------------------------------------- takeBurst / merge

test('takeBurst: the unbroken run from the sender at the head of the line, and nobody jumps the queue', () => {
  const queue = [{ senderKey: ALICE, n: 1 }, { senderKey: ALICE, n: 2 }, { senderKey: BOB, n: 3 }, { senderKey: ALICE, n: 4 }];
  const { burst, rest } = takeBurst(queue);
  assert.deepEqual(burst.map((item) => item.n), [1, 2]);
  assert.deepEqual(rest.map((item) => item.n), [3, 4], "Alice's later message waits behind Bob's earlier one");
  assert.deepEqual(takeBurst([]), { burst: [], rest: [] });
});

test('mergeInbound: texts joined with newlines, addressed if any one of them was', () => {
  const merged = mergeInbound([inGroup({ text: 'hey plec' }), inGroup({ text: 'loft for 40', repliesToAgent: true }), inGroup({ text: 'in philly' })]);
  assert.equal(merged.text, 'hey plec\nloft for 40\nin philly');
  assert.equal(merged.repliesToAgent, true);
  assert.equal(merged.mentionsAgent, false);
  assert.deepEqual(merged.sender, { id: ALICE });
  assert.equal(mergeInbound([inGroup({ text: 'a'.repeat(1500) }), inGroup({ text: 'b'.repeat(1500) })]).text.length, MAX_INBOUND_CHARS);
  const split = mergeInbound([inGroup({ text: 'a'.repeat(1998) }), inGroup({ text: '\u{1F600}' })]).text;
  assert.ok(split.isWellFormed() && split.length === 1998, 'the clamp never leaves half an emoji');
});

// ---------------------------------------------------------------- planOutbound

test('planOutbound: words first in one bubble, then one photo step per card with its caption', () => {
  const parts = [{ kind: 'text', text: 'Three that fit:' }, card(1, { url: 'https://maps.example/1' }), card(2), { kind: 'text', text: 'Want a price for one?' }];
  assert.deepEqual(planOutbound(parts), [
    { kind: 'text', text: 'Three that fit:\n\nWant a price for one?' },
    { kind: 'photo', url: 'https://picsum.photos/seed/venue-1/800/500', caption: 'Venue 1\nLoft - Philadelphia - $100/hour\nhttps://maps.example/1' },
    { kind: 'photo', url: 'https://picsum.photos/seed/venue-2/800/500', caption: 'Venue 2\nLoft - Philadelphia - $200/hour' },
  ]);
});

test('planOutbound: at most 4 cards in a DM and 3 in a group, and a card without a photo is text', () => {
  const six = [{ kind: 'text', text: 'Options:' }, ...[1, 2, 3, 4, 5, 6].map((n) => card(n))];
  assert.equal(planOutbound(six).filter((step) => step.kind === 'photo').length, 4);
  assert.equal(planOutbound(six, { group: false }).length, 5);
  assert.equal(planOutbound(six, { group: true }).filter((step) => step.kind === 'photo').length, 3);
  assert.deepEqual(planOutbound([card(1, { photoUrls: [] })]), [{ kind: 'text', text: 'Venue 1\nLoft - Philadelphia - $100/hour' }]);
});

test('planOutbound: image parts become photo steps, captioned once per listing and capped', () => {
  const images = [1, 2, 3, 4, 5].map((n) => ({ kind: 'image', url: `https://picsum.photos/seed/foundry-${n}/800/500`, caption: 'The Foundry' }));
  const steps = planOutbound([{ kind: 'text', text: 'Here it is.' }, ...images], { group: true });
  assert.deepEqual(steps.map((step) => step.kind), ['text', 'photo', 'photo', 'photo']);
  assert.deepEqual(steps.slice(1).map((step) => step.caption), ['The Foundry', '', '']);
  assert.equal(planOutbound(images).length, 4);
});

test('planOutbound: a payment link already in the text is dropped, so the URL goes out exactly once', () => {
  const parts = [{ kind: 'text', text: `Booked! Pay here to lock in BK-2001: ${PAY_URL}` }, { kind: 'link', label: 'Pay to confirm BK-2001', url: PAY_URL }];
  const steps = planOutbound(parts);
  assert.equal(steps.length, 1);
  assert.equal(JSON.stringify(steps).split(PAY_URL).length - 1, 1);
});

test('planOutbound: a link the text lacks goes out as plain "label: url" text, never as a rich link', () => {
  const parts = [{ kind: 'text', text: 'Booked, BK-2001.' }, { kind: 'link', label: 'Pay to confirm BK-2001', url: PAY_URL }, { kind: 'link', label: 'Open in Google Maps', url: 'https://maps.example/x' }];
  const steps = planOutbound(parts, { group: true });
  assert.deepEqual(steps.slice(1), [
    { kind: 'text', text: `Pay to confirm BK-2001: ${PAY_URL}` },
    { kind: 'text', text: 'Open in Google Maps: https://maps.example/x' },
  ]);
  assert.ok(steps.every((step) => step.kind === 'text' || step.kind === 'photo'));
});

test('planOutbound: nothing to say plans nothing, and unknown part kinds are skipped', () => {
  assert.deepEqual(planOutbound([]), []);
  assert.deepEqual(planOutbound([{ kind: 'text', text: '  ' }, { kind: 'hologram' }, null]), []);
});

// ------------------------------------------------------------------ the shell

test('channel: a DM text runs one locked turn with sender and channel, and sends the reply', async () => {
  const { channel, turns, locks, session } = harness({ reply: [{ kind: 'text', text: 'Philly, got it. What date?' }] });
  const space = fakeSpace();
  const message = space.newMessage(text('a loft in philly'));
  channel.accept(space, message);
  await channel.idle();

  assert.deepEqual(locks, [`imessage:${space.id}`]);
  assert.deepEqual(turns, [{ sessionId: `imessage:${space.id}`, text: 'a loft in philly', session, sender: { id: ALICE }, channel: { kind: 'imessage', group: false } }]);
  assert.deepEqual(space.sent, [{ kind: 'text', text: 'Philly, got it. What date?' }]);
  assert.deepEqual(space.calls, ['typing:start', 'typing:stop', 'send:text']);
  assert.equal(message.reads, 1);
});

test('channel: read receipts, tapbacks, polls and group events produce zero sends and zero turns', async () => {
  for (const space of [fakeSpace(), fakeSpace({ type: 'group' })]) {
    const { channel, turns, locks } = harness();
    for (const content of notSpeech(space)) channel.accept(space, space.newMessage(content));
    channel.accept(space, space.newMessage(text('hello'), { direction: 'outbound' }));
    await channel.idle();
    assert.deepEqual(space.calls, [], space.type);
    assert.deepEqual(turns, []);
    assert.deepEqual(locks, []);
  }
});

test('channel: a photo on its own gets one short text-only note in a DM and silence in a group', async () => {
  const dm = fakeSpace();
  const first = harness({ settleMs: 5 });
  for (const content of [photo(), photo(), voiceNote()]) first.channel.accept(dm, dm.newMessage(content));
  await first.channel.idle();
  assert.equal(dm.sent.length, 1);
  assert.match(dm.sent[0].text, /only read text/);
  assert.deepEqual(first.turns, []);

  const group = fakeSpace({ type: 'group' });
  const second = harness();
  second.channel.accept(group, group.newMessage(photo()));
  await second.channel.idle();
  assert.deepEqual(group.calls, []);
});

test('channel: a photo sent alongside words is answered as words, with no text-only note', async () => {
  const { channel, turns } = harness({ settleMs: 5 });
  const space = fakeSpace();
  channel.accept(space, space.newMessage(photo()));
  channel.accept(space, space.newMessage(text('something like this, for 40')));
  await channel.idle();
  assert.equal(turns.length, 1);
  assert.deepEqual(sentTexts(space), ['On it.']);
});

test('channel: friends talking to each other in a group get silence: no model, no typing, no receipt', async () => {
  const { channel, turns, locks } = harness();
  const space = fakeSpace({ type: 'group' });
  const message = space.newMessage(text('what time works for everyone?'));
  channel.accept(space, message);
  await channel.idle();
  assert.deepEqual(turns, []);
  assert.deepEqual(space.calls, []);
  assert.equal(message.reads, 0);
  assert.deepEqual(locks, [`imessage:${space.id}`], 'the awaiting check reads session state, so it runs under the lock');
});

test('channel: every group trigger gets an answer', async () => {
  const space = fakeSpace({ type: 'group' });
  const triggers = [
    space.newMessage(text('plec, find us a rooftop')),
    space.newMessage(text('any ideas?'), { mentions: [{ address: AGENT_PHONE, start: 0, length: 4 }] }),
    space.newMessage(inlineReply(text('yes do it'), agentBubble(space))),
  ];
  for (const message of triggers) {
    const { channel, turns } = harness();
    channel.accept(space, message);
    await channel.idle();
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].channel, { kind: 'imessage', group: true });
  }
  assert.equal(space.sent.length, triggers.length);
});

test('channel: in a group, only the person the agent asked can answer without naming it', async () => {
  const { channel, turns } = harness({ state: { awaiting: { [ALICE]: NOW - 30_000 } } });
  const space = fakeSpace({ type: 'group' });
  channel.accept(space, space.newMessage(text('yes'), { sender: BOB }));
  channel.accept(space, space.newMessage(text('yes, go ahead')));
  await channel.idle();
  assert.deepEqual(turns.map((turn) => [turn.sender.id, turn.text]), [[ALICE, 'yes, go ahead']]);
});

test('channel: a burst that arrives together is one turn', async () => {
  const { channel, turns } = harness({ settleMs: 5 });
  const space = fakeSpace();
  for (const words of ['hey', 'wait', 'actually friday not saturday']) channel.accept(space, space.newMessage(text(words)));
  await channel.idle();
  assert.deepEqual(turns.map((turn) => turn.text), ['hey\nwait\nactually friday not saturday']);
  assert.equal(space.sent.length, 1);
});

test('channel: texts that land while a turn is running are joined into the next turn, without overtaking anyone', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { channel, turns } = harness({
    reply: async ({ text: words }) => {
      if (words === 'plec hey') await gate;
      return [{ kind: 'text', text: `re: ${words}` }];
    },
  });
  const space = fakeSpace({ type: 'group' });
  channel.accept(space, space.newMessage(text('plec hey')));
  channel.accept(space, space.newMessage(text('plec we need a loft')));
  channel.accept(space, space.newMessage(text('for 40 people')));
  channel.accept(space, space.newMessage(text('concierge no wait, not that one'), { sender: BOB }));
  channel.accept(space, space.newMessage(text('plec yes do it')));
  release();
  await channel.idle();

  assert.deepEqual(turns.map((turn) => [turn.sender.id, turn.text]), [
    [ALICE, 'plec hey'],
    [ALICE, 'plec we need a loft\nfor 40 people'],
    [BOB, 'concierge no wait, not that one'],
    [ALICE, 'plec yes do it'],
  ]);
  assert.deepEqual(sentTexts(space), ['re: plec hey', 're: plec we need a loft\nfor 40 people', 're: concierge no wait, not that one', 're: plec yes do it']);
});

test('channel: a redelivered message id is answered once', async () => {
  const { channel, turns } = harness();
  const space = fakeSpace();
  const message = space.newMessage(text('hello'));
  channel.accept(space, message);
  await channel.idle();
  channel.accept(space, message);
  await channel.idle();
  assert.equal(turns.length, 1);
});

test('channel: cards go out as one photo bubble each, with real bytes, a name and a MIME type', async () => {
  const loaded = [];
  const { channel } = harness({
    reply: [{ kind: 'text', text: 'Two that fit:' }, card(1), card(2)],
    loadPhoto: async (url) => {
      loaded.push(url);
      return { bytes: PNG, mimeType: 'image/jpeg' };
    },
  });
  const space = fakeSpace();
  channel.accept(space, space.newMessage(text('lofts in philly')));
  await channel.idle();
  assert.deepEqual(loaded, ['https://picsum.photos/seed/venue-1/800/500', 'https://picsum.photos/seed/venue-2/800/500']);
  assert.deepEqual(space.sent, [
    { kind: 'text', text: 'Two that fit:' },
    { kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg', bytes: PNG.length, caption: 'Venue 1\nLoft - Philadelphia - $100/hour' },
    { kind: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg', bytes: PNG.length, caption: 'Venue 2\nLoft - Philadelphia - $200/hour' },
  ]);
});

test('channel: a photo that cannot be loaded or sent degrades to its caption, never to a raw URL', async () => {
  const reply = [{ kind: 'text', text: 'Here you go:' }, card(1), { kind: 'image', url: PICSUM, caption: '' }];
  const cannotLoad = harness({ reply, loadPhoto: async () => { throw new Error('photo fetch returned 503'); } });
  const cannotSend = harness({ reply });
  const spaces = [fakeSpace(), fakeSpace({ failing: { photos: true } })];
  cannotLoad.channel.accept(spaces[0], spaces[0].newMessage(text('show me')));
  cannotSend.channel.accept(spaces[1], spaces[1].newMessage(text('show me')));
  await Promise.all([cannotLoad.channel.idle(), cannotSend.channel.idle()]);

  for (const space of spaces) {
    assert.deepEqual(space.sent, [{ kind: 'text', text: 'Here you go:' }, { kind: 'text', text: 'Venue 1\nLoft - Philadelphia - $100/hour' }]);
    assert.ok(!JSON.stringify(space.sent).includes('picsum'));
  }
});

test('channel: typing and read-receipt failures never fail the turn', async () => {
  const { channel, turns } = harness();
  const space = fakeSpace({ failing: { typingStart: true, typingStop: true, read: true } });
  channel.accept(space, space.newMessage(text('hello')));
  await channel.idle();
  assert.equal(turns.length, 1);
  assert.deepEqual(sentTexts(space), ['On it.']);
  await assert.rejects(space.responding(async () => 'never runs'), /typing start rejected/, 'what space.responding() would have done');
});

test('channel: a failed text is retried once, and a text that fails twice does not stop the rest', async () => {
  const once = harness();
  const flaky = fakeSpace({ failing: { texts: 1 } });
  once.channel.accept(flaky, flaky.newMessage(text('hello')));
  await once.channel.idle();
  assert.deepEqual(flaky.calls.filter((call) => call === 'send:text').length, 2);
  assert.deepEqual(sentTexts(flaky), ['On it.']);

  const twice = harness({ reply: [{ kind: 'text', text: 'Lost.' }, card(1)] });
  const broken = fakeSpace({ failing: { texts: 2 } });
  twice.channel.accept(broken, broken.newMessage(text('hello')));
  await twice.channel.idle();
  assert.deepEqual(broken.sent.map((record) => record.kind), ['photo']);
});

test('channel: a brain that throws gets one in-voice apology, and the chat keeps working', async () => {
  let calls = 0;
  const { channel } = harness({
    reply: () => {
      calls += 1;
      if (calls === 1) throw new Error('model exploded');
      return [{ kind: 'text', text: 'Back.' }];
    },
  });
  const space = fakeSpace();
  channel.accept(space, space.newMessage(text('first')));
  await channel.idle();
  channel.accept(space, space.newMessage(text('second')));
  await channel.idle();
  assert.equal(sentTexts(space).length, 2);
  assert.match(sentTexts(space)[0], /something broke on my end/i);
  assert.equal(sentTexts(space)[1], 'Back.');
  assert.deepEqual(space.calls.filter((call) => call.startsWith('typing')), ['typing:start', 'typing:stop', 'typing:start', 'typing:stop']);
});

test('channel: an event the rules cannot read is skipped, and the stream keeps being answered', async () => {
  const { channel, turns } = harness();
  const space = fakeSpace();
  assert.doesNotThrow(() => channel.accept(undefined, space.newMessage(text('hello'))));
  assert.doesNotThrow(() => channel.accept(space, { id: 'm-bad', direction: 'inbound', sender: { id: ALICE }, content: { type: 'group', items: {} } }));
  channel.accept(space, space.newMessage(text('still there?')));
  await channel.idle();
  assert.deepEqual(turns.map((turn) => turn.text), ['still there?']);
});

test('channel: with debug on, a dropped event logs its type and never its words', async () => {
  const lines = [];
  const channel = createChannel({
    respond: async () => [], withSessionLock: async (id, fn) => fn(), getSession: () => ({ state: {} }),
    settleMs: 0, paceMs: 0, retryMs: 0, debug: true, log: { ...SILENT, log: (line) => lines.push(line) },
  });
  const space = fakeSpace();
  channel.accept(space, space.newMessage(readReceipt(agentBubble(space))));
  channel.accept(space, space.newMessage(text('Liked \u201Csecret words\u201D')));
  await channel.idle();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /dropped inbound read$/);
  assert.match(lines[1], /dropped inbound text$/);
  assert.ok(!lines.join(' ').includes('secret'));
});

test('channel: chats do not wait on each other, and a closed channel accepts nothing', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { channel, turns } = harness({ reply: async ({ text: words }) => (words === 'slow' ? gate.then(() => []) : [{ kind: 'text', text: 'fast' }]) });
  const slow = fakeSpace({ id: 'any;-;+15552220001' });
  const fast = fakeSpace({ id: 'any;-;+15552220002' });
  channel.accept(slow, slow.newMessage(text('slow')));
  channel.accept(fast, fast.newMessage(text('quick')));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sentTexts(fast), ['fast']);
  release();
  await channel.idle();

  channel.close();
  channel.accept(fast, fast.newMessage(text('anyone?')));
  await channel.idle();
  assert.equal(turns.length, 2);
});

// --------------------------------------------------------------------- photos

test('photos: the SDK cannot build an attachment from an extensionless listing URL', async () => {
  await assert.rejects(attachment(new URL(PICSUM)).build(), /Unable to resolve MIME type/);
});

test('photos: fetchPhoto reads the type from the response, and refuses what is not an image', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/seed/')) res.writeHead(200, { 'content-type': 'image/png; charset=binary' }).end(PNG);
    else if (req.url === '/page') res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const loaded = await fetchPhoto(`${base}/seed/foundry-fishtown-1/800/500`);
    assert.equal(loaded.mimeType, 'image/png');
    assert.deepEqual(loaded.bytes, PNG);
    await assert.rejects(fetchPhoto(`${base}/page`), /not an image/);
    await assert.rejects(fetchPhoto(`${base}/missing`), /404/);
    await assert.rejects(fetchPhoto('/relative.png'), /Invalid URL/);

    // End to end through the channel: the same extensionless URL arrives as a real photo bubble.
    const { channel } = harness({ reply: [{ kind: 'image', url: `${base}/seed/foundry-fishtown-1/800/500`, caption: 'The Foundry' }], loadPhoto: fetchPhoto });
    const space = fakeSpace();
    channel.accept(space, space.newMessage(text('show me the foundry')));
    await channel.idle();
    assert.deepEqual(space.sent, [{ kind: 'photo', name: 'photo.png', mimeType: 'image/png', bytes: PNG.length, caption: 'The Foundry' }]);
  } finally {
    server.close();
  }
});
