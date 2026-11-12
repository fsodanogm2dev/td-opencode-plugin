# td-opencode-plugin

OpenCode V2 plugin for TELUS Digital engineers who use FueliX with OpenCode and OpenChamber.

It does five things:

1. **FueliX catalog**: registers the `fuelix-openai`, `fuelix-anthropic`, and `fuelix` providers and loads their
   models from `https://api.fuelix.ai/v1/models`. Prices, limits, and modalities come from a curated catalog
   (`data/fuelix-models.json`) generated from `fuelix/LLM-Inventory`. Your configuration no longer needs the FueliX
   provider blocks.
2. **One key, kept out of API responses**: one FueliX key serves all three providers. The plugin never puts the key in
   provider `settings` or `headers`, which `GET /api/model` and `GET /api/provider` return to every local client.
3. **Low-cost session titles**: OpenCode writes session titles with one low-cost model per provider instead of the
   session model.
4. **Batch workflow**: six ordinary tools (`fuelix_batch_*`) submit independent Messages requests from a file to
   FueliX, check the status, cancel, and collect the results into protected local files. Details are in
   [`docs/batches.md`](docs/batches.md). Live batch submission was rejected with HTTP 403, so account access and result
   collection are not verified.
5. **Optional Jev decisions**: Jev 1.14.0 adds shell permission checks and failure-output compression. Skill and
   reasoning observations are shadow-only. Jev is disabled by default and sends selected redacted data to TypeSafe,
   outside FueliX. Read [`docs/jev.md`](docs/jev.md) before enabling it.

A visual overview with diagrams is in [`docs/index.html`](docs/index.html). Open it in a browser from a clone.
Release notes are in [`CHANGELOG.md`](CHANGELOG.md). The work plan, its decisions, and its evidence are in
[`docs/plans/done/2026-10-19-fuelix-catalog-usage.md`](docs/plans/done/2026-10-19-fuelix-catalog-usage.md).

## Requirements

- OpenCode `v2.0.32` or later (`opencode --version`).
- A FueliX API key.

## Install

The repository `fsodanogm2dev/td-opencode-plugin` is public. Installing it over HTTPS needs no GitHub authentication.

### OpenChamber: plugin and status panel together

Use OpenChamber 2.7.0 or later. Open **Settings → Extensions** and add this repository URL:

```text
https://github.com/fsodanogm2dev/td-opencode-plugin#v0.5.0
```

Approve the status-report file access and **Add a plugin to OpenCode**. OpenChamber then loads the bundled plugin and
adds **FueliX status** to the rail. The package ships built files; no local build is needed.

If the plugin is already listed in your OpenCode configuration, remove that manual entry before installing the combined
package. Do not install both copies. If you already installed the status-only `extension/` folder, remove that extension
first. These steps do not remove your FueliX credential.

The combined install uses default plugin options. For custom plugin options, use the standalone installation below
and the status-only folder described in [`docs/openchamber-status.md`](docs/openchamber-status.md). OpenCode installations
do not silently install OpenChamber extensions; OpenChamber asks for approval.

### Standalone OpenCode plugin

Add the plugin to `~/.config/opencode/opencode.json` and pin the release tag:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "github:fsodanogm2dev/td-opencode-plugin#v0.5.0", "options": {} }]
}
```

OpenCode installs the plugin with git when it starts, so git must be installed on your machine and must be able to reach
GitHub. An SSH key or `gh auth setup-git` is optional. OpenCode keeps the install in its cache. To update, change the tag to a
newer release ([`CHANGELOG.md`](CHANGELOG.md) lists them). OpenCode installs the new tag when the configuration changes.

Without a tag, OpenCode installs the newest commit of `main` once and keeps that copy. Once a day it checks for a newer
commit, and `opencode plugin check` then shows `update available`, but OpenCode installs the update only when you run
`opencode plugin update github:fsodanogm2dev/td-opencode-plugin`.

To install from a clone instead, check out the release tag and give OpenCode the absolute path of the folder. OpenCode
does not expand `~` in this path, and it reloads the plugin when files in the folder change. The plugin has no runtime
dependencies, so the clone needs no `bun install`. To update, check out the newer tag in the clone:

```bash
git clone --branch v0.5.0 https://github.com/fsodanogm2dev/td-opencode-plugin.git ~/td-opencode-plugin
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

The three provider names identify request formats, not separate FueliX accounts:

- `fuelix-openai` uses OpenAI Responses, typically for GPT and o-series models.
- `fuelix-anthropic` uses Anthropic Messages, typically for Claude models.
- `fuelix` uses OpenAI-compatible Chat Completions for models such as Gemini, Llama, Mistral, and DeepSeek.

All three connect to FueliX with the same key. The curated catalog chooses the route for each model; specific model
aliases can use a different route from their family's default. OpenAI-compatible describes the format, not the model's
vendor. Anthropic background-request authentication belongs to `fuelix-anthropic`; it is not a fourth provider.

The plugin looks for the key in this order and uses the first one it finds:

| Order | Source | How to set it | Storage |
| --- | --- | --- | --- |
| 1 | macOS Keychain item `fuelix-api-key` | `security add-generic-password -U -s fuelix-api-key -a "$USER" -w` (prompts for the key) | Encrypted login keychain |
| 2 | OpenCode credential store | `/connect`, then choose **FuelIX** | Clear text in `~/.local/share/opencode/opencode.db` (mode `0600`) |
| 3 | `FUELIX_API_KEY` | Environment of the OpenCode service, for example `~/.config/opencode/service.json` | Clear text in that file |

How the plugin uses the key:

- All three providers set `integrationID: "fuelix"`, so one credential serves them.
- FueliX accepts only `Authorization: Bearer <key>`. A `session.hook("http.request")` sets this header on each session
  request (chat, titles, compaction) of the three providers.
- `fuelix-anthropic` uses the AI SDK bridge package `aisdk:@ai-sdk/anthropic`. An `aisdk.hook("sdk")` wraps `fetch` for
  this provider. It sets the `Authorization` header and removes `x-api-key` on every request, also on stateless calls
  such as `POST /api/experimental/generate/text` (OpenChamber walkthroughs), which run no session hooks.
- FueliX has rejected a long `fuelix-anthropic` prompt with HTTP 400: `Model claude-opus requires a cache_control
  breakpoint on prompts of 1024 tokens or more`. The same `fetch` wrapper now guards against this. For a
  `POST .../messages` JSON body that has no `cache_control` marker, it adds one `{"type":"ephemeral"}` marker. The
  marker goes on the last cacheable system block, or on a cacheable message block when there is no usable system text. The plugin
  does not count tokens, so short prompts get the marker too. A request that already has a marker is not changed.
  Other endpoints, such as `/messages/count_tokens`, and bodies that are not JSON are not changed. One live call
  with a synthetic long prompt was accepted. The live check did not cover a resumed session, the AI SDK bridge,
  streaming, or a cache read. See the
  [verification report](docs/reports/2026-11-11-cache-breakpoint-verification.md).
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

Known limitation: OpenCode does not run session hooks for stateless calls (`POST /api/generate` and
`POST /api/experimental/generate/text`). On the native packages (`fuelix-openai`, `fuelix`), those requests carry only
the native credential. `fuelix-anthropic` is not affected, because its `fetch` wrapper runs for every call.

| Key source | `fuelix-openai` and `fuelix` on stateless calls | `fuelix-anthropic` on stateless calls |
| --- | --- | --- |
| `/connect` credential | Works (native `Bearer`) | Works |
| Keychain only | Fails with HTTP 401 (no credential) | Works |

Session traffic is not affected. If you use a stateless feature with `fuelix-openai` or `fuelix`, keep a `/connect`
credential as well.

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

## OpenChamber status extension

The extension shows the plugin's recorded configuration and the latest automatic
model-discovery result. It lists added and removed models and keeps the latest model change visible after an unchanged
check. It reads reports, not credentials. **Reload report** reads the saved report; it does not run a check.

Install the combined repository package from **Settings → Extensions** in OpenChamber web or desktop. See
[`docs/openchamber-status.md`](docs/openchamber-status.md) for build steps, permissions, and report limitations.

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
      "scrubShellEnv": true,                // remove FUELIX_API_KEY from agent shell environments
      "statusReport": true                 // write credential-free reports for the optional OpenChamber extension
      // Optional batchRates: see docs/batches.md for sourced batch prices.
    },
    "jev": { "enabled": false, "model": "jev-1.14.0" }, // optional; see docs/jev.md
    "debug": false
  }
}
```

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
