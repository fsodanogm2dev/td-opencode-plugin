# Jev verification

## Contract sources

The implementation uses the pinned `@opencode/plugin@2.0.32` types and runs integration tests on OpenCode 2.2.5.
These sources describe the contracts; the test results below establish runtime behavior.

- [`permission.hook("evaluate")`](https://github.com/anomalyco/opencode/blob/v2.0.32/services/www/src/docs/content/build/plugins/index.mdx)
  receives a mutable `effect` and `message`. Configured denials are final. The Jev hook only escalates `allow` to `ask`.
- Installed `node_modules/@opencode/plugin/dist/promise/permission.d.ts` defines `action`, `resources`, `metadata`,
  and `source`. It does not identify whether an allowance came from a saved approval. The implementation must not
  add an approval cache that bypasses destructive checks.
- Installed `tool.d.ts` defines completed results as `Tool.Result` and failures as `Tool.Error`.
  `node_modules/@opencode/schema/dist/tool.d.ts` permits string content or an array of text and file parts.
- Installed `session.d.ts` and `node_modules/@opencode/ai/dist/schema/messages.d.ts` define context messages as
  `role`, optional `id`, and `content`, and system parts as `{ type: "text", text, ... }`. Auxiliary requests have
  separate hooks; the Jev context hook does not register for titles or compaction.
- Installed `node_modules/@opencode/plugin/dist/promise/adapter.js` wraps permission and session hook promises as
  Effect defects on rejection. Hooks must catch their errors and apply their explicit fallback policy.
- The permission event is `permission.asked`. Reply with
  `POST /api/session/{sessionID}/permission/{requestID}/reply` and `{ "decision": "once" }` or `"reject"`.
  The tests do not create saved approvals.

TypeSafe documents the request and response at [System One](https://api.typesafe.ai/openapi.json).
The request contains `model`, `state`, and named `questions`. Noul probabilities are between zero and one.
Choice answers must name a supplied option. Scores must be finite and within the supplied level range.
[The model reference](https://docs.typesafe.ai/models) lists `jev-1.14.0`, released October 14, 2026, and permits
versioned IDs even when only aliases appear in `/v1/models`.

## Isolated probe observations

The scripted gateway and isolated server in `test/integration/jev-helpers.ts` exercise the actual V2 shell tool.
Probes on OpenCode 2.2.5 established these shapes before the decision hooks were connected:

- Permission resources contain scanner-produced subcommands. A redirected `pwd` command can appear as only `pwd`.
  Safety must retain the complete command from `tool.execute.before`, keyed by the tool call's ID.
- Hook order is tool-before, shell-before, permission evaluation, and tool-after. A permission source's `id` matches
  the tool call ID. Rejecting a request leaves an aborted tool state without executing the command.
- Shell content is an array of text parts. The exit-code line is a separate part. `result.output.output` duplicates
  the first text part. Compression must update both copies and preserve the exit and metadata.
- The observed shell result does not expose a managed full-output path, including when `truncated` is true. A new
  protected log therefore stores only the available hook output, not text OpenCode omitted.
- Context messages include IDs on user and assistant messages. Title requests run through separate title hooks.
- Native configuration uses ordered `permissions` arrays. The tests use pattern denials because a blanket denial
  can remove the shell tool before the permission hook runs.

## Final checks

All commands below exited 0 on Bun 1.4.0. OpenCode integration tests used version 2.2.5.

| Command | Evidence |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` completed without errors. |
| `bun test` | 1,180 passed, 1 skipped, 0 failed; 1,181 tests across 59 files, 6,095 assertions. This command scans all suites, not only unit tests. |
| `bun run extension:typecheck` | Extension `tsc --noEmit -p tsconfig.json` completed without errors. |
| `bun run extension:test` | 65 passed, 0 failed across 5 files. |
| `bun run extension:check` | The bundled plugin is up to date. Both status-only and combined SDK checks report that the package is ready to install. |
| `env -u FUELIX_API_KEY -u TYPESAFE_API_KEY bun run test:integration` | 71 passed, 1 skipped, 0 failed; 72 tests across 9 files, 698 assertions. |

The skipped suite is live FueliX usage parity. `test/integration/live-usage.test.ts` requires `TD_LIVE=1` and a
non-empty `FUELIX_API_KEY`; the integration command explicitly removes that key. Jev tests have no skip conditions.
Passing-test names are suppressed in the captured output. The all-green totals establish that the enabled assertions
ran; individual assertions are available in the source files below.

- [`test/integration/jev-plugin.test.ts`](../../test/integration/jev-plugin.test.ts) checks real permission requests,
  rejection before execution, repeated destructive checks, full-command redirections, upstream failures, existing
  permission rules, key scrubbing, clean failure summaries and private logs, sensitive output preservation, each
  shadow point, unchanged primary/title requests, and credential exclusion from exposed metadata and plugin files.
- [`test/unit/jev/`](../../test/unit/jev/) covers malformed answers, credential deadlines, cache isolation, executable
  redaction, oversize rejection, actual HTTP redirect refusal, private paths, rotation, and disposal.
- [`test/unit/packaging/extension-plugin.test.ts`](../../test/unit/packaging/extension-plugin.test.ts) verifies source
  and bundled-plugin parity. Default-off behavior, Jev 1.14.0 hooks, safe credentials, protected telemetry, and FueliX
  status reports agree. The status panel build is unchanged.
- [Source CI](https://github.com/fsodanogm2dev/td-opencode-plugin/actions/runs/43265950284) passed root and extension
  build, type, unit, and SDK package checks.

The verified server bundle has SHA-256
`a0123b0f0fa23fb55d4ce8a4ff4bb2b6623d7e9ac52b474f74b45e7c73d7585a`.
Local command logs and explicit exit-status files are in
`/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/jev-final-20261112-140752-66042/`.
Interrupted tool-timeout attempts are not verification evidence.

## Review decisions

Independent security review found no high-severity defect. Its medium findings are addressed by preserving shell
expansions during redaction, restricting custom Keychain services, and leaving output unchanged when redaction
alters debugging values. Assigned privacy and lifecycle fixes have regression tests. No review blocker remains.
The integration preserves the status extension and does not change live user configuration.

## Limits

- No real TypeSafe credential was available. Live Jev authentication, account access, latency, and calibration are
  unverified. Official schema checks and local mock responses do not establish live-service behavior.
- Shell checks are not a security boundary. Patterns are incomplete, and Jev can misclassify commands.
- Only hook-visible output can be preserved; text OpenCode already omitted cannot be recovered.
- Log retention is time-based, with no aggregate log-size cap. Telemetry has its separate 10 MiB cap.
- HTML structure, IDs, anchors, and local links passed static checks. Browser appearance and Mermaid rendering were
  not verified. No measured token or billing savings are claimed.
