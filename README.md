# td-opencode-plugin

OpenCode V2 plugin for TELUS Digital engineers who use FueliX with OpenCode and OpenChamber.

It does four things:

1. **FueliX catalog**: registers the `fuelix-openai`, `fuelix-anthropic`, and `fuelix` providers and loads their
   models from `https://api.fuelix.ai/v1/models`. Prices, limits, and modalities come from a curated catalog
   (`data/fuelix-models.json`) generated from `fuelix/LLM-Inventory`. Your configuration no longer needs the FueliX
   provider blocks.
2. **One key, kept out of API responses**: one FueliX key serves all three providers. The plugin never puts the key in
   provider `settings` or `headers`, which `GET /api/model` and `GET /api/provider` return to every local client.
3. **Low-cost session titles**: OpenCode writes session titles with one low-cost model per provider instead of the
   session model.
4. **td-telemetry events**: sends OpenCode and OpenChamber session activity (cost, tokens, models, agents, tools) to the
   local [td-telemetry](https://github.com/willowtreeapps/td-telemetry) receiver, so the sessions appear in its dashboard.

Release notes are in [`CHANGELOG.md`](CHANGELOG.md). The work plan, its decisions, and its evidence are in
[`docs/plans/done/2026-10-19-fuelix-catalog-usage-telemetry.md`](docs/plans/done/2026-10-19-fuelix-catalog-usage-telemetry.md).

## Requirements

- OpenCode `v2.0.32` or later (`opencode --version`).
- A FueliX API key.
- For telemetry only: a git clone of td-telemetry 0.26.0 or later, and Node.js 22.5 or later. You do not need Claude
  Code. The "Telemetry" section shows the setup.

## Install

The repository is private. You need read access to `fsodanogm2dev/td-opencode-plugin` on GitHub.

Add the plugin to `~/.config/opencode/opencode.json` and pin the release tag:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "github:fsodanogm2dev/td-opencode-plugin#v0.1.0", "options": {} }]
}
```

OpenCode installs the plugin with git when it starts, so git on your machine must be able to read the repository, for
example with an SSH key or `gh auth setup-git`. OpenCode keeps the install in its cache. To update, change the tag and
restart OpenCode.

To install from a clone instead, check out the tag and give OpenCode the absolute path of the folder. OpenCode does not
expand `~` in this path, and it reloads the plugin when files in the folder change. The plugin has no runtime
dependencies, so the clone needs no `bun install`:

```bash
git clone --branch v0.1.0 https://github.com/fsodanogm2dev/td-opencode-plugin.git ~/td-opencode-plugin
```

```jsonc
{ "plugins": [{ "package": "/Users/<you>/td-opencode-plugin", "options": {} }] }
```

Then remove the FueliX provider blocks from the same file: `provider.fuelix-openai`, `provider.fuelix`, and
`providers.fuelix-anthropic`. OpenCode applies configured providers on top of plugin providers, so blocks that stay in
the file keep overriding the plugin. [`examples/opencode.jsonc`](examples/opencode.jsonc) shows a complete reduced
configuration.

A dry-run helper prepares the reduced file for you. It never changes your configuration:

```bash
bun scripts/migrate-config.ts --out /tmp/opencode.migrated.json   # summary on stderr
diff ~/.config/opencode/opencode.json /tmp/opencode.migrated.json   # review, then copy it over yourself
```

The output keeps every other value of your file, including secrets that the file already holds, so keep it private.

## FueliX key

The plugin looks for the key in this order and uses the first one it finds:

| Order | Source | How to set it | Storage |
| --- | --- | --- | --- |
| 1 | macOS Keychain item `fuelix-api-key` | `security add-generic-password -U -s fuelix-api-key -a "$USER" -w` (prompts for the key) | Encrypted login keychain |
| 2 | OpenCode credential store | `/connect`, then choose **FuelIX** | Clear text in `~/.local/share/opencode/opencode.db` (mode `0600`) |
| 3 | `FUELIX_API_KEY` | Environment of the OpenCode service, for example `~/.config/opencode/service.json` | Clear text in that file |

How the plugin uses the key:

- All three providers set `integrationID: "fuelix"`, so one credential serves them.
- A `session.hook("http.request")` sets `Authorization: Bearer <key>` on each FueliX session request (chat, titles,
  compaction). FueliX rejects the `x-api-key` header that the Anthropic package sends, so the hook moves that value into
  the `Authorization` header.
- The key never goes into provider `settings` or `headers`, which `GET /api/model` returns to every local client, and
  never into a log line or a file.
- The plugin removes `FUELIX_API_KEY` from the environment of agent shell commands (option `fuelix.scrubShellEnv`,
  default `true`). OpenCode builds every agent shell environment from the server environment, so without this an agent
  that runs `env` would print the key into the conversation.

What each source protects against:

- An agent that runs shell commands acts as your user. It can read the credential store database, `service.json`, or a
  Keychain item that your user can read without a prompt. No source stops a deliberate read; the sources differ in how
  easily the key leaks by accident.
- The Keychain encrypts the key at rest and keeps it out of every environment. The credential store keeps it out of
  every environment but stores it in clear text. `FUELIX_API_KEY` in `service.json` is clear text and goes into the
  environment of the server and of every process it starts.
- Recommended: the Keychain or `/connect`. Remove `FUELIX_API_KEY` from `service.json` after you set one of them.

Known limitation: OpenCode does not run plugin request hooks for `POST /api/generate` (`ctx.generate.text`), which
some clients and plugins use for helper text. Those requests carry only the native credential:

| Key source | `fuelix-openai` and `fuelix` on `/api/generate` | `fuelix-anthropic` on `/api/generate` |
| --- | --- | --- |
| `/connect` credential | Works (native `Bearer`) | Fails with HTTP 401 (`x-api-key`) |
| Keychain only | Fails with HTTP 401 (no credential) | Fails with HTTP 401 |

Session traffic is not affected. If you use a feature that calls `/api/generate`, keep a `/connect` credential as well.

A non-default `fuelix.baseURL` takes effect only when the environment of the OpenCode service sets
`TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL=1` and the URL uses `https` (plain `http` only for `127.0.0.1`, `localhost`, and
`::1`). Plugin options can come from a project configuration, and the key follows the base URL, so a cloned repository
must not be able to redirect it.

## Session titles

OpenCode writes a title for each session with one extra model request. The plugin marks one low-cost model per
provider, and OpenCode sends the title request to the marked model of the session's provider:

| Session provider | Title model |
| --- | --- |
| `fuelix-openai` | `gpt-6-luna` |
| `fuelix-anthropic` | `claude-haiku-5-5` |
| `fuelix` | `gemini-3.1-flash-lite` |

If the title model fails, OpenCode retries with the session model. The cost of the title request is part of the session
total. To choose another title model, set it in your configuration. An optional `"variant"` field selects a reasoning
variant of that model:

```jsonc
{ "agents": { "title": { "model": { "providerID": "fuelix-anthropic", "model": "claude-haiku-4-5" } } } }
```

## Options

```jsonc
{
  "package": "github:fsodanogm2dev/td-opencode-plugin",
  "options": {
    "fuelix": {
      "baseURL": "https://api.fuelix.ai",   // gateway origin, without /v1
      "keychainService": "fuelix-api-key",  // false disables the Keychain lookup
      "refreshMinutes": 60,                 // /v1/models refresh interval; 0 disables it
      "includeNonChatModels": false,        // also register embedding, speech, transcription, and image models
      "discoveryTimeoutMs": 5000,
      "scrubShellEnv": true                 // remove FUELIX_API_KEY from agent shell environments
    },
    "telemetry": {
      "enabled": true,                      // telemetry stays off when td-telemetry is not installed
      "root": "/path/to/td-telemetry",      // if unset: TD_TELEMETRY_ROOT, then found under ~/.claude/plugins/cache
      "receiverURL": "http://127.0.0.1:4418",
      "node": "node",
      "idleMinutes": 30,                    // close the td-telemetry segment after this much inactivity
      "subagentToolNames": ["task", "subagent"]
    },
    "debug": false
  }
}
```

## Telemetry

Telemetry works with OpenCode alone. You do not need Claude Code. To set it up, clone td-telemetry once:

```bash
git clone https://github.com/willowtreeapps/td-telemetry.git ~/.local/share/td-telemetry
```

Then set `telemetry.root` in the plugin options to the absolute path of the clone, and restart OpenCode:

```jsonc
{
  "package": "github:fsodanogm2dev/td-opencode-plugin#v0.1.0",
  "options": { "telemetry": { "root": "/Users/<you>/.local/share/td-telemetry" } }
}
```

The dashboard is at <http://127.0.0.1:4419>. To update td-telemetry, run `git -C ~/.local/share/td-telemetry pull`,
then restart OpenCode. Instead of `telemetry.root`, you can set `TD_TELEMETRY_ROOT` in the environment of the OpenCode
service. Without either, the plugin looks for a copy that Claude Code installed under `~/.claude/plugins/cache`.

When td-telemetry is installed, the plugin:

- starts the td-telemetry receiver and dashboard if they are not running;
- records a segment (project, branch, pull request, conversation title) through the td-telemetry hook scripts;
- sends OTLP/HTTP JSON log records to the receiver: `user_prompt`, `api_request` (one per model call, with the cost that
  OpenCode recorded), `tool_result`, `tool_decision`, `skill_activated`, and `subagent_completed`.

The plugin never sends prompt text, tool input or output, or file contents. Set `"telemetry": { "enabled": false }` to
turn telemetry off.

If `package.json` in the td-telemetry root does not show version 0.26.0 or later, telemetry stays off and the server log
shows one warning.

## Development

```bash
bun install
bun test                  # unit tests
bun run typecheck
bun run test:integration  # starts isolated OpenCode servers; see test/integration/README.md
bun run doctor            # compares live /v1/models with data/fuelix-models.json (needs a FueliX key)
bun run catalog --config <opencode.json>  # rebuilds data/fuelix-models.json
```

`bun run catalog` reads the FueliX provider blocks of the given configuration as the routing seed, and
`fuelix/LLM-Inventory` with the `gh` CLI (or a local copy with `--inventory <dir>`). The header of
`scripts/build-catalog.ts` lists every option.

The integration test servers load the plugin from this folder, and OpenCode reloads the plugin when a file in it
changes. Do not edit files while the integration tests run.

Read [`AGENTS.md`](AGENTS.md) before you change code. Important: never create `opencode.json`, `opencode.jsonc`, or
`.opencode/` at the repository root. The live OpenCode service loads them for every session in this directory.
