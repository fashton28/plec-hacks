# The iMessage channel

This is the operator guide for running the PLEC Concierge on iMessage.
It covers what the channel is, how to set it up, what the Photon plans mean for group chats, how the agent behaves in a group, the deliverability rules it follows, a live test checklist, and troubleshooting.

Every claim about Photon's platform carries the URL it came from.
Claims marked "SDK source" come from reading the installed packages, `@spectrum-ts/core` and `@spectrum-ts/imessage` 12.8.0, under `node_modules`.
Claims marked "unknown" have not been tested against a live project yet, and section 6 says how to test them.

## 1. What the channel is

The agent has two front doors and one brain.

| front door | file | who uses it | session id |
| --- | --- | --- | --- |
| HTTP | `agent/server.js` | The staff evaluator, the chat page, `npm test`. | Whatever the caller sends as `sessionId`. |
| iMessage | `agent/imessage.js` | Real people texting from the Messages app. | `imessage:<chat guid>`, one session per chat. |

Both doors call the same `respond()` in `agent/agent.js`, get the same contract parts back, and differ only in how they deliver those parts.
The HTTP door returns the parts as JSON.
The iMessage door turns them into native bubbles: text, photos with captions, and plain text links.

The iMessage door runs on Photon's Spectrum Cloud.
Photon operates the phone lines and the Apple side, and our process holds a gRPC stream to it.
The transport needs a Node or Bun runtime, not an edge or worker runtime (https://photon.codes/docs/spectrum-ts/troubleshooting/imessage).
The channel is off unless both `SPECTRUM_` variables are set, and a broken iMessage connection never takes the HTTP agent down.

### Session ids

A chat's guid is stable, so `imessage:<chat guid>` gives one session per DM and one session per group.
A group chat guid contains `;+;` and a DM guid looks like `any;-;+15551111111` (https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing, section "Space types", and SDK source).
Conversation history is per chat.
Identity, consent and open questions are per person inside that chat, keyed by the sender's handle.
Photon recommends the same split: thread per chat, memory per sender (https://photon.codes/docs/best-practices/recovery-and-state, section "Per-resource memory scope").

Sessions live in memory in `agent/session.js`.
A restart forgets every conversation, on both doors.
An idle HTTP session is dropped after two hours.
A session whose id starts with `imessage:` is kept for seven days, because a quote at 9pm often gets its yes the next morning.

### The interface contract

`respond({ sessionId, text, session, sender, channel })`

- `sender` is `{ id: string }` or undefined.
  The id is the speaker's stable handle, a phone number in E.164 form or an email.
  It is undefined on HTTP.
  `respond()` files everything under `canonicalSender(id)` from `agent/guards.js`: trimmed, lower-cased, and a phone number reduced to `+` and its digits.
  So `+1 (555) 000-0001`, `15550000001` and `+15550000001` are one person, and so are `Ana@iCloud.com` and `ana@icloud.com`.
- `channel` is `{ kind: 'http' | 'imessage', group: boolean }` or undefined.
  Undefined means `{ kind: 'http', group: false }`.
- The return value is the same contract parts as always: `text`, `card`, `link`, `image`.

With no sender and no channel, `respond()` behaves exactly as it did before the iMessage channel existed.
That is what keeps the evaluator safe: it sends only `{ sessionId, text }`, and it can still look up a seeded booking such as BK-1001 by reference in a fresh session.

Both doors wrap the whole turn in `withSessionLock(sessionId, fn)` from `agent/session.js`.
It is a per-session FIFO mutex, so two turns on one session can never overlap, and a slow turn cannot be overtaken by the next message.

Open-question tracking lives in `session.state.awaiting`, a map of canonical sender id to a timestamp in milliseconds.
`shouldRespond` canonicalises the handle the same way before it looks the entry up.
`respond()` sets the entry for the current sender when its reply contains a question mark and clears it otherwise.
On HTTP there is no sender, so the map is left alone.

### The policy module

`agent/imessage-policy.js` is pure.
It imports no SDK, does no I/O and reads no clock (its one import, `agent/guards.js`, is pure too), so every rule in it is unit tested offline with plain object fixtures in `tests/imessage.unit.js`.
`agent/imessage.js` only wires it to the live stream.

| function | job |
| --- | --- |
| `readInbound(message, space)` | Turns an SDK message into `{ text, sender, group, mentionsAgent, repliesToAgent }`, or null when the message must be ignored silently. |
| `shouldRespond(inbound, state, now)` | Decides whether the agent speaks. Always true in a DM. Strict in a group, see section 4. |
| `planOutbound(parts, { group })` | Turns contract parts into an ordered list of send steps that respects the deliverability rules in section 5. |
| `needsTextNotice(message, space)` | True for a DM message that is only media, so the agent can say once that it only reads text. Always false in a group. |
| `takeBurst(queue)` and `mergeInbound(inbounds)` | Fold a burst of texts from one sender, such as "hey", "wait", "actually friday", into a single turn. The burst is the unbroken run at the head of the queue, so in a group nobody's later message overtakes someone else's earlier one. |

`readInbound` is an allowlist, not a denylist.
Only real user text gets through, so a content type a future SDK version adds is ignored by default instead of answered.
It returns null for outbound or echoed messages, read receipts, reactions and tapbacks, polls and votes, group events (rename, avatar, member changes, leave), and anything without usable text.
It also drops traffic no person typed: messages the provider flags as system, service, spam, corrupt or auto-reply (https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/message-metadata).
An auto-reply in particular would ping-pong with the agent forever.
It unwraps an inline reply to its inner text, because a threaded reply arrives as content type `reply`, not `text` (https://photon.codes/docs/spectrum-ts/messages, Content table).
It takes the text item out of a grouped text-plus-attachment message, because a photo sent with a caption arrives as content type `group` whose items are messages (same page).
It clamps text to 2000 characters, the limit in `docs/contract.md`, and never cuts an emoji in half.
It treats text made only of invisible characters as empty: the attachment placeholder U+FFFC that a sticker leaves behind, and zero-width marks.
It drops the text form of a tapback, such as `Liked "Want me to book it?"`, which is how a reaction from a green-bubble member arrives.

## 2. Setup, step by step

### Step 1: get the two credentials

Only two values are needed: the project id and the project secret.
Both are on the project's Settings page at https://app.photon.codes (https://photon.codes/docs/spectrum-ts/getting-started).
No phone number, line or token goes into our config.
With `imessage.config()` and no arguments the SDK discovers every cloud line the project owns and renews their tokens by itself (https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).

Put them in `.env`, which is git-ignored:

```
SPECTRUM_PROJECT_ID=...
SPECTRUM_PROJECT_SECRET=...
```

The secret is a password.
Never commit it, never paste it into a chat or a log, and never print it from code.
If it leaks, rotate it with `photon projects regenerate-secret <project-id>` (https://photon.codes/docs/cli/projects), update `.env`, and restart.

### Step 2: add every tester to the Users allowlist (Free and Pro plans)

On the Free and Pro plans the project sends through a shared pool of lines.
A shared line will only message recipients that are registered as Users of the project.
Any other target is rejected with this exact error:

```
Target not allowed for this project
```

Source: https://photon.codes/docs/spectrum-ts/troubleshooting/imessage, section "Target not allowed for this project".

To add a tester:

1. Open https://app.photon.codes and select the project.
2. Open the **Users** tab.
3. Add a user with the phone number or email that tester's iMessage is linked to.

The CLI does the same thing with `photon spectrum users add`, and `photon spectrum users ls` lists who is on it (https://photon.codes/docs/cli/spectrum).
The CLI installs with `npm install -g @photon-ai/cli` and signs in with `photon login` (https://photon.codes/docs/cli/installation, https://photon.codes/docs/cli/authentication).

The Business plan uses a dedicated line and is not subject to the allowlist (same troubleshooting page).

The pricing page lists a cap of about 10 users on Free and about 100 on Pro (https://photon.codes/pricing).
Those numbers were read through a summarising fetch, so check them in the dashboard before relying on them.

### Step 3: find the handle Apple really sends from

The handle on the allowlist has to be the one Apple actually sends from, and that is not always the phone number.
Apple sometimes registers iMessage under an Apple Account email, and then the user you added never matches the inbound sender.

1. On the tester's iPhone, open https://debug.photon.codes.
   It opens an iMessage to Photon's debug bot.
2. Send the message.
   The bot replies with the exact handle, phone number or email, that Apple is sending from for that device.
3. Add that exact handle under Users.

If the bot reports an email and you want the number instead, open Settings, then Messages, then Send & Receive on the iPhone, and pick the phone number under "Start new conversations from".
Source for all of this: https://photon.codes/docs/spectrum-ts/troubleshooting/imessage.

Do this for every person who will be in a test group, not only for yourself.
Whether the allowlist is applied to each member of a group is unknown, so assume it is.

### Step 4: find the number to text

The channel is inbound-first: people text the agent, the agent never texts first.
So every tester needs the agent's number.

- CLI: `photon spectrum lines ls` lists the phone lines assigned to the project (https://photon.codes/docs/cli/spectrum).
  It needs an active project: set `PHOTON_PROJECT_ID` or pass `--project <id>`.
- Dashboard: the project's lines are managed at https://app.photon.codes, next to Users (https://photon.codes/docs/spectrum-ts/introduction).

Photon's docs do not show this screen, so the exact place the number appears on a shared-pool plan is unknown until you look at your own dashboard.
On Free and Pro the docs say each end user is routed through a number from the pool, and that number "may differ across recipients" (https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing, section "Line model").
On Business everyone texts the same dedicated number.
If neither the dashboard nor the CLI shows a number for a shared-pool project, ask Photon at help@photon.codes.

### Step 5: start, and restart after any line change

```bash
npm install
npm start
```

A healthy start prints a line like `iMessage:    connected to Spectrum project "<name>"`.
With either variable empty it prints `iMessage:    off (...)` and the agent runs over HTTP only.

Restart the agent after adding a line to the project.
The SDK learns about lines from the credentials it mints, so a line provisioned while the process is running is only picked up at the next token renewal.
Until then, messages sent to the new line "are not delayed, they are not delivered to your app at all" (https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing, section "When line changes reach a running app").

Adding a user to the allowlist is a server-side change and the docs do not ask for a restart for it.

Stopping: `Spectrum()` installs its own SIGINT and SIGTERM handlers, which stop the streams within about 3 seconds and then exit the process (https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle).
So Ctrl-C ends the whole agent, HTTP door included, which is what we want.

## 3. Plans, and what they mean for the group chat goal

Numbers in this table come from https://photon.codes/pricing through a summarising fetch.
Treat them as approximate and confirm in the dashboard.

| plan | price | line | users | group messaging |
| --- | --- | --- | --- | --- |
| Free | $0 | Shared pool | about 10 | "Limited" |
| Pro | about $25 a month | Shared pool | about 100 | "Limited" |
| Business | about $250 per line a month | One dedicated number owned by the project | unlimited | "Full group messaging" |
| Enterprise | custom | custom | custom | custom |

### Shared pool versus dedicated line

Source: https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing, section "Line model".

- **Shared pool (Free, Pro).**
  Each end user is routed through a number from a pool, so the number may differ across recipients.
  Sends only reach people on the Users allowlist.
- **Dedicated (Business).**
  Everyone texts one number that belongs to the project.
  No allowlist.
- DM delivery is identical on both.

### What "Limited" group messaging means

This is what Photon documents, and nothing more:

- A shared-pool line cannot create a group chat.
  `space.create()` with several users throws `UnsupportedError` (same routing page, section "Creating conversations").
- A shared-pool line does not subscribe to the group-event stream.
  Adding or removing a member, leaving, renaming the chat and changing its avatar never appear on `app.messages` (same page, Warning box, and https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/inbound-group-events).
- So on a shared line the agent cannot know it was added to a group, and it cannot greet the group.
  It only finds out when someone addresses it.
- `space.get(chatGuid)` can still reference an existing group in shared mode (same routing page).
- Read receipts arrive on both line types, and group read receipts are best-effort (https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/inbound-read-receipts).

None of this blocks our design.
The agent never creates groups, never needs group events, and `readInbound` ignores them when they do arrive.

One more consequence of a shared line: the SDK reports the line's own number as the literal string `shared` (SDK source, `@spectrum-ts/imessage/dist/index.js`).
An @mention of the agent cannot be matched against its own number there.
That is why addressing the agent by name is the primary trigger in a group, see section 4.

### What is unknown until tested live

1. Can a person add the agent's shared-pool number to a group chat they create at all?
2. If yes, do ordinary group messages reach `app.messages` on a shared line?
   The SDK subscribes to all message events in shared mode, but the server side is not documented.
3. Can the agent send a reply into that group from a shared line?
4. Is the Users allowlist applied to every member of the group, or only to the person speaking?
5. Which number does each member see, given that the pool number "may differ across recipients"?
   If two members are routed through different pool numbers, it is unclear which number they would add to one group.
6. Does `message.mentions` get filled in when the agent is only a phone number and not a saved contact?

If the answer to 1, 2 or 3 is no, the group chat goal needs a Business dedicated line.

### The exact live test to find out

Run this once, with two phones, before promising anyone a group demo.

1. Add both testers' real handles to Users, using https://debug.photon.codes for each phone.
2. Start the agent with debug logging: `LOG_LEVEL=debug npm start`.
   `LOG_LEVEL` is the SDK's own switch (https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle).
3. From each phone, send the agent a DM first and wait for the reply.
   Note the number each phone is talking to.
   This settles unknown 5.
4. On phone A, create a **new** group chat containing phone B and the agent's number.
   A DM cannot be converted into a group, so it has to be a new chat.
   If Messages refuses to create it, unknown 1 is answered: no.
5. From phone A, send `plec, are you there?` into the group.
6. Watch the agent's log.
   An inbound line for a group chat means unknown 2 is answered: yes.
   No line at all within a minute means group messages do not reach a shared line.
7. Watch the group on both phones.
   A reply bubble means unknown 3 is answered: yes.
   A `Target not allowed for this project` error in the log means the allowlist is applied to a member who is missing from Users, which answers unknown 4.
8. Remove phone B's handle from Users in the dashboard, then send `plec, hello` from phone B and see whether the reply still lands.
   That settles unknown 4 the other way.
   Add the handle back afterwards.
9. From phone A, type `@` and try to pick the agent from the mention list, then send.
   Check whether the debug log shows a `mentions` entry.
   That settles unknown 6.

| result | what it means |
| --- | --- |
| Steps 4 to 7 all work | Groups work on the current plan. Carry on with the group checklist in section 6. |
| Group cannot be created, or no inbound line in step 6 | The shared pool does not carry groups. A Business dedicated line is required for the group goal. |
| Inbound arrives but the reply fails with `Target not allowed for this project` | Add every group member to Users and repeat. |
| Inbound arrives, reply fails with another error | Send the project id, the exact error and both handles to help@photon.codes (https://photon.codes/docs/spectrum-ts/troubleshooting/imessage, "Still stuck?"). |

## 4. Group chat behaviour, as designed

A group of friends planning a party talk to each other far more than they talk to the agent.
The design goal is an agent that behaves like a polite person in the chat: it speaks when spoken to, and it never acts on one person's booking because another person said "ok".

### When the agent speaks

In a DM it always answers.

In a group, `shouldRespond` answers only when one of these holds:

1. The message addresses it by name: `plec` or `concierge` as a whole word, in any case.
   `Plec, anything for 40 in Philly?` counts.
   `complected` does not.
   The name inside a link, an email address, a bare domain or a quoted bubble does not count either.
   Every payment link the agent sends is on `api.plec.ai`, so a member pasting that link to a friend must not wake the agent.
2. The message @mentions the agent.
3. The message is an inline reply to one of the agent's own bubbles.
4. The same sender has an open question from the agent that is under 10 minutes old.
   This is what lets Ana answer `yes` or `40 people` without repeating the agent's name every time.
   It reads `session.state.awaiting[senderId]`.

When none of them holds, the agent does nothing at all.
It shows no typing bubble, does not mark the chat read, does not run a turn, and does not touch the session.
Marking read matters because on iMessage it is chat-level: it marks every unread message in the chat as read (https://photon.codes/docs/spectrum-ts/content/read).

### How to address it

- Start or end the message with its name: `plec, is The Foundry free on Oct 10?`
- Or long-press one of its bubbles and choose Reply.
- After it asks you something, just answer within 10 minutes.
  No name needed.
- @mentions work only where the SDK can tell the mention points at the agent.
  On a shared line it cannot, so use the name.

### What it ignores

Silently, with no reply of any kind:

- its own messages and echoes,
- read receipts,
- reactions and tapbacks, including the text form a green-bubble member's tapback arrives in,
- stickers and other messages whose text is only invisible characters,
- polls and poll votes,
- group events: rename, avatar change, member added or removed, someone leaving,
- system messages, spam and auto-replies,
- in a group, photos, voice notes, contacts and anything else without usable text,
- group chatter that does not address it.

The one exception is a DM that is only media: a photo, a voice note or a contact card with no words.
That gets one honest line saying the agent only reads text.
In a group the same message is just friends sharing photos, so the agent stays out of it.

A photo sent together with a caption is read as the caption.
A threaded reply is read as the text inside it.

Read receipts get special mention because Photon warns about them.
They arrive as ordinary inbound messages with content type `read`, one per reader per message, and "a `default:` arm that replies to the user will reply to every receipt" (https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/inbound-read-receipts).
An agent that replied to a receipt would cause a new receipt, and loop.
The allowlist in `readInbound` is what prevents that, and section 6 has the live check for it.

### How consent is bound to the requester

On HTTP there is no sender, so a conversation has one speaker and consent works as described in the README.
On iMessage every turn carries the speaker's handle, and the code gates in `agent/guards.js` use it.
`checkWrite` decides whether a write may run, and it is a pure function, tested in `tests/unit.js` and `tests/identity.unit.js`.

- A quote remembers everyone who asked for it.
  Only they can turn it into a booking.
  When someone else tries, the write is refused with `requester_confirmation_required` and the agent says, in its own voice, that it needs to hear it from the person who asked.
  A member who asks "how much was that again" becomes a requester too and does not take the quote away from the person who asked first.
  They can book it for themselves, under details they typed, and never under someone else's.
- Consent to book is a clear yes: an affirmative statement with no hold-off in the same message.
  The wording rules live in `agent/consent.js`.
  "ok wait dont book yet", "not sure", "yes if it is refundable", "Ana said yes" and "is that ok?" are not a yes.
  "yes, no rush" and "sí, no te preocupes" are.
  The curly apostrophe iOS types reads the same as a straight one, so "don’t book it" is a no.
- Once the requester saw the total in an earlier turn, a message from them that asks for the booking ("book it", "lock it in", "can you book it?") also counts.
  Any other later message, such as "lol", "where are we eating" or a name and an email with no yes, is just chat and books nothing.
- The guest name and email must have been typed by the requester.
  What other members typed does not count, and the agent never borrows details from someone else in the chat.
- Cancel and reschedule need two things from the same speaker: they brought the booking up themselves in an earlier turn, and their current message is a clear yes.
  When confirming a cancellation, saying it back ("yes, cancel that") or giving the reason ("yes, we don't need it anymore") is still a yes, and "I don't want it cancelled" is a no.
- A booking made in this chat can only be cancelled or moved by the person who booked it.
  The reply that announced it showed the reference to the whole group, so knowing the reference proves nothing.
  Another member who types the reference and then says yes is refused with `requester_confirmation_required`.
- Any other booking answers to whoever brought it up last, by typing its reference or by a lookup in their turn, because that is the person the agent's "want me to cancel it?" was put to.
  An earlier lookup by someone else does not let their bare yes stand in.
- A lone thumbs-up emoji typed as a message counts as a yes in a DM and never in a group.
- A group message with no identifiable sender can never confirm a write.
  It is refused with `sender_unknown`.
- A tapback is never consent.
  Native tapbacks are ignored before they reach the brain.
  From a green-bubble member a tapback arrives as text, such as `Liked "Want me to book it?"`, and the gates treat that form, and anything inside quotes, as not the speaker's own words.
- A write never starts with less than 6 seconds of the turn left, so running out of time happens before a write and never during one.

The SDK gives no display name for a sender, only the handle (SDK source).
The agent learns names the normal way, by asking.

### Booking access rules on iMessage

Every conversation shares one sandbox team key, and booking references are sequential.
Over HTTP that openness is required: the evaluator looks bookings up by reference in fresh sessions.
On a public phone number it would let a stranger read or cancel someone else's booking by guessing BK-1001, so the rule is channel-aware.
It is `checkBookingAccess` in `agent/guards.js`.

On iMessage, in DMs and groups alike:

- "Show my bookings" is always filtered by an email this speaker typed.
  With no email yet, the lookup is refused with `email_required` and the agent asks which email they booked with.
  The unfiltered list never runs.
- Looking up a reference, resending its payment link, cancelling it and rescheduling it open only when this conversation created that booking, or when the booking's guest email matches an email this speaker typed.
- A refusal is the same `not_found` answer whether or not the booking exists, so references cannot be probed.

On HTTP, with no sender and no channel, none of these rules apply and behaviour is unchanged.

Two things to keep in mind:

- "This conversation created it" lives in the in-memory session.
  After a restart or an idle expiry, the email match is the only way back to a booking, which is why the agent asks for it.
- Inside one group, a booking made in that group can be looked up by any member, because the reference was shown to everyone.
  Only the person who booked it can cancel or move it.
  After a restart the group no longer remembers who that was, and the email match above takes over.

## 5. Deliverability rules we follow

Apple cannot read iMessage content, so it filters on behaviour: bursts, broadcasts and cold outreach get a line flagged (https://photon.codes/docs/best-practices/imessage-deliverability).
`planOutbound` is where our side of that is enforced.

| rule | why |
| --- | --- |
| Inbound-first. The agent only ever replies. | Inbound-first integrations never surface the "Report Junk" banner (deliverability page, "Inbound-first is the decision that matters"). |
| Text goes first in every reply, in one bubble, then gallery photos, then cards, then any link. | The words carry the answer. Photon also says not to put links or media in the first message of a conversation, because Apple suppresses link-clicking until a reply lands (deliverability page, "Don't"). |
| At most 3 cards in a group and 4 in a DM. | "Pace messages naturally. Don't fire several within seconds" (deliverability page, "Do"). The text part already names the options. |
| One photo per card, with the caption in the same send step. | A photo and its caption travel as one grouped message, at most one text item per group (https://photon.codes/docs/spectrum-ts/content/groups, and SDK source). Half the bubbles. |
| Image parts become photo steps, under the same cap as cards. A caption that repeats the one before it is sent once. | Same path as card photos, so they share the same fallback, and the listing name is not repeated on every picture. |
| A link whose URL is already in the text is dropped. | `agent/parts.js` guarantees the payment URL is in the text, so a second bubble would repeat it. |
| Any other link is sent as plain text, `label: url`. | A rich link carries only the URL, so the label would be lost (https://photon.codes/docs/spectrum-ts/content/rich-links). |
| Payment URLs are never sent as a rich link. | A rich link asks the sending side to unfurl the URL (same page). Whether Photon's line fetches the URL before the user taps is not documented, so we assume a machine would. The agent must never open a Checkout page, and plain text makes the question moot. |
| Photos are sent with an explicit MIME type. | `attachment()` infers the type from the file extension and throws without one, and the sandbox photo URLs have no extension (https://photon.codes/docs/spectrum-ts/content/attachments, and SDK source). A photo that still fails degrades to its caption as text. |

### Quotas

- 5,000 messages per server per day, counting every send.
  Past that, sends are rejected until the window resets.
- 50 new conversations initiated per line per day.
  Replies inside an existing conversation do not count, and we only reply.
- Source for both: https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing, section "Quotas".
- The Spectrum HTTP API allows 5 requests per second per project and answers 429 after that (https://photon.codes/docs/api-reference/rate-limit).
  Whether that limit also applies to sends over the gRPC line connection is not stated.
- The pricing page mentions a small daily message allowance on the Free plan.
  That came through a summarising fetch, so check the dashboard before a demo (https://photon.codes/pricing).
- The patterns that get a line flagged are burst sending of 100 or more a minute, broadcasting without exchange, more than 2 to 3 follow-ups to someone who does not answer, cold outreach, and off-hours sends (deliverability page).
  A reply-only agent with capped bubbles stays clear of all five.

A worst-case DM reply is one text bubble, four photo cards and one plain text link, so six sends.
A full day of demos is far below 5,000.

## 6. Live test checklist

Never run these against someone who has not agreed to be texted.
Run the DM list first, then the plan test in section 3, then the group list.

### Before you start

- [ ] Both `SPECTRUM_` variables are set in `.env`, and the values appear in no log, screenshot or commit.
- [ ] Every tester's handle, as reported by https://debug.photon.codes, is under Users.
- [ ] The agent was restarted after the last line change.
- [ ] The start log says `connected to Spectrum project`.
- [ ] `npm run test:unit` passes, so the policy rules are what this page says they are.
- [ ] The HTTP door still answers: `curl -s localhost:8787/health`.

### DM

- [ ] Text `hi! i need a venue`.
      One text bubble comes back, and it ends with a question.
- [ ] Text `a birthday in Philadelphia for 40 people`.
      Text first, then at most 4 photo cards, each photo with its caption in the same bubble group.
- [ ] Photos actually render.
      If only captions arrive, see troubleshooting.
- [ ] Ask for a quote.
      The total matches the sandbox to the cent.
- [ ] Give a name and email, then say `yes`.
      One booking, a `BK-` reference, and the payment URL as plain text, exactly once, with no link preview bubble after it.
- [ ] Long-press an agent bubble, choose Reply, and type a question.
      The agent reads the inner text and answers it.
- [ ] Send a photo with a caption that asks something.
      The agent answers the caption.
- [ ] Send a photo alone.
      One short line comes back saying it only reads text.
- [ ] Add a tapback to one of its bubbles.
      No reply.
- [ ] Send `hey`, `wait`, `actually make it friday` a second apart.
      They are answered as one turn or in order, never overlapping, and none is lost.
- [ ] Ask `show my bookings` from a phone that has not given an email.
      The agent asks for the email and lists nothing.
- [ ] Ask about `BK-1001` from a phone that did not make it.
      The agent does not reveal it.
- [ ] Over HTTP, in a fresh session, ask about `BK-1001`.
      It still answers, because the evaluator depends on that.

### The read-receipt loop check

This is the one that can run up the quota while you are not looking, so do it on purpose.

1. On the test iPhone, turn on Settings, then Messages, then Send Read Receipts.
   It is off by default, and Apple gates the whole signal on it (https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/inbound-read-receipts).
2. Start the agent with `LOG_LEVEL=debug IMESSAGE_DEBUG=1 npm start`.
   The SDK logs every receipt under `spectrum.imessage.read` (same page).
3. Keep that log.
   With `IMESSAGE_DEBUG=1`, `agent/imessage.js` writes one line for every event it drops, such as `dropped inbound read`.
   The line names the direction and the content type and never the message text.
4. Text the agent, let it answer with several bubbles, leave the chat, then open it again so the bubbles are marked read.
5. Confirm in the log that content type `read` arrived.
   If none arrived, the test proved nothing: check the setting in step 1.
6. Confirm **zero** replies to receipts: no typing bubble, no new agent bubble, no model turn in the log after a `read`.
7. Leave the chat open for two minutes and confirm the log is quiet.
8. Repeat steps 4 to 7 in the group.
   A group emits one receipt per reader per message, and group receipts are best-effort, so seeing fewer than expected is normal.

### The offline restart replay question

Photon's docs say events that arrive while the app is down "are replayed on reconnect" (read receipts page and group events page).
SDK 12.8.0 keeps its resume cursor in memory only, so a fresh process appears to start from now, with no replay (SDK source, `@spectrum-ts/core/dist/authoring.js`).
Find out which one is true for our project:

1. Stop the agent.
2. From the test phone, text `plec, are you there?`.
3. Wait one minute, then start the agent.
4. Watch the log for five minutes.

| result | what to do |
| --- | --- |
| Nothing arrives | No replay. Messages sent during downtime are lost, so do not restart mid-demo, and ask people to resend after a restart. |
| The message arrives late and is answered once | Replay exists. Check the answer still makes sense hours later, and consider a "sorry for the delay" guard for very old messages. |
| The message is answered twice | Report it. The in-process dedupe is not covering replays. |

### Group

Only after the plan test in section 3 passed.

- [ ] Two people chat with each other for ten messages without naming the agent.
      The agent stays silent, shows no typing bubble, and the chat is not marked read by it.
- [ ] `plec, anything in Philly for 40?` gets a reply with at most 3 cards.
- [ ] `Concierge` with a capital C works too.
- [ ] A word that only contains the name, such as `complected`, does not wake it.
- [ ] A Reply to one of its bubbles wakes it with no name.
- [ ] Ana asks for a quote by name.
      The agent asks Ana a question.
      Ana answers `40` with no name within 10 minutes, and the agent picks it up.
- [ ] Ben sends `sounds good see you at 8` right after Ana's quote.
      Nothing is booked and the agent stays silent.
- [ ] Ben sends `plec yes book it`.
      Nothing is booked, and the agent says it needs to hear it from Ana.
- [ ] Ana sends `yes`.
      Exactly one booking is created.
- [ ] Ana sends `plec, cancel BK-....`, the agent asks her to confirm, and Ben answers `plec yes`.
      The booking is untouched, because it is Ana's booking.
- [ ] Ben sends `plec cancel BK-....` himself, and then `yes`.
      The booking is still untouched, and the agent says it needs to hear it from Ana.
- [ ] Ben pastes the payment link into the chat with no name.
      The agent stays silent, even though the link contains `plec`.
- [ ] Ana sends `yes`.
      It is cancelled, and the refund matches the sandbox.
- [ ] From a different chat, a phone that never gave the booking's email asks about that `BK-` reference.
      The agent says it cannot find it and reveals nothing.
- [ ] Someone renames the group, someone adds a tapback, someone votes in a poll, someone shares a photo with no words.
      No reply to any of them.
- [ ] Eleven minutes after an open question, Ana's bare `yes` is ignored until she names the agent again.
- [ ] The payment URL arrives once, as plain text, with no preview card.
- [ ] Check the sandbox with `GET /bookings`: the rows match what the chat says, and nothing extra exists.

## 7. Troubleshooting

| symptom | likely cause | fix |
| --- | --- | --- |
| Start log says `iMessage:    off` | One or both `SPECTRUM_` variables are empty. | Fill both in `.env` and restart. |
| Start log says it could not connect to Spectrum | Wrong id or secret, a rotated secret, no network, or a runtime without Node gRPC. | Copy both values again from Project Settings. Run on Node 20 or newer, not an edge runtime (https://photon.codes/docs/spectrum-ts/troubleshooting/imessage). |
| Log shows `Target not allowed for this project` | Shared-pool plan, and the recipient is not under Users. | Add the handle under Users, section 2 step 2. |
| Same error after adding yourself | The handle you added is not the one Apple sends from. | Use https://debug.photon.codes and add the handle it reports, section 2 step 3. |
| The debug bot reports an email | The iPhone starts conversations from the Apple Account email. | Add the email as the user, or switch "Start new conversations from" to the number (same troubleshooting page). |
| You text the number and no inbound line appears | The line was added after the agent started, or the agent was down when you sent it, or you are texting the wrong pool number. | Restart, resend, and confirm the number with `photon spectrum lines ls`. |
| Messages sent while the agent was down are never answered | SDK 12.8.0 does not replay across a process restart, as far as we can tell. | Resend. Run the restart replay test in section 6 to confirm. |
| Silent in a group | Nobody addressed it, or the open question is older than 10 minutes. | Say `plec` or `concierge`, or Reply to one of its bubbles. |
| Silent in a group even when named, fine in DMs | Group messages may not reach a shared-pool line, or a member is missing from Users. | Run the plan test in section 3. |
| It answers people who were not talking to it | `shouldRespond` is letting chatter through. | Capture the message text and run it through the unit tests. This is a bug, not a setting. |
| It replies to tapbacks, receipts or renames | `readInbound` let a non-text type through. | Log the content type, add a fixture to the policy unit tests, fix the allowlist. Stop the agent first if it is looping. |
| It says it needs to hear it from someone else | Someone other than the requester confirmed. | Working as designed. The requester says yes. |
| "Which email did you book with?" on every booking question | iMessage never lists bookings without an email this sender typed. | Working as designed. Give the email. |
| It forgot the quote or who you are | The agent restarted, or the session expired. Sessions are in memory. | Ask again. Nothing was booked: the gates refuse a yes with no quote behind it. |
| Captions arrive but no photos | The photo URL has no file extension and no MIME type was passed, or the download took over 10 seconds. | Check that photos are sent with an explicit MIME type (https://photon.codes/docs/spectrum-ts/content/attachments). |
| The payment link shows up twice, or as a preview card | `planOutbound` did not drop the duplicate link, or a rich link was used. | Bug. Payment URLs are plain text only, section 5. |
| Green bubbles | The thread fell back to SMS or RCS, where carriers apply their own filtering. | Expect tapbacks to arrive as text. Track it separately from iMessage health (https://photon.codes/docs/best-practices/imessage-deliverability, "SMS and RCS fallback"). |
| The text the agent received differs from what the sender typed | Apple delivered different text, usually after very fast typing. It happens upstream of Photon. | Update iOS, pause before Send (https://photon.codes/docs/spectrum-ts/troubleshooting/imessage). |
| Sends start failing late in the day | The 5,000 a day server quota, or a Free plan allowance. | Wait for the reset, or ask help@photon.codes for an increase (routing page, "Quotas"). |
| The dashboard shows the line as Flagged | Apple's behavioural filter. | Review what the agent sent in the hour before, then email help@photon.codes with the project id and the line (deliverability page, "Getting help"). |
| Ctrl-C exits at once, without our own shutdown log | `Spectrum()` installs its own signal handlers with a 3 second budget. | Expected (https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle). |
| Still stuck | | Send Photon the project id from `photon projects show`, the exact error string, the target handle, and the handle the debug line reports. Never send the secret. help@photon.codes. |
