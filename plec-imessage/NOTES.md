# plec-imessage: coordination notes

Pitch: **"PLEC shouldn't be another app. It should be the friend in your group chat who actually books the party."**

Everything for this lives in `plec-imessage/`. Nothing outside it is touched.
Branch: `tony/imessage-agent`.

## Status
- [x] Phase 0: recon, branch
- [x] Phase 1: scaffold, state snapshot, simulator provider, CLI simulator, `/health`
- [x] Phase 2: mock data + tools (`npm run test:tools`, add `-- --sandbox` for live PLEC sandbox)
- [ ] Phase 3: the brain
- [ ] Phase 4: real iMessage provider
- [ ] Phase 5: /sim, /dashboard, screenshots, surprise guard
- [ ] Phase 6: handoff

## How to run
```bash
cd plec-imessage
cp .env.example .env        # fill LLM_API_KEY (plk_...) and PLEC_SANDBOX_KEY (hk_...)
npm run sim                 # terminal group chat (also serves http://localhost:8788)
```

## Assumptions
- **Language: plain JavaScript (ESM), Node 20+, zero dependencies.** The repo is already zero-dep JS, and the prompt says to match it. So there is no `tsconfig.json`, no `tsx`, no lockfile (nothing to lock). Types are JSDoc in `src/types.js`.
- **Model: PLEC's shared Kimi proxy** (OpenAI-compatible, `kimi-k2.6`), not the Anthropic SDK. Tony chose to keep the key the repo already has. `MODEL_SMART` and `MODEL_FAST` are env-configurable; any OpenAI-compatible endpoint works.
- **Model budget:** the proxy allows about 40 requests per 5 minute window, shared with the teammate. So plan extraction and the speak/stay-silent decision are **one** call (the extractor also returns a speak suggestion), confirmations run in server code with no model call, and the intro is templated.
- **Port 8788**, because the template agent (`agent/server.js`) uses 8787.
- `DEMO_TODAY=2026-09-19` pins "today" so the demo dates are stable.
- The organizer is `DEMO_ORGANIZER_PHONE`, else whoever says "I'm organizing / I'll book", else the first sender.

## Proposed shared changes
None so far.

## Integration interface (for the teammate)
- `GET /health` returns `{ ok, provider, venueSource }`
- `POST /sim/send` takes `{ chatId, from, fromName?, text, attachments?: [{url, mimeType}] }` and injects a group-chat message into the pipeline.

## Venue data: two sources (`VENUE_SOURCE`)
- `mock` (default, the demo path): `data/venues.json` has 15 invented Philadelphia venues. Demo-critical ones:
  - `kiln-loft-fishtown`: 50 standing, step-free, $1,650 for 4h, blocked Oct 17. The group's natural pick.
  - `brightwater-hall-nolibs`: 90 standing, 6 min away, open Oct 25, exactly +$300. The over-capacity fix.
  - `halcyon-rooftop-rittenhouse`: gorgeous, 22:00 curfew. Triggers the "you wanted to dance" warning.
  - `ironworks-loft-oldcity`: great loft, third-floor walk-up. Excluded for Priya's grandma.
  - `magnolia-garden-queenvillage` (covered pavilion) vs `wildflower-yard-kensington` (no cover, gravel).
  - `corner-room-southphilly` ($650) and `osteria-private-room-passyunk` ($850) are the budget picks.
- `sandbox`: the same tools against PLEC's hosted catalogue (`src/tools/sandboxClient.js`, copied from `agent/plec.js`). Bookings there are real sandbox bookings with a Checkout link: the agent sends the link and says it confirms on payment. It needs an organizer email, taken from chat or `ORGANIZER_EMAIL`. Accessibility is inferred from amenities and description text, otherwise "check with the venue".
- The mock pricing field is `includedHours` + `extraHour` (a generalization of the prompt's `perHourAfter4`).
