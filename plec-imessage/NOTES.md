# plec-imessage: coordination notes

Pitch: **"PLEC shouldn't be another app. It should be the friend in your group chat who actually books the party."**

Everything for this lives in `plec-imessage/`. Nothing outside it is touched.
Branch: `tony/imessage-agent`.

## Status
- [x] Phase 0: recon, branch
- [x] Phase 1: scaffold, state snapshot, simulator provider, CLI simulator, `/health`
- [ ] Phase 2: mock data + tools
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
