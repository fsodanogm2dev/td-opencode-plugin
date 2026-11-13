# Persistent model-change history

The latest model check and the model-change history describe different facts. An unchanged check must not erase
earlier additions or removals. History must survive a plugin reload or restart.

## Work

- [x] Verify the current announced aliases and the existing report lifecycle.
- [x] Define a durable change record and safe persistence boundary.
- [x] Record actual applied model changes without losing events to snapshot coalescing.
- [x] Show history separately from the latest check, with timestamps and complete added/removed lists.
- [x] Keep old reports readable and remove development-only guard status wording.
- [x] Verify restart, unchanged checks, rapid changes, duplicate observations, failures, and secret handling.
- [x] Document the history's start and limits; do not invent earlier timestamps.

## Boundaries

Do not change guard enforcement, the user's configuration, or live model registrations. Use fake model responses and
temporary directories in tests. Treat the supplied announcement as context, not as a recorded plugin event.

Only successful application counts as an applied change. Initial catalog or cache registration needs a distinct
baseline label. A failed provider reload must not appear as a completed model addition. Keep file writes nonfatal.

## Verification

Use injected clocks, fetch responses, and storage. Demonstrate that a recorded change remains visible after an
unchanged hourly check and after a fresh plugin setup. A slow snapshot writer must not drop two rapid change events.
Exercise concurrent observers, failed writes, rejected discoveries, and known-key redaction. Test old report fixtures
and history rendering without a paid model call. Reconcile writers before the final root and extension checks.

## Storage decision

The existing `fuelix/models` cache is shared in plugin-scoped OpenCode storage. History uses that same shared store,
with one key per fetched model-list observation. Separate keys avoid overwriting another observer's record.
Each location's status report projects the shared lists using that location's model options.

History timestamps refer to proxy-list fetches, including a valid cache's stored fetch time. A starting list is a
baseline, not a claim that every included model was newly added. The current live registry includes
`mistral-large-4` and `gemini-4-hydrogen`; their presence alone does not establish first-registration times.

The additive `modelHistory` field keeps report version 1 compatible. Storage retains up to 200 observations;
reports project up to 50 entries with explicit omission status. History persistence precedes the coalesced snapshot
write so rapid changes are not lost.

## Final evidence

All final product checks exited 0. Logs, exact commands, source fingerprints, and four bundle hashes are in
`/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/td-model-history-final/summary.json`.

- `bun run test`: 1,278 unit tests passed.
- `bun run extension:test`: 296 tests passed.
- Root and extension typechecks, combined build, plugin freshness, both SDK checks, and `git diff --check` passed.
- Relevant isolated FueliX and Jev/guard integration checks: 19 passed.
- The regenerated bundled plugin used real SDK storage scanning and pagination on isolated servers. Three lists
  survived new locations and a new server process using the same temporary data directory.
- Baseline, two changes, and a later unchanged chat round-tripped through the serialized report and UI timeline.
- Storage-failure retry tests preserve each list's original fetch time. An unrecorded current-run change remains
  visible in the panel until shared history covers it.
- All 221 recorded source fingerprints matched after verification. The test `.gitignore.bak` file was absent.
- Narrow dark and light timeline screenshots and the final focused code review passed.

No paid generation, live gateway tests, user configuration edits, or publication were performed. The implementation
is an uncommitted worktree change. Earlier v0.6.0 guard integration evidence remains valid for the unchanged guard
engine; its full integration suite was not repeated for this history change.
