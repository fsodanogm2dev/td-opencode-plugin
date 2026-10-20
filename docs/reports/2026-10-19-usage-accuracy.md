# Usage accuracy in the TUI and OpenChamber (Phase 2 report)

Scope: OpenCode `v2.0.32`, FueliX gateway, measured on 2026-10-19. This report states which figures in the OpenCode
TUI and the OpenChamber session panel are accurate, which were wrong before this plugin, and how the plugin changes
them. Plan: [`docs/plans/pending/2026-10-19-fuelix-catalog-usage-telemetry.md`](../plans/pending/2026-10-19-fuelix-catalog-usage-telemetry.md),
Phase 2.

## How OpenCode computes cost

OpenCode stores tokens per model call and computes cost from the model's price entry
(`packages/core/src/session/usage.ts`, lines 11–35):

```text
cost = (input × price.input + (output + reasoning) × price.output
        + cacheRead × price.cache.read + cacheWrite × price.cache.write) / 1,000,000
```

`input` excludes cached tokens. A model without a price entry (`cost: []`) always costs `$0`.

## Recorded cost matches the formula

The six newest root sessions whose current model is `fuelix-openai/gpt-6-luna` were compared with the formula and
the configured prices (input 0.1, output 0.5, cache read 0.01, cache write 0.125 USD per 1M tokens). Source:
`session_v2` table of `~/.local/share/opencode/opencode.db`, read-only query.

| Session | Input | Output | Reasoning | Cache read | Cache write | Recorded USD | Formula USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ses_ea918d4c8f…` | 1,957 | 13,636 | 96,684 | 9,541,715 | 415,715 | 0.202737 | 0.202737 |
| `ses_ea8d90d2ef…` | 544 | 582 | 5,289 | 120,680 | 28,107 | 0.007710 | 0.007710 |
| `ses_eab945db6f…` | 578 | 2,419 | 7,143 | 509,960 | 193,461 | 0.034121 | 0.034121 |
| `ses_eab67ebccf…` | 688 | 5,737 | 21,257 | 8,309,777 | 290,965 | 0.133034 | 0.133034 |
| `ses_eab9676d1f…` | 10,247 | 8,158 | 65,822 | 6,099,085 | 878,158 | 0.208775 | 0.208775 |
| `ses_fa83aa98cf…` | 1,136,261 | 28,444 | 3,551 | 5,973,723 | 502,241 | 3.953065 | 0.252141 |

Five sessions match exactly. The sixth session changed models during its life: `session_v2.model` holds only the
current model, so its total includes calls billed at other models' prices. That row is not a pricing error.

## The `$0` in the OpenChamber screenshot

The panel showed a turn with 15.0K input tokens (97% from cache), 1.7K output tokens, and `Cost $0`. At `gpt-6-luna`
prices that turn costs about $0.001, which the panel rounds to `$0`. An earlier analysis attributed the `$0` to missing
prices; that was wrong for this turn.

Missing prices do cause `$0` for other models. Before this plugin, eight FueliX models had `cost: []` and default
limits (`context 200000`, `output 32000`) in the live registry (`opencode api get /api/model`). The plugin catalog
gives each of them a price from `fuelix/LLM-Inventory`:

| Model | Live registry before | Plugin catalog price (in / out / cache read / cache write, USD per 1M) | Plugin catalog limits |
| --- | --- | --- | --- |
| `fuelix-openai/gpt-6.0-sol` | `cost: []`, 200000 / 32000 | 2 / 10 / 0.2 / 0 | 1050000 / 128000 (from `gpt-6-sol`, same model) |
| `fuelix/gemini-3.5-flash-ca` | `cost: []`, 200000 / 32000 | 1.5 / 9 / 0.15 / 0 | 1000000 / 64000 |
| `fuelix/gemini-4-argon` | `cost: []`, 1048576 / 65536 | 2 / 10 / 0.1 / 0 | 1048576 / 65536 |
| `fuelix-anthropic/claude-haiku-5` | `cost: []`, 200000 / 32000 | 0.1 / 0.5 / 0.01 / 0.125 | 1000000 / 128000 |
| `fuelix-anthropic/claude-haiku-5-5` | `cost: []`, 200000 / 32000 | 0.1 / 0.5 / 0.01 / 0.125 | 1000000 / 128000 |
| `fuelix-anthropic/claude-opus-4-8` | `cost: []`, 200000 / 32000 | 5 / 25 / 0.5 / 6.25 | 1000000 / 128000 |
| `fuelix-anthropic/claude-opus-5-0` | `cost: []`, 200000 / 32000 | 5 / 25 / 0.5 / 6.25 | 1000000 / 128000 |
| `fuelix-anthropic/claude-sonnet-5-0` | `cost: []`, 200000 / 32000 | 2 / 10 / 0.2 / 2.5 | 1000000 / 128000 |

## FueliX wire facts that affect accuracy

- FueliX returns standard `usage` objects for Anthropic Messages, OpenAI Responses, and Chat Completions, including
  streaming responses. It returns no cost value in headers or body.
- When one model ID maps to several FueliX deployments, the plugin uses the highest list price (decision D8). Requests
  that FueliX routes to a deployment with a contracted rate cost less than the figure shown.

## Token parity per provider

Pending: the live probe (`test/integration/live-usage.test.ts`) compares each FueliX `usage` object with the tokens and
cost that OpenCode records for the same model call.
