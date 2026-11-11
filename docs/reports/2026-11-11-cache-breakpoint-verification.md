# Cache breakpoint: live verification

Date: 2026-11-11. Scope: `src/fuelix/cache.ts` (`withCacheFetch`).

## What was checked

One real `POST https://api.fuelix.ai/v1/messages` call went through the real `withAuthFetch(withCacheFetch(base))`
chain. The `base` function recorded only safe summary fields. It did not record the key, the headers, or the body.
The prompt was synthetic. It had a unique, random stable prefix of about 89,500 characters, so the cache was cold. The
request set `max_tokens` to 16 and asked for one word. The original body had no `cache_control` marker.

The call used 1 generation request. No unmarked request was sent.

## Result

| Item | Value |
| --- | --- |
| Model requested | `claude-opus` |
| Model in the response | `claude-opus-5-5` |
| HTTP status | 200 |
| Stop reason | `end_turn` |
| Markers sent | 1, at `system[0]`, `{"type":"ephemeral"}` |
| `Authorization` header | `Bearer`, present |
| `x-api-key` header | absent |
| `cache_creation_input_tokens` | 46150 (all in `ephemeral_5m_input_tokens`) |
| `cache_read_input_tokens` | 0 |
| `input_tokens` | 16 |
| `output_tokens` | 4 |

## What this shows

- The wrapper adds one ephemeral marker to a `/v1/messages` body that has none.
- FueliX accepts the request and creates a cache entry.
- Auth stays Bearer.

## What this does not show

- No request without a marker was sent, so the report does not show that the marker prevents the HTTP 400.
- The cause of the missing marker in the original failure is not established.
- No second call was made, so a cache read is not verified.
- The check did not use the AI SDK bridge, a resumed OpenCode session, or a streaming response.
- A short prompt was not tested live.
