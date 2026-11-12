# Changelog

## 0.4.0 (beta), 2026-11-12

Feature release. It needs OpenCode 2.0.32 or later. The combined extension needs OpenChamber 2.7.0 or later.
For a standalone plugin, change the configuration tag to `#v0.4.0`. For the combined package, use the repository URL in
OpenChamber **Settings → Extensions** and approve the bundled plugin. Remove a previous manual plugin entry first.

### Added

- An optional OpenChamber status extension shows the plugin's recorded configuration, latest model-discovery result,
  and added or removed models. The panel reads credential-free reports from the plugin's own report directory. It does not
  change configuration or trigger discovery. See [`docs/openchamber-status.md`](docs/openchamber-status.md).
- `options.fuelix.statusReport` controls report writing. The default is `true`.
- The repository is also an OpenChamber extension package. One approved installation loads both the plugin and the
  status panel. The standalone OpenCode plugin remains available for custom options.
- Each setup setting has a visible explanation. The panel explains the three request formats and distinguishes
  provider activation from credential validation.
- CI builds and checks both the panel and the bundled server plugin.

### Fixed

- A failed provider reload is retried on the next model-discovery cycle. Reports do not claim that unapplied model
  changes succeeded.

## 0.3.1 (beta), 2026-11-11

Patch release. It needs OpenCode 2.0.32 or later. If you use v0.3.0, change the tag in your configuration to
`#v0.3.1`.

### Fixed

- FueliX OpenAI vision models, including SOL, now advertise PDF input, so OpenCode can attach PDF files to them.

## 0.3.0 (beta), 2026-11-11

Third beta release. It needs OpenCode 2.0.32 or later. If you use v0.2.0, change the tag in your configuration to
`#v0.3.0`.

Known limitation: live batch submission was rejected with HTTP 403. Account access to FueliX batches and live result
collection are not verified. Use the batch tools only after FueliX confirms that your account has batch access.

### Added

- `/fuelix-batch <prompt>` submits one prompt directly to FueliX as a deferred batch. The command uses
  `claude-haiku-5-5-anthropic` with an output limit of 4096 tokens and makes no interactive agent call. It shares the batch
  workflow's protected storage and duplicate-submission checks. Batch discounts depend on FueliX pricing; batching
  does not inherently reduce token counts. FueliX lists batch-enabled deployment aliases in its
  [model inventory](https://docs.fuelix.ai/docs/model-ranch.md#batch-processing).
- Batch workflow for deferred, independent Messages requests. Six ordinary OpenCode tools: `fuelix_batch_submit`,
  `fuelix_batch_list`, `fuelix_batch_inspect`, `fuelix_batch_status`, `fuelix_batch_cancel`, and
  `fuelix_batch_collect`. Status and collection run on demand, with no background worker. The plugin never retries an
  ambiguous submission. Results go to protected files outside the repository. Batch history is stored per session.
  The plugin ships no verified FueliX batch rate card, so the cost of a batch is `unavailable` until you set the optional
  `options.fuelix.batchRates` (prices per million tokens that you checked with FueliX). The plugin then estimates the
  cost when you collect the results. The estimate is not billing. Live batch submission was rejected with HTTP 403;
  account access and live result collection remain unverified. See [`docs/batches.md`](docs/batches.md) and
  [`examples/batch-requests.json`](examples/batch-requests.json).

### Fixed

- `fuelix-anthropic` requests to `POST .../messages` now receive one ephemeral `cache_control` breakpoint when the body
  has none. FueliX has rejected a long prompt with HTTP 400 (`requires a cache_control breakpoint on prompts of 1024
  tokens or more`). The plugin does not count tokens, so short prompts get the marker too. Requests that already have
  a marker, other endpoints, and non-JSON bodies are not changed. One live call through the wrapper chain with a
  synthetic long prompt returned HTTP 200 (see the
  [verification report](docs/reports/2026-11-11-cache-breakpoint-verification.md)). The live check did not cover a
  resumed session, the AI SDK bridge, streaming, or a repeat call that reads the cache. The cause of the missing marker
  in the original failure is not established.

### Changed

- `fuelix-anthropic` uses the AI SDK bridge package `aisdk:@ai-sdk/anthropic`. Stateless generation, such as OpenChamber
  walkthroughs (`POST /api/experimental/generate/text`), now sends `Authorization: Bearer`. Before, it sent `x-api-key`,
  and FueliX answered with HTTP 401.
- The plugin copies missing model metadata from the built-in provider before it registers the models. This keeps the
  AI SDK package on every `fuelix-anthropic` model.

## 0.2.0 (beta), 2026-10-28

Second beta release. It needs OpenCode 2.0.32 or later. If you use v0.1.0, change the tag in your configuration to
`#v0.2.0`.

### Added

- `fuelix-openai/gpt-6.1-terra` in the catalog, with the price and limits from the FueliX inventory.

### Changed

- The README describes how OpenCode updates the plugin: with a pinned tag, change the tag; without a tag, run
  `opencode plugin update github:fsodanogm2dev/td-opencode-plugin`.

### Removed

- td-telemetry events. td-telemetry is deprecated. The plugin ignores a `telemetry` section in its options.

## 0.1.0 (beta), 2026-10-21

First beta release. It needs OpenCode 2.0.32 or later. Install steps are in the [README](README.md#install).

### Added

- FueliX providers `fuelix-openai`, `fuelix-anthropic`, and `fuelix`, with every chat model from `GET /v1/models`.
  Prices, limits, and modalities come from `data/fuelix-models.json`. Your configuration no longer needs the FueliX
  provider blocks.
- One FueliX key for the three providers, from the macOS Keychain, the OpenCode credential store, or `FUELIX_API_KEY`.
  The plugin sets `Authorization: Bearer` on each session request. The key never goes into provider settings, provider
  headers, log lines, or files, and the plugin removes `FUELIX_API_KEY` from agent shell environments.
- Session titles on one low-cost model per provider: `gpt-6-luna`, `claude-haiku-5-5`, and `gemini-3.1-flash-lite`.
  `agents.title.model` in your configuration overrides the choice.
- td-telemetry events from OpenCode and OpenChamber sessions: prompts, model calls with the cost that OpenCode records,
  tools, skills, and subagents. Telemetry needs td-telemetry 0.26.0 or later and Node.js 22.5 or later.
- One warning when old FueliX provider blocks in your configuration still expose a key.
- `scripts/migrate-config.ts` prints your configuration without the FueliX provider blocks. It never writes the file.
- `bun run doctor` compares the live model list with the catalog and checks the title models.

### Known limitations

- OpenCode runs no plugin request hooks for `POST /api/generate` (`ctx.generate.text`). Requests on that path carry
  only the native credential, so some of them fail with HTTP 401. Session traffic is not affected. The README, section
  "FueliX key", lists the cases.
- On `fuelix-anthropic/claude-haiku-4-5`, a new user turn writes a new prompt cache entry instead of reading the entry
  of the previous turn. FueliX serves this model from the Vertex AI global endpoint. The plugin cannot change this.
  Details: [`docs/reports/2026-10-19-usage-accuracy.md`](docs/reports/2026-10-19-usage-accuracy.md), "Other findings".
