# The model proxy

PLEC lends its own Moonshot (Kimi) quota through an OpenAI-compatible proxy,
so no team has to buy a model key at the door. One key per team, minted on the
dashboard. It is shared infrastructure and it is capped, so it is sized for
building and testing rather than for an unbounded loop.

```
Base URL:  https://api.plec.ai/hackathon/llm/v1
Auth:      Authorization: Bearer plk_...     (or the header  x-api-key: plk_...)
Routes:    POST /chat/completions            GET /models
Models:    kimi-k2.6 (default), kimi-k2.7-code, kimi-k2.7-code-highspeed, kimi-k3
Window:    5 minutes, aligned to the clock (17:00:00, 17:05:00, 17:10:00, ...)
```

Those two routes are all there is. No streaming, no embeddings, no other
OpenAI paths.

## Your key

The "Your model key" card on https://plec.ai/hack/dashboard mints it. The key
belongs to the team, not to a person: both teammates use the same one.

- It is shown **exactly once**, at mint time. Copy it then and put it in
  `.env`. Afterwards the dashboard can only show a hint, `plk_...7Qf2`, which
  is enough to tell two keys apart and useless to anyone else.
- "Replace key" mints a new one and the old one stops working immediately.
  Update `.env` when you do it.
- Paste the whole thing: `plk_` plus 32 characters. A truncated paste comes
  back as `invalid_api_key`.
- Keys are issued while the challenge is released. Before release and after
  the event is over, the dashboard will not mint one.

Your prompts are not logged. The proxy records which team called, which model,
how many tokens the turn used and how long it took, and nothing else.

## Using it from agent/llm.js

Nothing in `agent/llm.js` changes. It already speaks this protocol. Set the
three lines in `.env`:

```bash
LLM_BASE_URL=https://api.plec.ai/hackathon/llm/v1
LLM_API_KEY=plk_your_key_here
LLM_MODEL=kimi-k2.6
```

`chatCompletion()` reads those at call time, POSTs to
`LLM_BASE_URL/chat/completions` with a bearer header, and hands back the same
shape it does for any provider. Tools, `tool_choice` and `temperature` pass
straight through. The response body is the provider's own, unmodified, so
`choices[0].message` and `usage` are where you expect them.

## curl

Set the two values once:

```bash
export LLM_KEY=plk_your_key_here
export PROXY=https://api.plec.ai/hackathon/llm/v1
```

One chat completion:

```bash
curl -s $PROXY/chat/completions \
  -H "Authorization: Bearer $LLM_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-k2.6",
    "messages": [
      { "role": "system", "content": "You are terse." },
      { "role": "user", "content": "A user says they need a venue. Ask one question back." }
    ],
    "temperature": 0
  }'
```

The models you may ask for:

```bash
curl -s $PROXY/models -H "Authorization: Bearer $LLM_KEY"
```

```json
{
  "object": "list",
  "data": [
    { "id": "kimi-k2.6", "object": "model", "owned_by": "moonshot", "default": true },
    { "id": "kimi-k2.7-code", "object": "model", "owned_by": "moonshot", "default": false },
    { "id": "kimi-k2.7-code-highspeed", "object": "model", "owned_by": "moonshot", "default": false },
    { "id": "kimi-k3", "object": "model", "owned_by": "moonshot", "default": false }
  ]
}
```

`GET /models` needs the key but does not count against your window.

## Models

Ask for one of these four:

```
kimi-k2.6                   the default, used when the body carries no "model"
kimi-k2.7-code
kimi-k2.7-code-highspeed
kimi-k3
```

Anything else is refused by name with `model_not_allowed`, before the call
goes anywhere, so a typo in `LLM_MODEL` fails loudly instead of quietly
costing someone money.

## No streaming

A body with `"stream": true` is refused with `streaming_unsupported`. Drop the
field. `agent/llm.js` never sends it, and the agent contract returns one reply
per turn, so there is nothing to stream into.

## Quotas

Two counters, per team, per window:

- **Requests per window.** Default 40.
- **Tokens per window.** Default 150,000, prompt plus completion.

The window is 5 minutes long and aligned to the clock, so it starts at
17:00:00, 17:05:00, 17:10:00, and every team resets at the same moment. The
dashboard shows both counters and the time of the next reset.

Do not hardcode 40 and 150,000 in your head. Organizers can change both during
the event, and the dashboard card shows the live limits and your usage against
them. Read them there.

Two details worth knowing when you are near a cap:

- A request is counted before it goes upstream, so a call that is refused or
  fails after that point still spends one of your requests. A body the proxy
  rejects outright, a bad model name or `"stream": true`, costs you nothing.
- Tokens are counted after the reply arrives, from the provider's
  `usage.total_tokens`. So one long answer can carry you past the token
  budget; the next call in that window is the one that gets refused.

Exceeding either cap is HTTP 429 with a `retryAfterSeconds` field:

```json
{
  "error": "rate_limit_exceeded",
  "message": "Your team has used all 40 requests for this 5 minute window. It resets in 137s.",
  "retryAfterSeconds": 137
}
```

```json
{
  "error": "token_quota_exceeded",
  "message": "Your team has used its 150000 token budget for this 5 minute window. It resets in 88s.",
  "retryAfterSeconds": 88
}
```

`agent/llm.js` raises these as an `LlmError` carrying `status` and the raw
`body`, so you can back off instead of hammering:

```js
import { chatCompletion, LlmError } from './llm.js';

try {
  return await chatCompletion(messages, { tools });
} catch (err) {
  if (err instanceof LlmError && err.status === 429) {
    // The window is spent. Wait it out; the body carries retryAfterSeconds.
  }
  throw err;
}
```

Fewer, better turns is the cheaper fix. `MAX_ROUNDS` in the turn loop, a
system prompt that does not restate the whole catalogue, and `temperature: 0`
all spend less of the window than a retry does.

## When the key stops working

The key keeps working past the 3:30pm submission deadline, through judging,
and stops when results are announced at 4:30pm. That is deliberate: staff run
the hidden suite against your agent after submissions close, so an agent
whose model access died at 3:30 would be judged unable to speak.

Keep your agent and your tunnel running until results. After 4:30pm every
chat completion comes back as HTTP 403:

```json
{
  "error": "window_closed",
  "message": "The Plecathon is over, so this key no longer works."
}
```

## Errors

Every error is JSON `{ "error": code, "message": sentence }`, the same shape
the sandbox uses. The two quota errors also carry `retryAfterSeconds`.

| status | error | when |
| --- | --- | --- |
| 401 | `invalid_api_key` | no key, a key that is not `plk_` shaped, or one that has been replaced |
| 400 | `invalid_request` | the body is not an object, or `messages` is missing or empty |
| 400 | `streaming_unsupported` | the body carries `"stream": true` |
| 400 | `model_not_allowed` | `model` is not one of the four above |
| 403 | `window_closed` | the event is over (after results), so the key no longer works |
| 429 | `rate_limit_exceeded` | your team is out of requests for this window |
| 429 | `token_quota_exceeded` | your team is out of tokens for this window |
| 429 | `proxy_busy` | too many of the room's calls are in flight at once; retry in a second |
| the provider's own | `upstream_error` | the provider refused or failed. A 429 here means PLEC's shared account is busy, not that you are over your cap: wait a moment and retry |
| 504 | `upstream_timeout` | the provider did not answer in 60 seconds |
| 502 | `upstream_unreachable` | the provider could not be reached at all |
| 503 | `proxy_unconfigured` | the proxy has no upstream account configured. Tell an organizer |

`proxy_busy`, `upstream_error` and `upstream_timeout` are about the shared
account, not about you. Retry them. `invalid_api_key`, `model_not_allowed`,
`streaming_unsupported` and `invalid_request` are about the request you sent,
so retrying the same call will fail the same way.

## Bringing your own key instead

Allowed, and sometimes the smoother choice, since this proxy is shared and
capped. Point `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` at any
OpenAI-compatible endpoint: OpenAI, Anthropic, Groq, DeepSeek, Moonshot
directly, or Ollama on your laptop. `.env.example` lists the base URLs.
Nothing else in the template cares which one you use.
