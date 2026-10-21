# Code review before release

An independent review of the plugin source ran on 2026-10-20 from 00:21 to 00:30. The latest commit at that time was
`6fbf40c`. The reviewer was the OpenCode `oracle` agent on `fuelix-anthropic/claude-opus-5-5` (session
`ses_ea8ac2437ffem5O04rMrFIpedV`). It read the source, checked each OpenCode behavior it cites against the OpenCode
v2.0.32 source, and ran nothing. It found no blocker, 2 high, 4 medium, and 10 low findings. The table below lists the
findings that apply to the current code. The full review text is in this file at commit `26b5930`.

Plan: [`docs/plans/done/2026-10-19-fuelix-catalog-usage.md`](../plans/done/2026-10-19-fuelix-catalog-usage.md),
section "Review decisions".

## Resolution

| Finding | Resolution | Commit |
| --- | --- | --- |
| H1. `/api/generate` and `ctx.generate.text` get no FueliX auth | Documented, not worked around (D17): README, "FueliX key", "Known limitation" | `c8e30bc` |
| H2. Old FueliX provider blocks silently undo D2 | One warning per process that names the provider and the field (D16) | `c8e30bc` |
| M2. Slow setup per location; a missed Keychain read is never retried | Process-wide Keychain memo with a 5-minute retry | `c8e30bc` |
| M3. Discovery accepts any non-empty list | A result that drops more than 30 % of the IDs, or every model of a provider, is rejected | `c8e30bc` |
| M4. `fuelix.baseURL` can send the key to any host | A custom base URL needs `TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL=1` and `https` (D14) | `c8e30bc` |
| L4. One bad catalog entry can break the model list | Invalid fields are dropped; each model build has its own try/catch | `c8e30bc` |
| L5. Partial setup can leave providers without auth | Auth hooks register before the provider transform | `c8e30bc` |
| L6. Keys are read once | Keys are resolved again on every discovery cycle | `c8e30bc` |
| L9. Every FueliX request is copied in memory | Accepted (D18) | — |

D13 (remove `FUELIX_API_KEY` from agent shell environments) does not come from a finding of this review.
