# Code review before release

An independent review of the plugin source ran on 2026-10-20 from 00:21 to 00:30. The latest commit at that time was
`6fbf40c`. The reviewer was the OpenCode `oracle` agent on `fuelix-anthropic/claude-opus-5-5` (session
`ses_ea8ac2437ffem5O04rMrFIpedV`). It read the source, checked each OpenCode behavior it cites against the OpenCode
v2.0.32 source, and ran nothing. It found no blocker, 2 high, 4 medium, and 10 low findings.

Plan: [`docs/plans/done/2026-10-19-fuelix-catalog-usage-telemetry.md`](../plans/done/2026-10-19-fuelix-catalog-usage-telemetry.md),
section "Review decisions".

## Resolution

| Finding | Resolution | Commit |
| --- | --- | --- |
| H1. `/api/generate` and `ctx.generate.text` get no FueliX auth | Documented, not worked around (D17): README, "FueliX key", "Known limitation" | `c8e30bc` |
| H2. Old FueliX provider blocks silently undo D2 | One warning per process that names the provider and the field (D16) | `c8e30bc` |
| M1. The full server environment goes to td-telemetry children | Allowlisted child environment; `FUELIX_*`, `OPENCODE_*`, and `*_API_KEY` never pass (D15) | `423b229` |
| M2. Slow setup per location; a missed Keychain read is never retried | Process-wide Keychain memo with a 5-minute retry; telemetry checks run in the background; one process manager spawn per process | `c8e30bc`, `423b229` |
| M3. Discovery accepts any non-empty list | A result that drops more than 30 % of the IDs, or every model of a provider, is rejected | `c8e30bc` |
| M4. `fuelix.baseURL` can send the key to any host | A custom base URL needs `TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL=1` and `https` (D14) | `c8e30bc` |
| L1. Abort listener leak | Listener removed when the timer fires | `423b229` |
| L2. Two sets grow without limit | Both sets are bounded; title files are removed | `423b229` |
| L3. Wrong title type | Automatic titles are written as `ai-title` | `423b229` |
| L4. One bad catalog entry can break the model list | Invalid fields are dropped; each model build has its own try/catch | `c8e30bc` |
| L5. Partial setup can leave providers without auth | Auth hooks register before the provider transform | `c8e30bc` |
| L6. Keys are read once | Keys are resolved again on every discovery cycle | `c8e30bc` |
| L7. Telemetry turns off under GUI launches | Common Node.js paths are probed | `423b229` |
| L8. Grandchildren can outlive the hook timeout | The hook runs in its own process group, which is killed on timeout | `423b229` |
| L9. Every FueliX request is copied in memory | Accepted (D18) | — |
| L10. Unhandled timer | The timer is cleared | `423b229` |

D13 (remove `FUELIX_API_KEY` from agent shell environments) does not come from a finding of this review.

## Review text

The text below is the reviewer's final message. Only the heading levels differ. File and line references point to commit
`6fbf40c`.

I found no blockers. I found 2 high, 4 medium and 10 low findings. I read the plugin source and checked each OpenCode behavior I cite against the v2.0.32 source. I did not run anything.

### High

**H1. Requests through `/api/generate` and `ctx.generate.text` get no FueliX auth.**
- **Where:** `src/fuelix/index.ts:152-167`, `README.md:59-60`. OpenCode: `packages/core/src/generate.ts:64-71`, `session/model-request.ts:337-365`.
- **Problem:** OpenCode calls the `http.request` hook only for session model requests. `Generate.text` calls `llm.generate` directly, so the hook does not run.
- **Failure scenarios:**
  - Key in the credential store: requests to `fuelix-anthropic` go out with `x-api-key`, and FueliX returns HTTP 401. The old config worked here, because it set `headers.Authorization` on that provider.
  - Keychain-only key, which the README recommends: the provider is `enabled` and has no credential. `ModelResolver` then sets `Auth.none` (`model-resolver.ts:389-395`). All three providers send requests with no auth and get HTTP 401.
- **Who is affected:** any client or plugin that calls `/api/generate`. OpenChamber may call it for helper text such as commit messages; I did not confirm this.
- **Fix:** No clean fix exists inside the plugin. The built-in `azure` provider has the same gap. Document the limit. Remove the README advice to "delete the key from the credential store" when you use the Keychain. Ask OpenCode upstream for a bearer-auth option on the Anthropic package, or for HTTP hooks on `Generate`.

**H2. Old FueliX provider blocks still in the config silently undo decision D2.**
- **Where:** `src/fuelix/index.ts:139-150`. OpenCode: `plugin/supervisor.ts:99-103` puts package plugins before the `post` plugins, and `ConfigProviderPlugin` is a `post` plugin. `config/plugin/provider.ts:61-76` then runs `providers.update` on top of the plugin's record. It merges `settings` (including `apiKey`) and `headers` (including `Authorization`), and sets `activation = "enabled"`. Its model transform also overlays the old config's cost, limit and variants.
- **Failure scenario:** the user adds the plugin but does not remove the blocks. `GET /api/model` keeps returning the key in clear text, and the curated catalog is hidden. Nothing tells the user. The README warns about this, but the runtime does not.
- **Fix:** after setup, run a background check. Call `ctx.provider.get(id)` for each FueliX provider. If `settings.apiKey`, `settings.authToken`, `headers.authorization` or `headers.x-api-key` is present, log one `warn` that names the provider and field, without the value. Run the check once per process, because every location loads its own plugin instance.

### Medium

**M1. The full server environment, including secrets, goes to td-telemetry children and long-lived daemons.**
- **Where:** `src/telemetry/index.ts:96,117,128` and `process.ts:40,69`. td-telemetry: `lib/process-manager.mjs:358` spreads `...process.env` into the detached receiver and dashboard daemons.
- **Failure scenario:** `FUELIX_API_KEY`, the OpenCode server password, and other provider keys from `service.json` stay in the environment of daemons that keep running after OpenCode exits.
- **Fix:** pass an allowlist only: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `XDG_*`, `TD_*`. At minimum, delete `FUELIX_API_KEY` and `OPENCODE_*` from the child env.

**M2. Setup is slow and repeats once per location; a missed Keychain read is never retried.**
- **Where:**
  - `src/fuelix/index.ts:123-130`: the `security` call can take up to 3 s (`credentials.ts:26`).
  - `src/telemetry/index.ts:100-117`: `node --version` can take up to 5 s (`locate.ts:104`), plus a detached `process-manager` spawn.
  - `src/index.ts:31-42` runs the two setups one after the other.
- **Failure scenarios:**
  - OpenChamber with N projects runs N Keychain reads, N `node --version` runs and N `process-manager` spawns. Each location's setup can wait about 8 s in the worst case.
  - If the login keychain is locked, the read times out. The plugin then sets activation to `auto` and never runs discovery or the interval (`index.ts:131,192,220`). A Keychain-only user has no FueliX models until OpenCode restarts.
- **Fix:**
  - Make the Keychain read a process-wide memoized promise (a `globalThis` symbol, like `ownership.ts:24`). Retry it on the discovery interval.
  - Run `locateRoot`, `checkNode` and the spawn in the background after the hooks are registered.
  - Spawn `process-manager` once per process, not once per instance.

**M3. Discovery accepts any non-empty list.**
- **Where:** `src/fuelix/index.ts:202-210`.
- **Failure scenario:** during a partial FueliX outage, `/v1/models` returns a short list. The plugin replaces the registry, writes the short list to the cache, and reloads. Sessions that use a removed model fail until a later good refresh.
- **Fix:** reject a result that drops more than about 30% of the current IDs, or that drops every model of one provider. Or keep the union with the catalog's `listed` IDs for one cycle. Log the dropped IDs.

**M4. `fuelix.baseURL` can send the Keychain key to any host.**
- **Where:** `src/options.ts:113`, `src/fuelix/index.ts:159,195-200`.
- **Problem:** the Keychain key overrides every FueliX request and is used for discovery. Any config layer that sets plugin options, including a project config, can point that key at another host, or at plain `http://`.
- **Fix:** send the override key only to `https://api.fuelix.ai`, unless an explicit opt-in option is set. Reject non-https values. Log the effective base URL when it is not the default.
- **Severity:** I rate this medium only if project configs can set plugin options without a trust prompt. If they cannot, it is low.

### Low

1. **Abort listener leak.** `src/telemetry/index.ts:59-68,270`: `delay()` adds an abort listener on every resubscribe and never removes it. Over days of repeated stream ends, listeners pile up and Node can print a MaxListeners warning. Fix: use `{ once: true }` and remove the listener when the timer fires.
2. **Two sets grow without limit.** `segments.ts:67,98`: `titles` loses an entry only on `session.deleted`. `ownership.ts:70`: the `reported` set never shrinks. Both stay small, but they grow for the life of the process. Fix: cap them the same way as `setBounded`. Title files under `transcripts/` are also never deleted.
3. **Wrong title type.** `segments.ts:180` writes OpenCode's automatic title as `custom-title`. td-telemetry (`lib/transcript-title.mjs:19-20`) also reads `ai-title`, and `custom-title` takes priority over it. Fix: write `ai-title` for automatic titles, and `custom-title` only for titles the user sets.
4. **One bad catalog entry can break the model list.** `index.ts:140-149` and `catalog.ts:21-26`: the provider transform has no try/catch, and `validEntry` checks only `provider`, `kind` and `name`. A non-array `costTiers` or `input` throws inside the provider fold. A non-integer limit breaks the `Schema.Int` encode for `GET /api/model`, which empties the model picker. Fix: validate numeric and array fields in `loadCatalog`, and wrap each model build in try/catch.
5. **Partial setup can leave providers without auth.** `index.ts:139-167`: if the transform registers but a hook registration throws, the providers exist with no auth hook. Fix: register the auth hooks before the provider transform, or dispose the transform when hook registration fails.
6. **Keys are read once.** Keys are resolved only at setup. Discovery keeps the old key after a `/connect` rotation and gets HTTP 401. The model list also stays on the cache or catalog until restart when `/connect` happens after boot.
7. **Telemetry turns off without notice under GUI launches.** `options.ts:139`: `node` comes from `PATH`. OpenChamber started from Finder often has no Homebrew or nvm `PATH`, so telemetry is off with one log line. Fix: also probe `/opt/homebrew/bin/node` and `/usr/local/bin/node`, and document `telemetry.node`.
8. **Grandchildren can outlive the hook timeout.** `process.ts:42-50`: SIGKILL stops only the `node` child. Any `git` or `gh` processes that the td-telemetry hooks start keep running. Fix: spawn with `detached: true` and kill the process group with `process.kill(-pid)`.
9. **Every FueliX request is copied in memory.** Because any `http.request` hook is registered, OpenCode clones each request body (`model-request.ts:348-353`). That means a second in-memory copy for multi-MB contexts. The built-in azure provider pays the same cost. Accept it, or note it.
10. **Unhandled timer.** `telemetry/index.ts:160-165`: the timer is not cleared when `session.get` rejects. It is unref'd, so the only effect is cosmetic.

### Checked and sound

- **Hook safety:** the `http.request` and `prompt` callbacks are synchronous and wrapped in try/catch. `prompt` only queues work. No path I traced gives an unhandled rejection: `discover`, `serial`, transport `flush`, segment chains, `resetIdle` and the event loop all catch.
- **Timers:** the refresh interval and the telemetry timers are unref'd, and the discovery timeout is cleared. Discovery calls `provider.reload()` only when the IDs change, and reload re-runs transforms, not setup, so it cannot loop.
- **Key handling:** provider info has no `apiKey`, `headers` or `body`. Discovery errors remove the key from messages. `execFile` runs `/usr/bin/security` with no shell, and failures return fixed messages with no stdout.
- **No key fallback leak:** `enabled` without a credential gives `Auth.none`. Packages therefore do not fall back to `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. The `env` method on the `fuelix` integration makes `FUELIX_API_KEY` a real connection.
- **Test fixtures** hold only fake keys. `migrate-config` writes its output with mode `0600`.
- **Transport:** `fuelix-openai` does not use WebSocket. OpenCode sets that only for `providerID === "openai"`, so the HTTP hook covers every FueliX session request.
- **Event routing:** location-scoped events, including `permission.*`, carry their location and are filtered per instance (`bus.ts:507-527,726-741`). Ownership is needed only for directory aliases.
- **Cost and tokens:** `cost_usd` is the step event's `Money.USD`, a plain number, never computed by the plugin. `output_tokens = output + reasoning` is correct, because OpenCode stores visible output and reasoning apart (`session/usage.ts:11-19`). The input and cache fields map one to one.
- **Telemetry privacy:** records hold only IDs, names, counts, durations and costs. The prompt hook never reads `prompt` or `metadata`. Tool input and output are never read. Hook stdin holds only `session_id`, `cwd`, `transcript_path` and the event name.
- **Child processes:** argv is fixed, there is no shell, timeouts use SIGKILL, stdout is capped, and every `error` event has a listener. The title file uses directory mode `0700` and file mode `0600`, and the session-ID regex blocks path traversal.
- **Memory:** the Mapper maps are capped at 5000 entries, and the transport queue at 1000.
- **Variants:** the port matches `variant.ts` for the three packages, including Opus 4.5 manual thinking, 4.6 defaults, the 32k Anthropic budget ceiling and the `always` filter. Variants are recomputed after the upstream limit is filled in.
- **Registry:** `editor.add` with a fresh model array on every fold is safe with OpenCode's WeakMap index.
