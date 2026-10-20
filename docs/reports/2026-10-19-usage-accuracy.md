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

`test/integration/live-usage.test.ts` ran on 2026-10-20 against the real gateway. An isolated OpenCode server loaded
the plugin, and a recording proxy between OpenCode and FueliX stored each FueliX `usage` object. Each model received
two prompts, so the second call could use the prompt cache. The table compares each agent call with the
`session.step.ended` event that OpenCode emitted for it. Cost is USD; OpenCode output includes reasoning tokens.

| Model | Call | Input (FueliX / OpenCode) | Output (FueliX / OpenCode) | Cache read | Cache write | Cost (FueliX-derived / OpenCode) |
| --- | --- | --- | --- | --- | --- | --- |
| `fuelix-openai/gpt-5-nano` | 1 | 4418 / 4418 | 117 / 117 | 0 / 0 | 0 / 0 | 0.0002677 / 0.0002677 |
| `fuelix-openai/gpt-5-nano` | 2 | 84 / 84 | 113 / 113 | 4352 / 4352 | 0 / 0 | 0.00007116 / 0.00007116 |
| `fuelix-anthropic/claude-haiku-4-5` | 1 | 3 / 3 | 4 / 4 | 0 / 0 | 6115 / 6115 | 0.00766675 / 0.00766675 |
| `fuelix-anthropic/claude-haiku-4-5` | 2 | 3 / 3 | 4 / 4 | 0 / 0 | 6129 / 6129 | 0.00768425 / 0.00768425 |
| `fuelix/gemini-2.5-flash-lite` | 1 | 4169 / 4169 | 2 / 2 | 0 / 0 | 0 / 0 | 0.0004177 / 0.0004177 |
| `fuelix/gemini-2.5-flash-lite` | 2 | 140 / 140 | 2 / 2 | 4038 / 4038 | 0 / 0 | 0.00005518 / 0.00005518 |

"FueliX-derived" cost applies the catalog price to the FueliX `usage` object; FueliX itself returns no cost. Every
field matched, every cost matched within `1e-9` USD, and every FueliX request carried `Authorization: Bearer` and
returned HTTP 200 (including Anthropic). `test/integration/wire-replay.test.ts` replays the recorded streams offline
and asserts the same values, so a regression shows without a FueliX key.

## Other findings

- **Session totals include title generation.** OpenCode also asks the session model for a title. The title call has no
  `session.step.ended` event, but its cost is in the session total. With `gpt-5-nano`, the title call used 944 output
  tokens (reasoning), more than both agent calls together.
- **Anthropic prompt cache across user turns.** In the probe, the second user turn wrote a new 6,129-token cache entry
  instead of reading the 6,115-token entry that the first turn wrote. FueliX itself keeps the cache: three identical
  direct requests to `/v1/messages` with a 9,902-token cached system block returned cache write 9,902, then cache read
  9,902 twice. So the prefix that OpenCode sent changed between the two turns. Real sessions from the last 14 days still
  read the cache 14 to 23 times per write (`claude-opus`, `claude-sonnet-5-5` in `session_v2`), which suggests that the
  cache works inside a turn's tool loop and is rewritten when a new user turn starts. This is a cost-efficiency issue in
  OpenCode's request assembly, not a reporting error. It is listed as a follow-up in the plan.
- **Chat Completions path.** The `fuelix` provider sends requests to `https://api.fuelix.ai/chat/completions` (no
  `/v1`). FueliX accepts that path.

## Result

- Before the plugin, eight FueliX models showed `$0` because they had no price, and seven of them also had the default
  limits, so the context percentage was wrong for them. With the plugin, every FueliX chat model has a price and limits.
- For the models measured, the tokens and cost in OpenCode, and therefore in the TUI and in the OpenChamber session
  panel, equal the FueliX usage priced at the catalog rate.
- Displayed turn costs below $0.005 round to `$0` in the OpenChamber panel. That is display rounding, not missing data.
