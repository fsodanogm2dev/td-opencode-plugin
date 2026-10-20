# TD OpenCode plugin: FueliX catalog, accurate usage, td-telemetry

Owner: Fabricio Sodano · Created: 2026-10-19 · Target: OpenCode `v2.0.32`, `@opencode/plugin@2.0.32`

## Steps

- [x] Phase 0: Bootstrap the repository (package, type check, tests, agent rules)
- [x] Phase 1: Load the FueliX catalog from `/v1/models` and resolve one API key securely
- [x] Phase 2: Verify that the TUI and OpenChamber report accurate tokens, cost, and context
- [x] Phase 3: Emit td-telemetry events from OpenCode sessions

## Gate evidence

| Phase | Evidence |
| --- | --- |
| 0 | A fresh clone passes `bun run typecheck` and `bun test test/unit`. `.github/workflows/ci.yml` runs both. |
| 1 | `test/integration/fuelix-plugin.test.ts`: the three providers, every chat model with a price and limits, discovery reload, Bearer auth, no key in `GET /api/model` or `GET /api/provider`. `test/integration/live-usage.test.ts`: one live prompt per provider, HTTP 200 with Bearer auth. `scripts/migrate-config.ts`: the author's configuration goes from 2,659 to 80 lines. |
| 2 | [`docs/reports/2026-10-19-usage-accuracy.md`](../../reports/2026-10-19-usage-accuracy.md) (live token and cost parity, all fields equal), [`docs/reports/2026-10-20-registry-comparison.md`](../../reports/2026-10-20-registry-comparison.md) (every change between the current configuration and the plugin). `test/integration/wire-replay.test.ts` replays the live streams offline. |
| 3 | `test/unit/telemetry/normalizer-compat.test.ts` decodes the emitted payloads with td-telemetry's own normalizer. `test/integration/td-telemetry.test.ts` runs a real td-telemetry receiver: plain prompt, tool call, idle `SessionEnd`, branch recorded as the feature key, stored `cost_usd` equal to OpenCode's step cost. |

The integration tests need the `opencode` CLI and run on a developer machine (`test/integration/README.md`). CI runs
the type check and the unit tests.

## Context

This plugin replaces the hand-written FueliX provider blocks in the global OpenCode configuration and feeds
TELUS Digital telemetry from OpenCode and OpenChamber sessions.

Facts measured on 2026-10-19 on the author's machine:

| Fact | Source |
| --- | --- |
| The global config has 2,658 lines. FueliX provider blocks fill lines 3–2010 and 2083–2656. | `~/.config/opencode/opencode.json` |
| FueliX serves 108 model IDs. The config defines the same 108 IDs: 34 on `fuelix-openai`, 49 on `fuelix`, 25 on `fuelix-anthropic`. | `GET https://api.fuelix.ai/v1/models`, `opencode api get /api/model` |
| `GET /v1/models` returns only `id`, `object`, `created`, `owned_by`. It has no price, limit, or modality data. `GET /v1/models/{id}` returns the same fields. | Same request |
| A model with no cost entry gets `cost: []` and default limits (`context 200000`, `output 32000`). Examples: `fuelix-openai/gpt-6.0-sol`, `fuelix/gemini-4-argon`. These models show `$0` cost. | `opencode api get /api/model` |
| `GET /api/model` and `GET /api/provider` return `fuelix-anthropic` `settings.apiKey` and `headers.Authorization` in clear text. `fuelix-openai` gets its key from the credential store and exposes no key. | `opencode api get /api/model` |
| The FueliX Anthropic endpoint rejects `x-api-key` (HTTP 401) and accepts `Authorization: Bearer` (HTTP 200). | `POST https://api.fuelix.ai/v1/messages`, request IDs `38d3215f-…` and `2141043f-…` |
| FueliX returns standard `usage` objects for Anthropic Messages, OpenAI Responses, and Chat Completions (streaming with `include_usage` too). It sends `x-quota-allowed`, `x-quota-available`, `x-quota-reset`, and no cost header. | Probe requests on 2026-10-19 |
| The OpenCode credential store keeps `/connect` keys as clear-text JSON in `~/.local/share/opencode/opencode.db` (table `credential`, file mode `0600`). | `sqlite3 … .schema credential` |
| td-telemetry accepts only Claude Code today. Its receiver takes OTLP/HTTP JSON on `127.0.0.1:4418`; its hook scripts take `{session_id, cwd, transcript_path}` on stdin. | `willowtreeapps/td-telemetry` `README.md`, `AGENTS.md`, `lib/otel-normalize.mjs` |

## Constraints

- Change only this repository. `willowtreeapps/td-telemetry`, `anomalyco/opencode`, and the user's OpenCode
  configuration and data are read-only.
- Do not create `opencode.json`, `opencode.jsonc`, or `.opencode/` at the repository root. The live OpenCode service
  loads them for every session in this directory. Examples go in `examples/`.
- Run every OpenCode test against an isolated server with temporary config and data directories.
- Never write a secret to a file, a log line, a test fixture, provider `settings`, or provider `headers`.
- td-telemetry rule: dollars come only from the `api_request` event's `cost_usd`. The plugin takes that value from the
  cost that OpenCode records on the assistant message. It never estimates cost from tokens on its own.

## Phase 0: Bootstrap

Deliverables: `package.json` (Bun, TypeScript, pinned `@opencode/plugin@2.0.32`), `tsconfig.json`, `bun test` suite,
`AGENTS.md` with the constraints above, `README.md`, GitHub Actions workflow for type check and tests.

Gate: `bun run typecheck` and `bun test` pass on a clean clone.

## Phase 1: FueliX catalog and secure key

### Goal

The plugin registers the three FueliX providers and all chat models from `/v1/models`, with complete metadata. The
user's configuration needs one plugin entry instead of the FueliX provider blocks. One API key serves all three
providers, and no API response exposes it.

### Design

- **Provider IDs stay the same**: `fuelix-openai` (`@opencode/ai/providers/openai`, OpenAI Responses), `fuelix-anthropic`
  (`@opencode/ai/providers/anthropic`), `fuelix` (`@opencode/ai/providers/openai-compatible`). Sessions, agent
  settings, and saved credentials refer to these IDs (decision D1).
- **Discovery**: `GET {baseURL}/v1/models` during `setup`. Keep the last good list in `ctx.storage` for offline
  starts. Refresh on an interval (default 60 minutes), then call `ctx.provider.reload()`.
- **Routing**: `data/fuelix-models.json` records the provider route of every known model. The seed comes from the
  current configuration, because it holds tested routes (for example, `claude-3-7-sonnet` runs on Chat Completions,
  not on Anthropic Messages). Rules route unknown IDs by family (`gpt-*`/`o*` → Responses, `claude-*` → Anthropic,
  others → Chat Completions).
- **Metadata order**: curated table → OpenCode built-in catalog for the matching upstream model → safe defaults with a
  warning. The curated table holds price per 1M tokens (input, output, cache read, cache write, 200k context tier),
  limits, input and output modalities, tool support, and reasoning support. `scripts/build-catalog.ts` generates it at
  development time from `fuelix/LLM-Inventory` (`data/deployments.yaml`, `data/costs.yaml`) plus the routing seed. The
  runtime does not need GitHub access (decision D8).
- **Variants**: the plugin replicates the OpenCode `2.0.32` variant rules for its three packages
  (`packages/core/src/variant.ts`), because that module is not exported to plugins. Today every configured model gets
  reasoning variants, including models that do not reason (for example `gpt-4.1`). The plugin adds no variants to a
  model that the catalog marks `reasoning: false` (decision D7).
- **Non-chat models** (embeddings, text-to-speech, transcription, image generation) are not registered by default,
  because the chat model picker cannot use them. Option `includeNonChatModels` restores them (decision D3).
- **Key resolution order**, first match wins:
  1. macOS Keychain item `fuelix-api-key` (option `keychainService`), read with `/usr/bin/security`.
  2. OpenCode credential store: the active connection of the `fuelix` integration (`/connect` → FuelIX).
  3. Environment variable `FUELIX_API_KEY`.
- **One credential**: all three providers set `integrationID: "fuelix"`. OpenCode then injects the credential-store key
  of the `fuelix` integration as the runtime `apiKey` of each provider, without exposing it in `settings` (decision D5).
  The user's existing `/connect` credential for `fuelix` works without change.
- **Key injection**: a `session.hook("http.request")` scoped to each FueliX provider sets `Authorization: Bearer <key>`.
  It moves the `x-api-key` value that the Anthropic package sends (FueliX rejects it), and it applies a Keychain key
  (override) or `FUELIX_API_KEY` (fallback). Provider `settings` and `headers` carry no secret (decisions D2, D6).
  An integration `command` method that runs `security` is not used, because OpenCode stores the command output in the
  `credential` table, which would copy the Keychain secret into `opencode.db`.
- **Activation**: `enabled` when the plugin holds a Keychain or environment key, otherwise `auto` (the providers appear
  when the `fuelix` integration has a connection). With `enabled` and no key, OpenCode sends requests without
  credentials, and FueliX rejects them.
- **Configuration migration**: `examples/opencode.jsonc` shows the reduced configuration. A dry-run script prints the
  user's configuration without the FueliX blocks; it never writes the file.

### Gate

1. Unit tests pass for routing, metadata merge, key resolution order, and provider building.
2. An isolated OpenCode server that loads only this plugin lists every FueliX chat model across the three providers.
   Each model has a non-empty `cost` and explicit limits.
3. The responses of `GET /api/model` and `GET /api/provider` on that server contain no key material.
4. One short prompt per provider succeeds on that server.

## Phase 2: Accurate usage in the TUI and OpenChamber

### Goal

The token, cost, cache, and context figures in the TUI and in the OpenChamber session panel match what FueliX reports.

### Checks

- **Catalog completeness**: `bun run doctor` compares live `/v1/models` with the curated table. It fails on a model
  without cost or limits and lists models that use a fallback route.
- **Tokens**: for one model per provider, send a short prompt through the isolated server. Record the FueliX `usage`
  object and compare it with the tokens stored on the assistant message (input, output, reasoning, cache read, cache
  write). Expected result: exact match.
- **Cost**: recompute cost from the curated price table and the FueliX `usage`, and compare it with the stored message
  cost. Expected result: equal within `1e-9` USD.
- **Context**: confirm `limit.context` per model and the context percentage that OpenCode derives from it.
- **Fixes**: correct every difference found, in the plugin or in the curated table.
- **Earlier claim to settle**: an earlier analysis attributed the `$0` in the OpenChamber panel to missing prices.
  With `gpt-6-luna` prices, 15.0K input and 1.7K output tokens cost about $0.0024, which rounds to `$0`. Models with
  `cost: []` also show `$0`. The Phase 2 report states which case applied.

### Gate

A table of model × field (FueliX value, OpenCode value, match) for one model per provider, committed under
`docs/reports/`.

## Phase 3: td-telemetry emitter

### Goal

OpenCode and OpenChamber sessions appear in the td-telemetry local dashboard (and in the optional ai-adoption push)
with project, branch, PR, model, agent, tool, and cost data. td-telemetry stays unchanged (decision D4).

### Design

- **Locate td-telemetry**: option `tdTelemetry.root` → environment variable `TD_TELEMETRY_ROOT` → newest installed
  copy under `~/.claude/plugins/cache/*/td-telemetry/<version>/`. When none is found, telemetry stays off and the plugin
  logs one line.
- **Runtime pair**: at setup, run `node <root>/lib/process-manager.mjs` once, detached, as the Claude Code
  `SessionStart` hook does.
- **Segments**: run `node <root>/scripts/hook-record-feature.mjs` with the same stdin JSON that Claude Code sends, at
  session start and on each user prompt. Run `scripts/hook-session-end.mjs` when the session ends. Research item: map
  OpenCode session lifecycle (sessions persist; there is no process exit per session) to `SessionStart` and
  `SessionEnd`, and supply the conversation title without a Claude transcript file.
- **Events**: map OpenCode events to td-telemetry OTLP log records: `user_prompt`, `api_request` (one per model call,
  `cost_usd` from OpenCode), `tool_result`, `tool_decision`, `skill_activated`, `subagent_completed`. Root sessions use
  `query_source = repl_main_thread`; child sessions use the agent query source.
- **Transport**: bounded in-memory queue, batch POST of OTLP/HTTP JSON to `http://127.0.0.1:4418/v1/logs`, short
  timeout, limited retries, drop on failure. Telemetry never blocks or fails a session.
- **Privacy**: send IDs, names, counts, durations, and costs only. Never send prompt text, tool input or output, or
  file contents.

### Gate

1. Unit tests validate every emitted record against td-telemetry's own normalizer (`lib/otel-normalize.mjs`, imported
   from a read-only clone in an optional test).
2. Integration test: an isolated td-telemetry pair (scratch `TD_DATA_DIR`, `HOME`, and ports) and an isolated OpenCode
   server with the plugin. After one prompt, the `events` table has an `api_request` row with a non-zero `cost_usd`, the
   `segments` table has a row with project and branch, and the dashboard API shows the session cost.

## Follow-ups found during the work

- **Anthropic prompt cache across user turns**: in the Phase 2 probe, a new user turn rewrote the cache instead of
  reading it, although FueliX keeps the cache for identical requests. Compare two consecutive OpenCode request bodies
  to find the block that changes. Evidence: `docs/reports/2026-10-19-usage-accuracy.md`, "Other findings".
- **Title generation cost**: OpenCode generates titles with the session model. Check whether OpenCode V2 lets a user
  choose a cheaper title model, and document it.

## Out of scope

- Cortex MCP wiring.
- Migration of `jev-plugin.js` hooks to the V2 API.
- Any change to `willowtreeapps/td-telemetry`. An upstream contribution is possible later; this plan does not depend on
  it.

## Risks

| Risk | Mitigation |
| --- | --- |
| The OpenCode V2 plugin API is new and can change between releases. | Pin `@opencode/plugin@2.0.32`. Test against the installed OpenCode version. |
| FueliX has no metadata API, so the curated table can drift. | `bun run doctor`, startup warnings for models that use defaults. |
| td-telemetry semantics assume Claude Code (agent names, MCP tool names, session lifecycle). | Document each mapping. Validate records with td-telemetry's normalizer. |
| A plugin bug can break model selection in the live service. | Never load the plugin from this repository's root. Test only on isolated servers. |

## Decision log

- **D1**: Keep the provider IDs `fuelix`, `fuelix-openai`, `fuelix-anthropic`.
- **D2**: Keep secrets out of provider `settings` and `headers`. Inject the key per request.
- **D3**: Do not register non-chat models by default.
- **D4**: Feed td-telemetry only through its public interfaces (OTLP receiver and hook scripts).
- **D5**: Use `integrationID: "fuelix"` on all three providers, so one credential serves them.
- **D6**: Authenticate with an `http.request` hook that sets `Authorization: Bearer`. Do not use provider headers or a
  `command` integration method.
- **D7**: Replicate the OpenCode `2.0.32` variant rules. Add no variants to models that the catalog marks
  `reasoning: false`.
- **D8**: Generate the catalog from `fuelix/LLM-Inventory` at development time. When one model ID maps to several
  deployments, use the highest base input price (list rate) and the smallest limits. Contracted Anthropic rates are
  lower and private, so the cost shown can be higher than the metered cost for requests that FueliX routes to the
  `anthropic/*` deployment.
- **D9**: In td-telemetry, report subagent activity under the root session ID with `query_source = agent:builtin:<agent>`,
  because td-telemetry attributes subagent spend inside the parent session. Report the tools named in
  `subagentToolNames` as `Task`, so td-telemetry builds subagent run windows.
- **D10**: Report each session from exactly one plugin instance. OpenCode loads one plugin instance per location, and
  sometimes two for one directory with two spellings (`/var/...` and `/private/var/...` on macOS). The bus filters
  routed events by location, but it delivers events without a route or location to every instance
  (`packages/core/src/bus.ts`, `local()`), so several instances can see one session; the real-receiver test stored two
  segments for one session in about 1 run in 10 before this rule. Instances register their location in a process-wide
  registry (`src/telemetry/ownership.ts`). An instance reports a session only when the session directory is its exact
  location or, without an exact owner, when it is the smallest registered directory with the same real path.
- **D11**: Ship a root `index.ts` that re-exports `src/index.ts`. OpenCode loads a local plugin directory through
  `<dir>/index.*` or `<dir>/server.*` and ignores `package.json` `exports`.
- **D12**: Per-field source priority in the catalog. Prices: LLM-Inventory first, because FueliX meters with those rows.
  Limits, modalities, tool and reasoning flags: the working configuration first, LLM-Inventory only for gaps, and an
  inventory output limit at or above its context limit is ignored. Reason: inventory limits and capabilities come from
  generic registry defaults and contain errors (for example, `llama-4-scout` lists 10,000,000 output tokens), and
  OpenCode sends `max_tokens = min(limit.output, 256000)`, so a wrong output limit can break a working model.
