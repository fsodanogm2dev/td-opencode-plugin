# Jev 1.14.0 integration

The user approved implementation in a new worktree, a PR, merge after verification, and a version tag.
This release targets v0.5.0. The separate OpenChamber extension work reserves v0.4.0.

## Steps

- [x] Create `feat/jev-decisions` from `origin/main` in an isolated worktree. Preserve the other checkout.
- [ ] Verify the OpenCode V2 hook contracts and TypeSafe request format.
- [ ] Implement options, secure credentials, a bounded direct client, redaction, private storage, and telemetry.
- [ ] Implement shell safety checks and test-output compression.
- [ ] Implement skill and reasoning observations in shadow mode.
- [ ] Document the data flow, options, migration, limitations, and release.
- [ ] Run focused tests, reconcile the implementation, and review safety and lifecycle behavior.
- [ ] Run final unit, type, and isolated integration checks.
- [ ] Open and link the PR, wait for its checks, merge, and tag the exact merge commit.

## Scope

- Jev is disabled by default. Its model is pinned to `jev-1.14.0`.
- Call `https://api.typesafe.ai/v1/systemone` directly. No broker or runtime dependency.
- Resolve the TypeSafe key from Keychain, `/connect` (`typesafe-ai`), or `TYPESAFE_API_KEY`.
- Never read the legacy `jev.json` key. Never modify live OpenCode configuration or data.
- Preserve FueliX behavior. Keep Jev initialization and cleanup independent.
- Safety only escalates `allow` to `ask`. Existing `ask` and `deny` remain unchanged.
- Deterministic destructive-command checks always ask. Conservative read-only checks skip the API.
- Upstream errors and invalid decisions ask when `failClosed` is enabled. No key means no upstream checking;
  the documentation must describe this limitation.
- Never remember approval in a way that bypasses destructive-command checks.
- Compression is extractive, only replaces output with a shorter result, and retains access to the protected log.
  Redact recognized secrets before transmission and before writing any new log.
- Skill and reasoning points support `off` and `shadow` only. They do not change model requests.
- Category routing and context garbage collection are outside this release.
- Keep copied MIT notices for any material derived from `opencode-jev-plugin`.

## Evidence path

Foundation tests establish parsing, credential priority, endpoint restrictions, response validation, timeouts,
bounded caching, redaction, safe paths, telemetry rotation, and cleanup. Point tests establish safety polarity,
compression invariants, and unchanged shadow inputs.

Isolated OpenCode integration tests use temporary HOME and XDG directories, a project outside HOME, fake keys,
a scripted chat model, and a mock TypeSafe endpoint. They must show actual permission requests, failure escalation,
compressed history with a readable log, shell environment scrubbing, unchanged shadow requests, and no credentials
in exposed provider metadata or logs. Disable Keychain lookups in mock tests.

The coordinator owns the final `bun run typecheck`, `bun test`, and `bun run test:integration` checks. An independent
review owns the security and lifecycle assessment. API/model claims come from official documentation. A live TypeSafe
check requires an available private credential; if unavailable, document that limit without blocking mock verification.

## Evidence

Evidence and deviations will be recorded in `docs/reports/2026-11-12-jev-verification.md` before merge.
