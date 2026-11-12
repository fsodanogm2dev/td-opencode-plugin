# TD-Plugin guards release 0.6.0

The user approved opening and merging the pull request, bumping the version, and publishing the tag and GitHub release.

## Work

- [x] Commit the completed guards work in its separate worktree.
- [x] Integrate the current main branch, including Jev and the combined extension installer.
- [x] Set the root and extension package versions to 0.6.0.
- [x] Preserve the bundled plugin, standalone extension folder, new service assets, and packaging checks.
- [ ] Verify that Jev decisions cannot override active guards.
- [ ] Run the final merged-state build, tests, typechecks, and package checks.
- [ ] Open and link the pull request.
- [ ] Wait for required checks and merge the approved head.
- [ ] Publish tag v0.6.0 and the GitHub release at the merged commit.

## Boundaries

Keep the main checkout's uncommitted changes untouched. Do not alter the user's OpenCode configuration or install
the extension in the live app. Use fake credentials and isolated servers for integration checks.

## Evidence

The feature verification is recorded in `docs/plans/done/2026-11-12-td-plugin-guards.md`. The release needs fresh
verification because main now includes Jev and a bundled OpenCode plugin. The release must retain both features.

Guards register before Jev. Guard-denied shell commands must reach neither the TypeSafe safety API nor an approval
prompt. The source and bundled plugin profiles need the same ordering tests. CI must reject stale committed bundles
after a rebuild, not silently repair them.
