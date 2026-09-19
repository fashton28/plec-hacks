# The agent contract

Your agent is an HTTP server. PLEC's chat page, the test runner, and the staff
evaluator all talk to it the same way. Any language works: the shapes below are
the whole contract.

```
POST {agentUrl}/agent/messages
  body:  { "sessionId": string, "text": string }
  reply: { "parts": Part[] }

POST {agentUrl}/agent/reset          (optional)
  body:  { "sessionId": string }
  reply: { "ok": true }
```

`{agentUrl}` is the base you submit on the dashboard, for example
`https://quiet-otter.trycloudflare.com`. The evaluator appends
`/agent/messages` itself. If you paste a URL that already ends in
`/agent/messages` it is trimmed.

## POST /agent/messages

One user turn in, one reply out.

Request:

```json
{
  "sessionId": "3f1c9d2e-7b4a-4c1e-9a7d-2f5e8b6c1d0a",
  "text": "How many people can The Foundry at Fishtown hold?"
}
```

Reply:

```json
{
  "parts": [
    { "kind": "text", "text": "The Foundry at Fishtown holds 40 to 150 guests." }
  ]
}
```

Rules:

- Reply within 45 seconds. The evaluator gives up at 45s and the turn counts as
  unanswered. The template server cuts a turn at 40s so you see the failure.
- Always include at least one `text` part.
- `sessionId` is an opaque string chosen by the caller. The chat page and the
  evaluator send UUIDs. A sessionId you have never seen is a new conversation.
  A sessionId you have seen continues that conversation: remember what was
  said.
- `text` is plain text, up to 2000 characters. It can be any language, or
  nonsense.
- Answer `200` with JSON on success. Any other status, a non-JSON body, or a
  body without a `parts` array counts as a failed turn.
- Errors should be JSON too: `{ "error": "some_code", "message": "..." }`.
- Redirects are not followed. Submit the exact `https://` URL your tunnel
  prints.
- CORS is not required by the evaluator (it calls you server side). The chat
  page needs it only when it is served from a different origin than the agent;
  the template server enables it for everything.
- Parts that do not match a shape below are dropped silently. A `card` without
  a `photoUrls` array is not a card.

## POST /agent/reset

Optional. Forget everything about a session. The chat page calls it when the
user presses "Start over". A new sessionId works just as well, so a server
without this route is still valid.

Request:

```json
{ "sessionId": "3f1c9d2e-7b4a-4c1e-9a7d-2f5e8b6c1d0a" }
```

Reply:

```json
{ "ok": true }
```

## Parts

`Part` is a tagged union on `kind`. These are the same shapes PLEC's own agent
sends to its web, iMessage, and admin channels.

### text

Plain text. Newlines are kept. No markdown rendering: write sentences.

```json
{ "kind": "text", "text": "The Rooftop at Rittenhouse is not available on October 17. Would October 18 work?" }
```

### card

A listing preview: photo, title, optional subtitle, optional link. Send one per
listing you are recommending. The `title` must be the listing's exact `name`
from the sandbox: the checks match cards to listings by title.

```json
{
  "kind": "card",
  "title": "The Foundry at Fishtown",
  "subtitle": "Loft in Fishtown, 40 to 150 guests, $300/hour with a 4 hour minimum",
  "photoUrls": [
    "https://picsum.photos/seed/foundry-fishtown-1/800/500",
    "https://picsum.photos/seed/foundry-fishtown-2/800/500",
    "https://picsum.photos/seed/foundry-fishtown-3/800/500"
  ],
  "url": "https://www.google.com/maps/search/?api=1&query=1400%20N%20Front%20St%2C%20Philadelphia%2C%20PA%2019122"
}
```

`photoUrls` may be empty, but it must be an array. `url` is optional.

### link

A button-like link.

```json
{ "kind": "link", "label": "Open in Google Maps", "url": "https://www.google.com/maps/search/?api=1&query=1400%20N%20Front%20St" }
```

### image

One photo the user asked to see, with an optional caption. Send several image
parts for several photos.

```json
{ "kind": "image", "url": "https://picsum.photos/seed/foundry-fishtown-2/800/500", "caption": "The mezzanine at The Foundry" }
```

## A full example

Request:

```json
{ "sessionId": "3f1c9d2e-7b4a-4c1e-9a7d-2f5e8b6c1d0a", "text": "Venues in Philadelphia for 40 people on October 10, evening" }
```

Reply:

```json
{
  "parts": [
    { "kind": "text", "text": "Three that fit 40 guests on October 10:" },
    { "kind": "card", "title": "The Foundry at Fishtown", "subtitle": "Loft, 40 to 150 guests, $300/hour", "photoUrls": ["https://picsum.photos/seed/foundry-fishtown-1/800/500"] },
    { "kind": "card", "title": "Schuylkill Boathouse", "subtitle": "Waterfront hall, 30 to 120 guests, $350/hour", "photoUrls": ["https://picsum.photos/seed/schuylkill-boathouse-1/800/500"] },
    { "kind": "card", "title": "Fishtown Brewery Hall", "subtitle": "Brewery, 40 to 180 guests, $320/hour", "photoUrls": ["https://picsum.photos/seed/fishtown-brewery-hall-1/800/500"] },
    { "kind": "text", "text": "Want a price for one of these? Tell me the start and end time." }
  ]
}
```

## Try it with curl

```bash
curl -s http://localhost:8787/agent/messages \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-session-0001","text":"hi"}'
```

```bash
curl -s http://localhost:8787/agent/reset \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test-session-0001"}'
```

## How staff call your agent

After submissions close, the organizers run the hidden scenarios from the admin
dashboard. The dashboard calls a PLEC server, and that server calls your agent
URL one turn at a time with a fresh sessionId per scenario, a 45 second
timeout, and no authentication. It resolves your hostname first and refuses
anything private (localhost, 10.x, 192.168.x, and so on), so the URL must be a
public tunnel. After every turn it reads your team's sandbox bookings, which is
how the checks know whether you booked, cancelled, or moved something.
