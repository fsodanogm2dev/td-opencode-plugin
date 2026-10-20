# td-opencode-plugin

OpenCode V2 plugin for TELUS Digital engineers who use FueliX with OpenCode and OpenChamber.

It does three things:

1. **FueliX catalog**: registers the `fuelix-openai`, `fuelix-anthropic`, and `fuelix` providers and loads their
   models from `https://api.fuelix.ai/v1/models`. Prices, limits, and modalities come from a curated catalog
   (`data/fuelix-models.json`) generated from `fuelix/LLM-Inventory`. Your configuration no longer needs the FueliX
   provider blocks.
2. **One key, kept out of API responses**: one FueliX key serves all three providers. The plugin never puts the key in
   provider `settings` or `headers`, which `GET /api/model` and `GET /api/provider` return to every local client.
3. **td-telemetry events**: sends OpenCode and OpenChamber session activity (cost, tokens, models, agents, tools) to the
   local [td-telemetry](https://github.com/willowtreeapps/td-telemetry) receiver, so the sessions appear in its dashboard.

The work plan and its status are in [`docs/plans/pending/`](docs/plans/pending/).

## Requirements

- OpenCode `v2.0.32` or later (`opencode --version`).
- A FueliX API key.
- For telemetry only: td-telemetry installed as a Claude Code plugin, and Node.js 22.5 or later on `PATH`.

## Install

Add the plugin to `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "github:fsodanogm2dev/td-opencode-plugin", "options": {} }]
}
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

The Keychain is the recommended source. With a Keychain key you can delete the key from `service.json` and from the
credential store.

How the plugin uses the key:

- All three providers set `integrationID: "fuelix"`, so one credential serves them.
- A `session.hook("http.request")` sets `Authorization: Bearer <key>` on each FueliX request. FueliX rejects the
  `x-api-key` header that the Anthropic package sends, so the hook moves that value into the `Authorization` header.
- The key stays in memory. It is never written to a file or a log line.

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
      "discoveryTimeoutMs": 5000
    },
    "telemetry": {
      "enabled": true,                      // telemetry stays off when td-telemetry is not installed
      "root": "/path/to/td-telemetry",      // found automatically under ~/.claude/plugins/cache when unset
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

When td-telemetry is installed, the plugin:

- starts the td-telemetry receiver and dashboard if they are not running;
- records a segment (project, branch, pull request, conversation title) through the td-telemetry hook scripts;
- sends OTLP/HTTP JSON log records to the receiver: `user_prompt`, `api_request` (one per model call, with the cost that
  OpenCode recorded), `tool_result`, `tool_decision`, `skill_activated`, and `subagent_completed`.

The plugin never sends prompt text, tool input or output, or file contents. Set `"telemetry": { "enabled": false }` to
turn telemetry off.

## Development

```bash
bun install
bun test                  # unit tests
bun run typecheck
bun run test:integration  # starts isolated OpenCode servers; see test/integration/README.md
bun run doctor            # compares live /v1/models with data/fuelix-models.json (needs a FueliX key)
```

Read [`AGENTS.md`](AGENTS.md) before you change code. Important: never create `opencode.json`, `opencode.jsonc`, or
`.opencode/` at the repository root. The live OpenCode service loads them for every session in this directory.
