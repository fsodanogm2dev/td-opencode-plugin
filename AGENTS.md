# AGENTS.md

Guidance for AI coding agents that work in this repository.

## What this is

`td-opencode-plugin` is an OpenCode V2 server plugin for TELUS Digital engineers who use FueliX. It:

1. Registers the FueliX providers (`fuelix-openai`, `fuelix-anthropic`, `fuelix`) and their models from
   `https://api.fuelix.ai/v1/models`, with curated metadata from `data/fuelix-models.json`.
2. Resolves one FueliX API key (macOS Keychain, OpenCode credential store, or `FUELIX_API_KEY`) and injects it per
   request. The key never goes into provider `settings` or `headers`.
3. Marks one low-cost title model per provider, so OpenCode writes session titles with it.

Active plans go in `docs/plans/pending/`; tick their steps as they finish. Finished plans move to `docs/plans/done/`.
Release notes are in `CHANGELOG.md`.

## Commands

```bash
bun install
bun test                 # unit tests
bun run typecheck        # tsc --noEmit
bun run doctor           # compare live /v1/models with data/fuelix-models.json (needs a FueliX key)
```

## Non-negotiable rules

- **Change only this repository.** `anomalyco/opencode` and the user's OpenCode configuration (`~/.config/opencode/`)
  and data (`~/.local/share/opencode/`) are read-only.
- **No `opencode.json`, `opencode.jsonc`, or `.opencode/` at the repository root.** The live OpenCode service loads them
  for every session whose directory is this repository, and a broken provider transform would break the session that
  edits the code. Put examples in `examples/`.
- **Test OpenCode only on isolated servers** (temporary `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, and a location directory outside `$HOME`).
- **Never write a secret** to a file, log line, test fixture, snapshot, provider `settings`, or provider `headers`.
  Tests use fake keys such as `sk-test-not-a-real-key`.

## Code style

- TypeScript, ES modules, Bun runtime. Imports use explicit `.ts` extensions.
- Keep modules small and pure where possible; side effects (network, child processes, file system) live behind
  injectable functions so tests can replace them.
- Documentation uses ASD-STE100 style: short sentences, active voice, one term per concept.
