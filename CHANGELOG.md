# Changelog

## Unreleased

### Added

- `fuelix-openai/gpt-6.1-terra` in the catalog, with the price and limits from the FueliX inventory.

### Changed

- The README, the example, and `scripts/migrate-config.ts` use the plugin without a pinned tag.
  `opencode plugin update github:fsodanogm2dev/td-opencode-plugin` installs the newest commit.

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
