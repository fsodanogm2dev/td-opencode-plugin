# TD-Plugin extension and execution guards

Build this work in branch `omos/td-plugin-guards`. Preserve the uncommitted status-extension work in the main checkout.

## Requirements

- Name the extension **TD-Plugin extension**.
- Create guard drafts from plain-text requests and show their meaning before the user enables them.
- Keep guard definitions across projects. The user can enable, disable, and delete them from the extension.
- Keep definitions separate from active execution policies and permanent OpenCode configuration.
- Default activation to a session, with no expiry unless the user chooses one.
- Offer activation for the complete current request, including its subagents, until completion or cancellation.
- Show active guards and a user-controlled release action.
- Deny matching actions before execution, regardless of ordinary approvals or auto-approval.
- Return a clear tool error without repeated approval prompts. The agent can continue other work.
- Let subagents inherit active guards. Do not expose removal as a model tool.

## Feasibility gate

Verify the OpenCode V2 execution hooks, descendant-session identity, request lifecycle, and trusted extension transport
before selecting the implementation. A prompt instruction is not enforcement.

Git-command matching is a convenience guard. It cannot reliably identify commits hidden in arbitrary scripts.
The plugin and the agent run as the same operating-system user; database access and local-process control require a
separate threat assessment. Do not describe a UI-only API as an operating-system security boundary.

SQLite is a storage candidate. Verify compatibility between the OpenCode plugin runtime and OpenChamber's desktop
service runtime before selecting a shared database implementation. Generated rules should be constrained data,
not executable code, arbitrary SQL, or instructions that alter permanent configuration.

## Work

- [x] Create a separate worktree and branch.
- [x] Seed the completed status extension and setup explanations into this worktree.
- [x] Verify execution hooks and approve a feasible architecture.
- [x] Rename the extension.
- [x] Implement persistent definitions, temporary activations, and pre-execution enforcement.
- [x] Implement guard drafting, preview, enable/disable/delete, and active-status controls.
- [x] Verify inheritance, cancellation, expiry, denial errors, approval precedence, and persistence on isolated servers.
- [x] Verify the extension and document actual guarantees and limits.

## Evidence path

Use fake sessions and injected storage to test policy evaluation. Use isolated OpenCode servers to establish that denied
actions do not execute even when approvals would allow them. Exercise a root session and its subagent, the complete
request lifecycle, explicit release, and expiry selected by the user. Verify disabled rules permit unrelated work.
Use mocked extension hosts for controls and inspect rendered previews. Run repository and extension checks after
reconciling writer lanes. No tests may change the user's OpenCode configuration or use live credentials.

## Runtime feasibility evidence

The isolated probe in `test/integration/guard-feasibility.test.ts` passed 4 tests with 28 assertions on OpenCode 2.2.5.
The permission evaluation hook received shell actions already marked `allow`. Denial prevented the marker-file
side effect, returned `permission.rejected` with the supplied message, and allowed the agent to continue other work.
A built-in `subagent` session received its own evaluations and linked back through `parentID`.

The probe also observed execution start, success, and user-interruption events. Background descendants, cascaded
cancellation, failed executions, and arbitrary MCP/Code Mode tools remain outside this evidence.
Artifacts: `/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/guard-feasibility-final/`.

## Approved approach

The user selected plugin-level guards. The permission evaluation hook enforces the deny decision; model reasoning
does not decide whether the rule applies. Rule generation produces constrained data for the user to inspect.

Guard intent has one writer: an authenticated extension service. It serializes operations under a cross-process lock
and writes the global JSON store atomically. The panel does not write whole store documents. The plugin reads intent
and records execution-lifecycle facts separately. This avoids lost updates from several frames or clients.

Session scope is the default. Request scope is best effort because the API has no run identifier. Uncertain completion
retains the guard; it must not be mistaken for a successful release. Linked subagents inherit guards. Independently
dispatched sessions without a parent link are outside that inheritance.

The service runs with the user's operating-system privileges and needs approval at installation. The model has no
guard-management tool. Same-user tampering, later plugins that change permission decisions, hidden script operations,
and tools that do not request permission are outside this guard's security guarantee.

## Final verification

All commands below exited 0 on the reconciled worktree. Logs, exact commands, exit records, and input fingerprints
are in `/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/td-guards-final/try2/`.

- `bun run test`: 701 unit tests passed (`unit.stderr.log`).
- `bun run typecheck` and `bun run extension:typecheck`: passed.
- `bun run extension:test`: 258 tests passed (`extension-test.stderr.log`).
- `bun run extension:build` and `bun run extension:check`: three bundles built; SDK checker accepted the package.
- `bun run test:integration`: 52 passed, 1 live-usage test skipped (`integration.stderr.log`). This includes all 17 guard integration tests.
- `bun pm pack --dry-run` in `extension/`: seven shipped files, with no development sources (`package-list.stdout.log`).
- The actual shipped `extension/service/main.js` passed authenticated HTTP controls and recovery under Node 24.22.2 (`shipped-node-smoke.stdout.log`).
- Nine lifecycle boundary readings matched backend, service, and UI decisions (`seams.stdout.log`).
- `git diff --check`: passed.

The parent checked all 171 recorded input fingerprints and the three bundle hashes; all matched. The final code
review cleared the mixed-observer completion case, persisted lifecycle authority, recovery, and ambiguous mutation
outcomes. Narrow dark and light screenshots passed visual review, including global-reset confirmation.

No live FueliX requests, paid generation, user configuration edits, extension installation, or commits were performed.
Actual Electron host execution and live Small Model drafting remain unverified. Background descendants, cascaded
child cancellation, and lost-stream handling have unit coverage; the normal linked-subagent request lifecycle has
isolated-server coverage. Reused subagent-session completion is not covered by a real-server test.
