# Demo video script

Target length: two and a half minutes.
One take per scene is fine, and the scenes can be recorded separately and cut together.
Every line to type below was run against the live agent on September 19, 2026, and produced the result described.

The story in one sentence: you text PLEC like a friend, it plans and books a whole event with exact prices, it never acts without a yes, and it hands you the calendar invite, a real Spotify playlist and an invitation page your guests can answer.

## Before you record

1. The agent and the tunnel are running.
   Check with `curl -s https://imaging-sir-everywhere-favour.trycloudflare.com/health`, which should print `{"ok":true}`.
2. Start from a clean sandbox so the first booking is `BK-1001`:

   ```bash
   node --input-type=module -e "const {loadDotEnv}=await import('./agent/env.js');loadDotEnv('.env');const {plec}=await import('./agent/plec.js');console.log(await plec.reset())"
   ```

3. Open the web chat at the tunnel address and press "Start over".
4. Open a second browser tab on `/stage.html` for the big-screen shot.
5. Have your phone ready with the iMessage thread open, and delete the old messages so the thread looks fresh.
6. Do one throwaway run of scene 2 first.
   It warms the photo cache and shows you the pacing, then reset the sandbox again.
7. Record at a window width of about 1440 pixels so the chat and the live panels both fit.
8. Close anything that shows keys: the `.env` file, the terminal with the tunnel is fine.

## Scene 1: the hook (10 seconds)

**Show:** the front page, empty, cursor in the composer.

**Say:** "Planning an event means ten tabs, five vendors and a group chat that never decides.
This is PLEC.
You just text it."

## Scene 2: a whole event from one message (45 seconds)

**Type in the web chat:**

```
Plan my friend Maya's 30th for me: Philadelphia, October 10, 6pm to 11pm, 40 people, budget $6000. I need a venue, a DJ and a photographer. Disco vibes.
```

**Show:** the reply arriving in about five seconds, the three venue and vendor cards, and on the right the panels filling in: "An event in Philadelphia", 40 guests, the date.
Point at the "Behind the scenes" feed as the searches and quotes land.

**Say:** "One message.
PLEC searched the catalogue, quoted a venue, a DJ and a photographer for the same slot, and added it up: three thousand nine hundred sixty dollars, two thousand under budget.
Every number comes from the booking system, to the cent.
The model never does the math."

**Then point at:** the line where it asks for a name, an email and a yes.

**Say:** "And notice what it did not do.
It booked nothing.
PLEC never spends your money without a clear yes."

## Scene 3: one yes books everything (40 seconds)

**Type:**

```
I'm Sam Rivera, sam@example.com. Also invite ana@example.com. Yes, book it all.
```

**Show:** three booking references, three "Pay to confirm" buttons, then the lighter buttons: "Open the playlist on Spotify", "Open the invitation", "Add to Google Calendar".
On the right, the booking ticket appears with the venue photo and confetti.

**Say:** "One yes, three real bookings, each with its own payment link.
PLEC tells you straight that they are held, not confirmed, until they are paid, and it will never pay for you or claim that it did.
That rule is enforced in code, not just in the prompt."

**Click "Add to Google Calendar".**

**Show:** Google Calendar opening with "Maya's 30th", the right time, the venue address, and Sam and Ana already on the invite.

**Say:** "The calendar invite is filled in, with everyone's email already on it.
You press save, Google sends the invitations from your account."

## Scene 4: the playlist and the invitation (35 seconds)

**Click "Open the playlist on Spotify".**

**Show:** the real playlist in Spotify, scrolling a few tracks.

**Say:** "That is a real Spotify playlist, built for the vibe.
PLEC only adds tracks Spotify actually has, so there are no invented songs."

**Click "Open the invitation".**

**Show:** the invitation page: the venue photo with confetti, the date and place, the calendar buttons, the lineup, the embedded player.
Type a name in "Are you coming?" and press "I'm in".
The name appears in the guest list.

**Say:** "And this is what you send your friends.
A real invitation, with the map, the calendar buttons, the playlist, and RSVPs."

**Back in the chat, type:**

```
who's coming so far?
```

**Show:** the agent answering with the name you just entered.

## Scene 5: it lives in iMessage (25 seconds)

**Show:** your phone, screen recorded or filmed.

**Type in iMessage:**

```
yo plec, is the rooftop at rittenhouse free oct 17? 6 to 10, 40 ppl
```

**Show:** the typing bubble, then the reply that the date is blacked out and the offer to check October 16 or 18.

**Say:** "Same agent, in iMessage, talking like a person.
And when the answer is no, it says no.
That date is blacked out, so it tells you, and offers the next best move instead of booking something you did not ask for."

**Optional second beat, if there is time:** text `what about oct 16?` and show the venue photo card arriving.

## Scene 6: what is under the hood (20 seconds)

**Show:** the `/stage.html` tab while a message is being answered, the orb thinking, the feed rows landing: Heard, Checked, Quoted, Held back.

**Say:** "This is the same conversation from the agent's side.
Every lookup, every quote, and every time it held back and waited for a yes.
Booking, cancelling and rescheduling are gated in code: no quote, no real name and email, no clear yes, no booking.
In a group, only the person who asked can confirm."

## Closing (10 seconds)

**Show:** the front page again, or the invitation page.

**Say:** "PLEC.
From 'we should do something for Maya' to booked, invited and soundtracked, in one chat.
It asks first, quotes exactly, and tells the truth."

## If something goes wrong on camera

- **A reply is slow.** Cut, and re-record the scene. Typical replies take one to five seconds, and the package booking about twelve.
- **A venue in the package differs from the rehearsal.** That is fine. The catalogue is fixed but the model picks between valid options. Read the numbers off the screen rather than from this script.
- **The invitation or calendar link says it expired.** The agent was restarted since that link was made. Links live in memory. Make a new booking and use the fresh links.
- **iMessage does not answer.** Check `tail -f agent.log` for a line starting `[imessage`. If nothing arrives there, the message never reached us, which is on Photon's side.

## What not to demo

- **Group chats.** The logic is built and tested, but Photon's shared plan does not deliver group messages to us, so it cannot be shown live.
- **Paying.** The Checkout page is a sandbox stub. Showing the payment link is enough. Do not click through it on camera unless you want the booking to flip to confirmed, which is also a fair thing to show once.
