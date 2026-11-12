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

Implementation and verification are in progress. This report will record final commands, exit statuses,
test counts, runtime observations, and live-service limitations before merge.
