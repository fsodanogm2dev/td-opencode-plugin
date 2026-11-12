# Jev decisions

Jev is a TypeSafe model that returns typed decisions and probabilities. It does not write code or explanations.
This plugin ports decision points from [opencode-jev-plugin](https://github.com/fsodanogm2dev/opencode-jev-plugin)
to OpenCode V2. It uses direct HTTPS requests, without a broker or a separate `jev.json` file.

Jev is disabled by default. Enabling it sends selected information to TypeSafe, outside FueliX. Check your
organization's data policy before enabling it on company projects.

## Enable

Store the TypeSafe key in the macOS Keychain, connect through `/connect` and select **TypeSafe**, or set
`TYPESAFE_API_KEY` in the OpenCode server environment. The Keychain service name is `typesafe-api-key`.
The resolver uses the first available key in that order. Do not put a key in plugin options.

Add `jev` to the options of your existing plugin entry:

The combined OpenChamber package uses default options, so Jev remains disabled there. To enable Jev with custom
options, use the standalone plugin and the status-only extension folder described in
[the installation guide](../README.md#standalone-opencode-plugin). Do not load the bundled and standalone plugin
at the same time. The status panel reports FueliX; Jev observations remain in its separate telemetry file.

```jsonc
{
  "package": "github:fsodanogm2dev/td-opencode-plugin#v0.5.0",
  "options": {
    "jev": { "enabled": true, "model": "jev-1.14.0" }
  }
}
```

With no TypeSafe key, upstream checks are unavailable. Local destructive-command checks still ask when safety is
enabled. FueliX continues to work. A key added through `/connect` takes effect after the resolver's five-second cache
expires. Keychain misses are retried after at least five minutes.

## Decision points

### Shell safety

The permission hook only changes `allow` to `ask`. It never grants a permission or removes a configured prompt or
denial. Destructive-command patterns request approval without an API call. Conservative read-only patterns skip
Jev. Other commands are evaluated with a typed probability of destructive behavior.

When the probability exceeds `riskThreshold`, OpenCode asks for approval. With `failClosed: true`, API timeouts,
HTTP errors, and invalid decisions also request approval. Setting `failClosed: false` keeps the existing permission
decision on those failures. A missing credential is not an upstream timeout; see **Enable**.

If the hook cannot recover the complete shell command, it cannot safely classify scanner-only resources.
With `failClosed: true`, that incomplete context also requests approval.

These checks are not a security boundary. Shell commands have the host user's authority. Keep restrictive OpenCode
permission rules for important resources. Jev can misclassify a command, and deterministic patterns are incomplete.
Non-interactive clients must handle permission requests. Saved approvals do not bypass Jev checks.

### Test-output compression

For long shell output that contains a test or build failure, Jev classifies the failure and estimates its probability
of being flaky. The plugin returns a shorter extractive summary with excerpts and access to the protected log.
The classification is an estimate, not a verified root cause. Compilers and tests still run normally.

On a failed classification, failed log write, or an output that would not become shorter, the plugin keeps the
original result. It also leaves output unchanged when redaction changes any value. This preserves debugging facts
such as token comparisons. It creates no new log for that output. Files attached to a tool result and its metadata
remain intact. Shadow classification uses redacted excerpts without writing a log. Redaction cannot identify every
secret; OpenCode's own history can still contain the original output.

The log preserves the output OpenCode supplied to the hook. OpenCode may already have shortened it; the plugin
cannot recover omitted text. Output above 4,194,304 characters (`MAX_REDACT_CHARS` in `src/jev/redact.ts`) is not
written or compressed.

### Skills and reasoning

These points support `off` and `shadow` only. Shadow mode records suggested skill selections and reasoning levels
without editing instructions, history, tools, or model options. It preserves the prompt sent to the primary model.
An `enforce` setting produces a warning and becomes `shadow`.

Skill observations require a catalogue larger than `maxSkills`. Reasoning observations skip models without
reasoning variants and sessions with an explicitly selected non-default variant.

Category routing and context garbage collection are not included. OpenCode V2 has no subagent category argument;
its normal compaction handles long histories.

## Options

```jsonc
"jev": {
  "enabled": false,
  "model": "jev-1.14.0",
  "baseURL": "https://api.typesafe.ai",
  "keychainService": "typesafe-api-key", // false disables Keychain lookup
  "scrubShellEnv": true,
  "telemetry": true,
  "points": {
    "safetyPreCheck": {
      "mode": "enforce",
      "timeoutMs": 1500,
      "riskThreshold": 0.2,
      "failClosed": true
    },
    "testCompression": { "mode": "enforce", "timeoutMs": 2500, "maxRawLength": 1200 },
    "skillPruning": { "mode": "off", "timeoutMs": 800, "maxSkills": 3 },
    "reasoningBudget": { "mode": "off", "timeoutMs": 800 }
  }
}
```

`off` skips a point. `shadow` evaluates without modifying behavior. `enforce` applies safety and compression
decisions. Invalid options fall back to defaults and produce warnings that do not contain the invalid value.

Custom endpoints require `TD_OPENCODE_ALLOW_CUSTOM_JEV_URL=1` in the server environment. HTTPS is required except
for loopback HTTP test servers. Redirects are not followed. Project options alone cannot redirect the key.

A non-default Keychain service requires `TD_OPENCODE_ALLOW_CUSTOM_JEV_KEYCHAIN=1` in the server environment.
The FueliX service `fuelix-api-key` is never accepted for TypeSafe. `keychainService: false` always disables lookup.
The default model is pinned to `jev-1.14.0`. You can explicitly select another versioned Jev model, `jev-latest`, or
`jev-preview`; aliases can change their underlying version without a plugin update.

## Data and credentials

Safety sends bounded command text. Compression sends bounded failure excerpts. Shadow points send the latest user
request; skill observations also send skill IDs and descriptions. The plugin redacts recognized secret formats
and the active TypeSafe key before transmission. It does not send the whole repository or transcript.

TypeSafe says it does not train Jev on customer requests or responses. Zero data retention is available to enterprise
customers; enabling this plugin does not establish that your account has it. See
[TypeSafe data handling](https://docs.typesafe.ai/models#data-handling).

The key is held in memory and used only in the client's Authorization header. It does not appear in provider
settings, provider headers, telemetry, or error messages. When Jev is enabled, `scrubShellEnv: true` removes
`TYPESAFE_API_KEY` from shell child environments. An agent running as your user can deliberately read credentials;
these controls limit accidental leaks.

Successful decisions are cached in memory for at most 60 seconds. The cache is bounded and separated by endpoint,
credential, and location. API failures are not cached. Each enforced API check adds a bounded wait.

## Storage

Telemetry and plugin-owned failure logs live under
`<XDG_DATA_HOME or ~/.local/share>/td-opencode-plugin/jev/`. Directories use mode `0700`; files use `0600`.
Symlinks are not followed. Telemetry contains decisions, modes, timing, counts, and error codes, without command,
prompt, or test-output text. Selected skill IDs are stored as hashes. Its two files are capped at 10 MiB combined.
Plugin-owned logs and temporary remnants older than seven days are eligible for cleanup. Logs have time-based
retention, not a total disk-size limit. OpenCode's own stored history follows OpenCode's retention policy.

Token figures derived from character counts are estimates. They do not establish billing savings or account for
prompt-cache costs. This release does not claim measured savings.

## Migrate from the standalone Jev plugin

Remove the legacy Jev plugin entry from OpenCode's `plugins` list. Store its key through one of the sources in
**Enable**, then add the `jev` options above. Review legacy point settings before copying them. This plugin does not
read legacy `apiKey` or `brokerSocket` options, or the key in `jev.json`.

After confirming the new integration works, stop any broker you started and remove the legacy configuration
containing the clear-text key. This repository does not change those files automatically.

## Verification

Unit tests cover the client, storage, redaction, and decision policies. Isolated OpenCode tests use fake credentials
and local mock endpoints. The [verification report](reports/2026-11-12-jev-verification.md) identifies tested behavior
and any limits. OpenCode V2 hook registration is required; the V1 `server()` hooks are not used.
