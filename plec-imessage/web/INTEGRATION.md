# Wiring the brain stage to the backend

The stage (`web/index.html`) already understands the backend's bus events
(`{ type, chatId, data, at }` from `src/bus.js`). The mock replays the same
shapes, so nothing needs translating. Two things are missing on the server:

1. **`GET /events`**: an SSE stream that relays every bus event.
2. **Serve `web/` statically** on the same port, so the page and `/events`
   share an origin.

Sketch for `src/index.js` inside `startApp()` (backend owner's call where it goes):

```js
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { openSse } from './server.js';
import { bus } from './bus.js';
import { ROOT } from './config.js';

router.get('/events', (req, res) => {
  const send = openSse(req, res, () => bus.off('event', send));
  bus.on('event', send);
});

const WEB = join(ROOT, 'web');
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', png: 'image/png', svg: 'image/svg+xml' };
for (const file of ['/', '/index.html', '/styles.css', '/app.js', '/demo.js']) {
  router.get(file, async (req, res) => {
    const path = normalize(join(WEB, file === '/' ? 'index.html' : file));
    res.writeHead(200, { 'Content-Type': `${TYPES[path.split('.').pop()]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(await readFile(path));
  });
}
```

Then open `http://localhost:8788/`. The page connects to `/events`, and the corner
label reads **LIVE**. If `/events` doesn't answer within 1.5s, it plays the mock.

## Events the stage uses

| type | data | shows up as |
|---|---|---|
| `inbound` | `{ fromName, text }` | "Latest in the chat" strip, people list |
| `agent_message` | `{ text }` | strip (PLEC), orb speaking |
| `typing` | `{}` | strip typing dots, orb speaking |
| `plan` | `{ plan: ChatPlan, changed }` | hero, chips, who's in, votes, "Learned"/"Vote" rows, insights |
| `decision` | `{ speak, reason, intent }` | "Stayed quiet"/"Spoke" rows, counters, orb thinking |
| `pending` | PendingAction or `null` | `create_booking` → confirm card; `modify_booking` → over-capacity card |
| `booking` | Booking | ticket, confetti, "Booked"/"Moved to" row |
| `calendar` | `{ bookingId, status, linksOnly, items, guestOfHonor }` (no emails) | Calendar card: mini timeline, Proposed/Sent/Updated pill, guest of honor "not invited 🤫" |
| `playlist` | `{ playlist: { name, url, status, fallback, songs: [{ title, artist, addedBy, durationMs }], vetoes } }` | Party playlist card (takes the Votes slot): cover, name, count + length, last 6 songs with who added them, "Vetoed" pills |
| `llm_call` | — | orb thinking pulse |
| `state_reset` | — | clears the stage |

Note: `executePending()` doesn't emit `pending: null` after it succeeds. The
stage clears the pending card itself when the `booking` event arrives.

## URL flags
- `?mock`: never try live. `?live`: try live even on port 5178.
- `?autoplay`: start the mock immediately. `?at=70`: jump to that mock event.
- Keys (mock): `Space` play/pause, `→` next event, `2` double speed, `R` reset.
