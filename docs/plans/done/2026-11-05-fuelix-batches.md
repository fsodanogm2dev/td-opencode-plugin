# Fuel iX batch workflow

## Steps

- [x] Confirm the OpenCode V2 tool/storage contract and the Fuel iX batch/pricing evidence.
- [x] Implement the batch client, protected artifacts, and persistent session-scoped job history.
- [x] Register submission, listing, inspection, status, cancellation, and collection tools.
- [x] Document the workflow and its API, cost, and presentation limits.
- [x] Verify mocked lifecycle, isolation, secret handling, failure recovery, and existing behavior.

## Scope

Extend this repository only. Preserve the existing uncommitted changes and interactive provider behavior.
Use the existing credential resolver. Send Bearer authentication only in HTTP requests. Never persist or print a real key.

The user's request to submit a batch is authorization. Do not add a second approval prompt.
Submission reads a request file and returns promptly with a batch ID. Send unprefixed Fuel iX model IDs.
Keep persistent history scoped to the originating session with OpenCode plugin storage.
Expose requested work, remote processing counts, elapsed time, cancellation, collection status, and cost.
Keep large requests and results in protected local artifacts, not tool output. Match results by custom_id and keep failures separate.
Never retry a submission automatically after an ambiguous transport failure. Keep a durable record for reconciliation.

Status checks and result collection are on demand. Do not add a worker, timer, dashboard server, or OpenChamber changes.
Ordinary OpenCode tools are the shared interface. OpenChamber can render their bounded output using its existing inline presentation tools; plain OpenCode can show text.

Report actual billed cost only from a documented billing field. Use a labeled estimate only with evidenced batch prices and usage. Mark unknown cost unavailable; never invent Fuel iX prices or infer an unverified discount.

## Verification

Baseline: bun test passed 218 tests with 1 skipped; bun run typecheck passed before this work.

The client lane owns mocked HTTP checks: paths, Bearer auth, request IDs, response validation, timeouts, no POST retries, safe result URL handling, and costs.
The workflow lane owns artifact permissions, persistence/restart behavior, session isolation, concurrent state updates, safe collection, out-of-order results, and partial failures.
The integration lane owns real OpenCode tool registration and originating-session context, using only isolated servers and a mock Fuel iX gateway.
The parent owns final reconciliation, bun test, bun run typecheck, and git diff --check.

No paid live batch is authorized by this implementation request. Authenticated production behavior and billing cannot be established by mocks. Document that limitation without blocking implementation.
