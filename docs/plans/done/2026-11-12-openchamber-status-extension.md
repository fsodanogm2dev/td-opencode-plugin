# OpenChamber status extension

Show what the FueliX plugin configured and the result of its latest model-discovery check. The panel must use recorded results. The separate `doctor` command is outside this scope.

## Work

- [x] Inspect the plugin lifecycle and the supported OpenChamber bridge.
- [x] Add a versioned status report with configuration, timestamps, check outcomes, and model changes.
- [x] Build a read-only OpenChamber rail panel for the report.
- [x] Document building, installing, report permissions, and stale-report limits.
- [x] Validate the report lifecycle, panel, manifest, unit tests, and TypeScript.

## Boundaries

The report contains no credentials, request headers, raw configuration, or arbitrary error messages. It lives in the plugin's own report directory, outside OpenCode's configuration and data. Reports identify their location and when they were written. A report is a recorded snapshot, not proof that the plugin is currently running.

The extension reads reports through the SDK file API. It needs no network integration, local service, session control, or bundled copy of the plugin. The panel does not change configuration or trigger discovery.

## Verification

Use fake keys, clocks, fetch responses, and an injected report writer for lifecycle tests. Cover unchanged results, additions, removals, missing credentials, rejected results, failures, and report-write failures. Verify real atomic writes only in a temporary directory. Check that no known test key appears in reports.

Validate the built extension with the SDK checker. Exercise panel states with a mocked host and fixture reports. Run the repository unit tests and typecheck after reconciling both implementation lanes. A live installation remains a separate approval step; do not alter the user's OpenCode configuration or data.

## Evidence

All commands below exited with status 0. Verification logs are in
`/private/var/folders/7q/nps8fpbs6r9d1tn79n28r1c40000gn/T/opencode/verify/`.

- `bun run test`: 540 unit tests passed (`9-root-unit.log`).
- `bun run extension:test`: 54 tests passed (`4-ext-test.log`).
- `bun test`: 629 passed, 1 live-usage test skipped, 0 failures (`1-test.log`). This includes isolated integration tests.
- `bun run typecheck` and `bun run extension:typecheck`: passed (`2-typecheck.log`, `3-ext-typecheck.log`).
- `bun run extension:build`: produced the self-contained panel IIFE (`5-ext-build.log`).
- `bun run extension:check`: SDK checker accepted the package (`6-ext-check.log`).
- A temporary cross-boundary test checked report serialization/parsing and Node/browser SHA-256 agreement: 2 tests passed (`8-cross.log`).
- `git diff --check`: passed (`7-diffcheck.log`).

Panel screenshots covered dark and light themes, error states, and a 300-pixel rail. The visual review found no blocking
defects. The extension's plug-and-check icon passed small-size and theme-contrast review. The icon update also passed
the SDK checker and the four-file package check.

The development OpenCode service hot-loaded the plugin and wrote snapshots in `~/.td-opencode-plugin/status/`.
Tests used injected writers or isolated temporary home directories. No user OpenCode configuration was changed.
The agent did not install the extension. A real desktop installation was not part of the automated verification.
