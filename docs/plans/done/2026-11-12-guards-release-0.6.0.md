# TD-Plugin guards release readiness 0.6.0

The user approved opening and merging the pull request, bumping the version, and publishing the tag and GitHub release.

## Work

- [x] Commit the completed guards work in its separate worktree.
- [x] Integrate the current main branch, including Jev and the combined extension installer.
- [x] Set the root and extension package versions to 0.6.0.
- [x] Preserve the bundled plugin, standalone extension folder, new service assets, and packaging checks.
- [x] Verify that Jev decisions cannot override active guards.
- [x] Run the final merged-state build, tests, typechecks, and package checks.
- [x] Open and link the pull request.

GitHub records delivery through [PR #6](https://github.com/fsodanogm2dev/td-opencode-plugin/pull/6) and the
`v0.6.0` tag and release. This plan records implementation and release readiness; merging and publication follow
the user's approval and the final PR checks.

## Boundaries

Keep the main checkout's uncommitted changes untouched. Do not alter the user's OpenCode configuration or install
the extension in the live app. Use fake credentials and isolated servers for integration checks.

## Evidence

The feature verification is recorded in `docs/plans/done/2026-11-12-td-plugin-guards.md`. The release needs fresh
verification because main now includes Jev and a bundled OpenCode plugin. The release must retain both features.

Guards register before Jev. Guard-denied shell commands must reach neither the TypeSafe safety API nor an approval
prompt. The source and bundled plugin profiles need the same ordering tests. CI must reject stale committed bundles
after a rebuild, not silently repair them.

## Final merged-state verification

Verified code head: `87f4fd2492015e439c61857dd4fa12921c5fb516`, including main's 0.5.1 gateway and redaction patch.
All commands exited 0. Evidence is in
`/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/td-plugin-0.6.0-final-v051/summary.json`.

- `bun run test`: 1,219 passed (`unit.stderr.log`).
- `bun run extension:test`: 258 passed (`extension-test.stderr.log`).
- `bun run test:integration`: 96 passed, 1 live-usage skip, 0 failures (`integration.stderr.log`).
- Root and extension typechecks, combined build, committed-bundle freshness, and both SDK package checks passed.
- Root and child dry-run packages contain 64 and 7 files respectively. Both report version 0.6.0.
- The actual shipped service passed authentication, CRUD, read-only session proxy, and confirmed recovery under Node 24.
- All 261 tracked input hashes and the four committed bundle hashes remained unchanged during verification.

Source and bundled-plugin tests establish that guard-denied commands make no Jev safety request. The real isolated
server tests establish denial without an approval prompt and normal Jev review for an unrelated allowed command.
No live FueliX or TypeSafe requests, paid generation, user configuration edits, or live app installation were performed.
