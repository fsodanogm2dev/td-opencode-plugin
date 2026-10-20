# FueliX model registry: current configuration compared with the plugin

Measured on 2026-10-20. "Before" is the live registry of the author's OpenCode service (`opencode api get /api/model`),
built from the FueliX provider blocks in `~/.config/opencode/opencode.json`. "After" is the registry of an isolated
OpenCode server that loads only this plugin, with the same 108 live model IDs served by a mock `/v1/models`.
`scripts/compare-registry.ts` produced the tables. It reads names, prices, limits, input modalities, and variant IDs
only; it never reads provider or model `settings` or `headers`.

What the changes mean:

- **Removed models (13)**: embedding, image, speech, and transcription models. The chat model picker cannot use them
  (decision D3). Set `fuelix.includeNonChatModels: true` to register them again.
- **Changed prices (22)**: prices come from `fuelix/LLM-Inventory`, which FueliX uses for metering (decision D8). Eight of
  these models had no price before. When one model ID maps to several deployments, the highest list price is used:
  `gpt-4o` maps to the 2024-05-13 snapshot (5 / 15) and the 2024-11-20 snapshot (2.50 / 10), so its requests can cost
  less than shown.
- **Long-context tiers**: some prices have a second tier for requests with more than 200,000 input tokens. The
  inventory row `vertex_ai/claude-haiku-5-5@default` gives `claude-haiku-5` and `claude-haiku` a tier of 0.5 / 2.5,
  five times the base price, while the inventory's pricing note says that newer Claude models have no long-context
  premium. This value comes from the inventory unchanged; the inventory owners should confirm it.
- **Changed limits and input modalities (7 and 6)**: only models that had OpenCode's default limits and capabilities
  before, because the configuration gave them none. Models that the configuration describes keep its limits and
  modalities (decision D12).
- **Changed variants (24)**: models that do not reason (for example `gpt-4.1`, `gpt-4o`, Llama, Mistral) lose the
  reasoning variants that OpenCode added to every configured model (decision D7).
- **Prices for alias models can move with the alias**: `claude-haiku` (latest) now has the Haiku 5.5 price from the
  inventory, but it keeps the 200000 / 8000 limits from the configuration (decision D12).

| Measure | Count |
| --- | ---: |
| FueliX models before | 108 |
| FueliX models after | 95 |
| Models added | 0 |
| Models removed | 13 |
| Models with a changed name | 0 |
| Models with a changed cost | 22 |
| Models with a changed limit | 7 |
| Models with a changed input | 6 |
| Models with a changed variants | 24 |
| Models without a price before | 8 |
| Models without a price after | 0 |

Removed models:

| Model | Name |
| --- | --- |
| `fuelix/dall-e-3` | DALL-E 3 |
| `fuelix/gpt-4o-transcribe` | GPT-4o Transcribe |
| `fuelix/gpt-4o-transcribe-2025-03-20` | GPT-4o Transcribe (2025-03-20) |
| `fuelix/imagen-3` | Imagen 3 ($0.04/image, not token-billed) |
| `fuelix/imagen-3-fast` | Imagen 3 Fast ($0.02/image, not token-billed) |
| `fuelix/imagen-4` | Imagen 4 ($0.04/image, not token-billed) |
| `fuelix/imagen-4-ultra` | Imagen 4 Ultra ($0.06/image, not token-billed) |
| `fuelix/text-embedding-3-large` | Text Embedding 3 Large |
| `fuelix/text-embedding-3-small` | Text Embedding 3 Small |
| `fuelix/text-embedding-ada-002` | Text Embedding Ada 002 (legacy) |
| `fuelix/tts-1` | TTS-1 (Free on FuelIX) |
| `fuelix/tts-1-hd` | TTS-1 HD (Free on FuelIX) |
| `fuelix/whisper-1` | Whisper 1 (Free on FuelIX) |

Changed fields (cost is input/output/cache read/cache write in USD per 1M tokens; limit is context/output):

| Model | Field | Before | After |
| --- | --- | --- | --- |
| `fuelix-anthropic/claude-haiku` | cost | 1/5/0.1/1.25 | 0.1/0.5/0.01/0.125; >200000: 0.5/2.5/0.05/0.625 |
| `fuelix-anthropic/claude-haiku-5` | cost | none | 0.1/0.5/0.01/0.125; >200000: 0.5/2.5/0.05/0.625 |
| `fuelix-anthropic/claude-haiku-5` | input | image,text | image,pdf,text |
| `fuelix-anthropic/claude-haiku-5` | limit | 200000/32000 | 1000000/128000 |
| `fuelix-anthropic/claude-haiku-5-5` | cost | none | 0.1/0.5/0.01/0.125 |
| `fuelix-anthropic/claude-haiku-5-5` | input | image,text | image,pdf,text |
| `fuelix-anthropic/claude-haiku-5-5` | limit | 200000/32000 | 1000000/128000 |
| `fuelix-anthropic/claude-opus-4-8` | cost | none | 5/25/0.5/6.25 |
| `fuelix-anthropic/claude-opus-4-8` | input | image,text | image,pdf,text |
| `fuelix-anthropic/claude-opus-4-8` | limit | 200000/32000 | 1000000/128000 |
| `fuelix-anthropic/claude-opus-5` | cost | 5/25/0.5/6.25 | 4/20/0.2/5 |
| `fuelix-anthropic/claude-opus-5-0` | cost | none | 5/25/0.5/6.25 |
| `fuelix-anthropic/claude-opus-5-0` | input | image,text | image,pdf,text |
| `fuelix-anthropic/claude-opus-5-0` | limit | 200000/32000 | 1000000/128000 |
| `fuelix-anthropic/claude-sonnet-5-0` | cost | none | 2/10/0.2/2.5 |
| `fuelix-anthropic/claude-sonnet-5-0` | input | image,text | image,pdf,text |
| `fuelix-anthropic/claude-sonnet-5-0` | limit | 200000/32000 | 1000000/128000 |
| `fuelix-openai/gpt-4.1` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4.1-2025-04-14` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4.1-mini` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4.1-mini-canada` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o` | cost | 2.5/10/1.25/0 | 5/15/1.25/0 |
| `fuelix-openai/gpt-4o` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-2024-05-13` | cost | 2.5/10/0/0 | 5/15/0/0 |
| `fuelix-openai/gpt-4o-2024-05-13` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-2024-05-13-content-filter` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-2024-08-06` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-mini` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-mini-2024-07-18` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-4o-mini-2024-07-18-ptu` | variants | none,minimal,low,medium,high,xhigh | none |
| `fuelix-openai/gpt-6-luna` | cost | 0.1/0.5/0.01/0.125 | 0.1/0.5/0.01/0.125; >200000: 0.2/0.75/0.02/0.125 |
| `fuelix-openai/gpt-6-sol` | cost | 2/10/0.2/2.5 | 2/10/0.1/2.5 |
| `fuelix-openai/gpt-6.0-sol` | cost | none | 2/10/0.2/0; >200000: 4/15/0.4/0 |
| `fuelix-openai/gpt-6.0-sol` | limit | 200000/32000 | 1050000/128000 |
| `fuelix/claude-3-5-haiku` | variants | low,medium,high | none |
| `fuelix/claude-3-5-haiku-20241022` | variants | low,medium,high | none |
| `fuelix/claude-sonnet-4-legacy` | cost | 3/15/0.3/3.75 | 3/15/0.3/3.75; >200000: 6/22.5/0.6/7.5 |
| `fuelix/deepseek-v4.1-flash` | variants | low,medium,high | none |
| `fuelix/gemini-2.5-pro` | cost | 1.25/10/0.125/0 | 1.25/10/0.125/0; >200000: 2.5/15/0.25/0 |
| `fuelix/gemini-3-flash` | cost | 0.5/3/0.05/0 | 0.75/3.75/0.075/0 |
| `fuelix/gemini-3-pro` | cost | 2/12/0.2/0 | 2/12/0.2/0; >200000: 4/18/0.4/0 |
| `fuelix/gemini-3-pro-preview` | cost | 2/12/0.2/0 | 2/12/0.2/0; >200000: 4/18/0.4/0 |
| `fuelix/gemini-3.1-flash-image` | variants | low,medium,high | none |
| `fuelix/gemini-3.1-pro-preview` | cost | 2/12/0.2/0 | 2/12/0.2/0; >200000: 4/18/0.4/0 |
| `fuelix/gemini-3.5-flash-ca` | cost | none | 1.5/9/0.15/0 |
| `fuelix/gemini-3.5-flash-ca` | input | image,text | audio,image,pdf,text,video |
| `fuelix/gemini-3.5-flash-ca` | limit | 200000/32000 | 1000000/64000 |
| `fuelix/gemini-3.6-flash` | cost | 1.5/7.5/0.15/0 | 0.75/3.75/0.075/0 |
| `fuelix/gemini-3.7-flash` | cost | 1.5/7.5/0.15/0 | 0.75/3.75/0.075/0 |
| `fuelix/gemini-4-argon` | cost | none | 2/10/0.1/0 |
| `fuelix/gemma-4-26b-a4b-it` | variants | low,medium,high | none |
| `fuelix/gemma-4-31b-it` | variants | low,medium,high | none |
| `fuelix/gemma-4-saif-kidc` | variants | low,medium,high | none |
| `fuelix/gpt-4-0125-preview` | variants | low,medium,high | none |
| `fuelix/llama-3.2-90b` | variants | low,medium,high | none |
| `fuelix/llama-4-maverick-17b-128e` | variants | low,medium,high | none |
| `fuelix/llama-4-scout-17b-16e` | variants | low,medium,high | none |
| `fuelix/mistral-large` | variants | low,medium,high | none |
| `fuelix/mistral-large-24.11` | variants | low,medium,high | none |

