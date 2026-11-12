# Combined extension release preparation

The user approved one combined OpenChamber package and a PR, merge after checks, tag, and GitHub beta release for v0.4.0.

- [x] Verify the supported bundled-plugin installation flow and existing release conventions.
- [x] Add the root extension manifest and built server-plugin bundle without changing the standalone source entry.
- [x] Clarify provider activation and the three request formats in the panel.
- [x] Document combined installation, migration, defaults, custom-option limits, and permissions.
- [x] Extend CI to build, test, and validate both package forms.
- [x] Reconcile writers and validate the final release files.

## Boundaries

OpenCode cannot silently install an OpenChamber extension. OpenChamber asks the user to approve loading the bundled
plugin and reading reports. Do not edit live user configuration. Do not commit unrelated `.gitignore` or `.ignore`
changes. Built panel and server-plugin JavaScript belong in this release because OpenChamber does not compile packages.

## Verification

Use fake contexts and keys to import the built server bundle and check model/catalog registration, auth hooks, default
report writing, and custom-option parsing. Keep the default-writer home isolated. Run root and extension typechecks,
unit tests, build, and SDK validation for the combined root and status-only child. Inspect changed CI and use its green
PR checks as the release gate. Tag the exact merged commit; do not move or overwrite a tag.

## Evidence

The frozen root and extension dependency installs, `bun run build`, both typechecks, `bun run test`,
`bun run extension:test`, `bun run extension:check`, and `git diff --check` exited 0. Root unit tests passed 550 cases;
extension tests passed 65. Both manifests passed the SDK checker. The generated plugin matched its source.

Logs and exact exit statuses are in
`/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/release-0.4.0-checks/`.
Packaging dry-runs included the required assets and no development dependencies. Frozen installs changed neither lockfile.

## Approved publication sequence

Open and link a PR against `main`. Wait for CI, merge it, tag that merge commit as v0.4.0, and publish a GitHub beta
release. Publication remains separate from this completed package-preparation plan.
