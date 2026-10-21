# TD OpenCode plugin: FueliX catalog and accurate usage

Owner: Fabricio Sodano · Created: 2026-10-19 · Target: OpenCode `v2.0.32`, `@opencode/plugin@2.0.32`

## Steps

- [x] Phase 0: Bootstrap the repository (package, type check, tests, agent rules)
- [x] Phase 1: Load the FueliX catalog from `/v1/models` and resolve one API key securely
- [x] Phase 2: Verify that the TUI and OpenChamber report accurate tokens, cost, and context

## Gate evidence

| Phase | Evidence |
| --- | --- |
| 0 | A fresh clone passes `bun run typecheck` and `bun test test/unit`. `.github/workflows/ci.yml` runs both. |
| 1 | `test/integration/fuelix-plugin.test.ts`: the three providers, every chat model with a price and limits, discovery reload, Bearer auth, no key in `GET /api/model` or `GET /api/provider`. `test/integration/live-usage.test.ts`: one live prompt per provider, HTTP 200 with Bearer auth. `scripts/migrate-config.ts`: the author's configuration goes from 2,659 to 80 lines. |
| 2 | [`docs/reports/2026-10-19-usage-accuracy.md`](../../reports/2026-10-19-usage-accuracy.md) (live token and cost parity, all fields equal), [`docs/reports/2026-10-20-registry-comparison.md`](../../reports/2026-10-20-registry-comparison.md) (every change between the current configuration and the plugin). `test/integration/wire-replay.test.ts` replays the live streams offline. |


The integration tests need the `opencode` CLI and run on a developer machine (`test/integration/README.md`). CI runs
the type check and the unit tests.

## Context

This plugin replaces the hand-written FueliX provider blocks in the global OpenCode configuration.

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


## Constraints

- Change only this repository. `anomalyco/opencode` and the user's OpenCode configuration and data are read-only.
- Do not create `opencode.json`, `opencode.jsonc`, or `.opencode/` at the repository root. The live OpenCode service
  loads them for every session in this directory. Examples go in `examples/`.
- Run every OpenCode test against an isolated server with temporary config and data directories.
- Never write a secret to a file, a log line, a test fixture, provider `settings`, or provider `headers`.

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

## Review decisions

An independent review of the code found 2 high, 4 medium, and 10 low findings, and no blocker.
[`docs/reports/2026-10-20-code-review.md`](../../reports/2026-10-20-code-review.md) maps every finding to its
resolution. The review led to these decisions:

- **D13**: Remove `FUELIX_API_KEY` from agent shell environments with `shell.hook("create.before")`. OpenCode builds
  every agent shell environment from the server environment (`packages/core/src/shell.ts`, lines 259–273).
- **D14**: Honor a non-default `fuelix.baseURL` only with `TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL=1` in the service
  environment and an `https` URL (plain `http` for loopback only). Plugin options can come from a project
  configuration, and the key follows the base URL.
- **D16**: Warn once when the configuration still exposes a FueliX key through old provider blocks. Configured providers
  apply after plugin providers, so the blocks undo decision D2 without notice.
- **D17**: Document, do not work around, the `/api/generate` limitation: OpenCode runs no plugin request hooks on that
  path, and the Anthropic packages send a stored key only as `x-api-key`.
- **D18**: Accept that OpenCode copies every FueliX request body in memory (review finding L9). OpenCode clones the body
  when any `http.request` hook is registered (`packages/core/src/session/model-request.ts`, lines 348–353). The key
  injection needs the hook, and the built-in `azure` provider has the same cost.

## Follow-ups

- **Anthropic prompt cache across user turns**: closed. OpenCode keeps the cached prefix the same between turns.
  FueliX serves `claude-haiku-4-5` from the Vertex AI global endpoint, where only an identical repeat of a request reads
  the cache. No cache marker or header change in the plugin restores the reads, so a fix needs FueliX. Evidence:
  [`docs/reports/2026-10-19-usage-accuracy.md`](../../reports/2026-10-19-usage-accuracy.md), "Other findings".
- **Title generation cost**: closed by D21. A user can choose another title model with `agents.title.model` (README,
  "Session titles").

## Out of scope

- Cortex MCP wiring.
- Migration of `jev-plugin.js` hooks to the V2 API.

## Risks

| Risk | Mitigation |
| --- | --- |
| The OpenCode V2 plugin API is new and can change between releases. | Pin `@opencode/plugin@2.0.32`. Test against the installed OpenCode version. |
| FueliX has no metadata API, so the curated table can drift. | `bun run doctor`, startup warnings for models that use defaults. |
| A plugin bug can break model selection in the live service. | Never load the plugin from this repository's root. Test only on isolated servers. |
| A title model leaves FueliX. | OpenCode then uses the session model for titles. `bun run doctor` lists each title model and flags a missing one. |

## Decision log

- **D1**: Keep the provider IDs `fuelix`, `fuelix-openai`, `fuelix-anthropic`.
- **D2**: Keep secrets out of provider `settings` and `headers`. Inject the key per request.
- **D3**: Do not register non-chat models by default.
- **D5**: Use `integrationID: "fuelix"` on all three providers, so one credential serves them.
- **D6**: Authenticate with an `http.request` hook that sets `Authorization: Bearer`. Do not use provider headers or a
  `command` integration method.
- **D7**: Replicate the OpenCode `2.0.32` variant rules. Add no variants to models that the catalog marks
  `reasoning: false`.
- **D8**: Generate the catalog from `fuelix/LLM-Inventory` at development time. When one model ID maps to several
  deployments, use the highest base input price (list rate) and the smallest limits. Contracted Anthropic rates are
  lower and private, so the cost shown can be higher than the metered cost for requests that FueliX routes to the
  `anthropic/*` deployment.
- **D11**: Ship a root `index.ts` that re-exports `src/index.ts`. OpenCode loads a local plugin directory through
  `<dir>/index.*` or `<dir>/server.*` and ignores `package.json` `exports`.
- **D12**: Per-field source priority in the catalog. Prices: LLM-Inventory first, because FueliX meters with those rows.
  Limits, modalities, tool and reasoning flags: the working configuration first, LLM-Inventory only for gaps, and an
  inventory output limit at or above its context limit is ignored. Reason: inventory limits and capabilities come from
  generic registry defaults and contain errors (for example, `llama-4-scout` lists 10,000,000 output tokens), and
  OpenCode sends `max_tokens = min(limit.output, 256000)`, so a wrong output limit can break a working model.
- **D19**: Make no requests to OpenCode upstream. Limits that come from OpenCode stay documented in the README (D17).
- **D21**: Mark one title model per provider with the OpenCode model `family`: `gpt-6-luna` (`gpt-luna`),
  `claude-haiku-5-5` (`claude-haiku`), and `gemini-3.1-flash-lite` (`gemini-flash-lite`). OpenCode picks the title model
  with `model.small()`, which matches only a few families (`packages/core/src/model.ts`, lines 271–283). Without a
  family, titles run on the session model. No other model gets a family, because the OpenCode models tool hides older
  models of the same family. `test/integration/title-model.test.ts` checks the choice and the `agents.title.model`
  override. In `test/integration/live-usage.test.ts`, each title request went to the title model and returned HTTP 200.
