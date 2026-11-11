# FueliX message batches

Use a batch when you have many independent Messages requests and you do not need the answers at once. The plugin sends
the requests to FueliX in one submission. You collect the results later.

Batches do not change interactive sessions. Agents, providers, and models that you use in chat work as before.

The batch endpoint is `POST /v1/messages/batches` on your FueliX gateway. The plugin uses the Messages batch format,
which is compatible with the Anthropic Message Batches API. The following documents describe the framework and the
compatible API:

- [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins)
- [Anthropic batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)

These documents are vendor reference. They are not evidence that FueliX billing, limits, or model support match them.
Only a check with FueliX can confirm that. See [Verification status](#verification-status).

## Tools

The plugin registers six ordinary OpenCode tools. They work in OpenCode and in OpenChamber.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `fuelix_batch_submit` | `input_path`, `allow_duplicate?` | Reads a request file and submits it once. Returns a job summary and the batch ID when known. |
| `fuelix_batch_list` | `limit?`, `after?` | Lists the batches that this session submitted, newest first. Reads local history only. |
| `fuelix_batch_inspect` | `batch_id`, `limit?`, `after?` | Shows the local record of one batch: counts, timing, collection state, cost, and file paths. Reads local state only. |
| `fuelix_batch_status` | `batch_id` | Asks the gateway for the current state of one batch and updates the local record. |
| `fuelix_batch_cancel` | `batch_id` | Asks the gateway to cancel one batch. |
| `fuelix_batch_collect` | `batch_id` | Downloads the results of an ended batch into local files. |

`batch_id` accepts the remote batch ID or the local job ID. The plugin knows a remote ID only when this session
submitted that batch or when the local history lists it. The local job ID is durable. It is valid in the session that
submitted the batch.

`limit` is an integer from 1 to 100. `after` is the `next` cursor of the previous result.

`allow_duplicate` is an optional boolean and defaults to `false`. Set it to `true` only when the user explicitly asks
to repeat identical work despite an unresolved prior attempt. This can create another paid batch. It is not an
automatic resubmission option. See [Submission](#submission).

### Session scope

The plugin stores the batch history per session, with `ctx.storage`. The history stays after an OpenCode restart. A
tool call reads and changes only batches of its own session. A session cannot inspect, cancel, or collect a batch of
another session, and the tools do not list remote batches that the local history does not contain.

## Request file

`input_path` is an absolute path, or a path relative to the project directory. The file uses the native Messages
batch format as one of the following:

- A JSON object `{ "requests": [ ... ] }`.
- A JSON array of requests.
- JSONL, with one request on each line.

Each request has this form:

```json
{ "custom_id": "doc-alpha-summary", "params": { "model": "claude-haiku-5-5", "max_tokens": 512, "messages": [ { "role": "user", "content": "..." } ] } }
```

Limits and rules:

- The file is at most 32 MiB.
- The file has at least one request and at most 100000 requests.
- `custom_id` is unique in the file and matches `[A-Za-z0-9_-]{1,64}`.
- `params.model` is a raw FueliX model ID. The plugin removes the known prefix `fuelix-anthropic/`. Any other
  value with a `/` is rejected.
- `params.max_tokens` is a positive integer, at most 1000000.
- `params.messages` is a non-empty array.
- `params.stream` must not be `true`.
- The only fields of a request are `custom_id` and `params`. The plugin keeps all other `params` fields unchanged.

The plugin validates the whole file before it sends anything. An error message names the request number and the field.
It never prints request content.

[`examples/batch-requests.json`](../examples/batch-requests.json) contains two independent requests that summarize two
fake documents. The sample uses the raw model ID `claude-haiku-5-5`. It is an example of the format. The plugin did not
verify that your gateway offers batch processing for this model.

## Authorization

Your request to run a batch is the authorization. The agent does not ask for a second confirmation before it submits.
A submitted batch can be billed, so submit only files that you want to run.

The agent steps around a batch are normal priced model calls and are separate from the batch. These steps include
preparing the request file, orchestrating the tools, and writing a final summary with an LLM. The batch cost estimate
does not include them. See [Cost](#cost).

## Status and collection run on demand

The plugin has no batch worker, no background timer, and sends no unsolicited notifications. The plugin contacts
FueliX about a batch only when a tool call asks for it. To learn the state, ask the agent to check the status. To get
the results, ask the agent to collect them. The existing timer that refreshes the model list is not part of the batch
feature and does not change.

## Submission

1. The plugin validates the file.
2. The plugin writes a durable job record and a snapshot of the validated requests to local storage.
3. The plugin sends one HTTP request to FueliX.

The plugin never retries a submission automatically after a timeout, a network error, or an HTTP 5xx response. The
gateway may have accepted the request, and a second submission would duplicate paid work. In such a case the job gets
the state `submission_unknown`. It stays visible in `fuelix_batch_list`, and the tool output tells you to check it. The
manifest and the job record are durable local state. Use `fuelix_batch_list` and `fuelix_batch_inspect` to review them.

The plugin refuses the same normalized request file when this session has a prior job in `submitting` or
`submission_unknown`. File names and formatting do not change the normalized work. An agent must not set
`allow_duplicate: true` to bypass this refusal unless the user explicitly asks to repeat the work despite that prior
attempt. The override permits a new submission; it does not retry the earlier HTTP request.

A `submission_unknown` job can retain a validated remote batch ID when other response metadata is malformed. Use
`fuelix_batch_status` to recover its remote state when that ID is known. The local job ID stays available in every
case. Without a known remote ID, review the job and check the gateway before deciding to submit again.

HTTP calls have a default timeout of 120 seconds, including reading the response body. Result downloads are limited to
256 MiB. These are plugin limits, not claims about FueliX limits.

The locks are process-local. They do not coordinate independent OpenCode servers that share the same storage. The
normal integration harness uses one isolated server.

## Cancel

`fuelix_batch_cancel` sends a cancellation request. It does not guarantee that the batch stops. Requests that are in
progress, and requests that already completed, can still finish and can be billed. Completed results stay valid. Run
`fuelix_batch_status` afterward to see the final counts.

## Collect

`fuelix_batch_collect` works only after the batch has the state `ended`. Before saving anything, the plugin checks the
download for known key material, including Unicode-escaped keys. Key material is not saved. After this check, it saves
the result lines unchanged as `results.jsonl` before validating the result set, so you can diagnose a bad download.

The plugin matches each result to a request with `custom_id`, not with the order of the lines. When a line is malformed
or truncated, or when a `custom_id` is missing, duplicate, or unknown, the tool returns an error and does not mark the
job as collected. It does not write `successes.jsonl`, `failures.jsonl`, or a collected `manifest.json` in that case.
Only a fully valid result set gives a collected job.

A valid collection saves these files in the job folder:

| File | Content |
| --- | --- |
| `requests.json` | Snapshot of the submitted requests. |
| `results.jsonl` | The raw result lines from the gateway. Saved after the key-material check, even when result validation fails. |
| `successes.jsonl` | The results with type `succeeded`. |
| `failures.jsonl` | The results with type `errored`, `canceled`, or `expired`. |
| `manifest.json` | Counts, collection state, and cost status for the job. |

Collecting a valid batch again is idempotent. It keeps the same files and the same result.

## Where the files are

The plugin writes the files outside your repository:

```text
<XDG_DATA_HOME or ~/.local/share>/td-opencode-plugin/batches/<location hash>/<jobID>/
```

`<location hash>` identifies the project directory of the session. Folders have mode `0700` and files have mode `0600`.

Tool output stays small. It shows counts, states, cost status, and absolute file paths. It does not show whole prompts
or whole results. `fuelix_batch_inspect` returns small metadata and the path of the request snapshot. Open the result
files yourself, or ask the agent to read a part of them.

## Key handling

The plugin resolves the FueliX key for each batch request, in the order that the README describes. It sends the key only
as `Authorization: Bearer <key>`. The key never goes into job records, manifests, result files, tool output, or log
lines.

Resolved key candidates stay in memory only, per plugin instance, to check content and redact errors after a key
rotation. If a later credential lookup fails, the plugin still checks against the keys it has seen. If it has seen no
keys and the lookup fails, it refuses to save content. Short placeholder keys can match ordinary content. Use valid
credentials.

To keep the key from leaving the gateway:

- The plugin downloads results only from a URL with the same origin as the gateway and a path in the `/v1` tree.
- The plugin does not follow redirects. A redirect is an error.

Some APIs return results from another origin. The plugin does not support this case now. It does not fetch such a URL
with your key, and the collection fails with an error. If your gateway needs it, this is a missing feature.

## Cost

The plugin ships no verified FueliX batch rate card and does not infer a discount. Without configured rates, the cost
of a batch is `unavailable` and the tool output says so.

### Configure rates

You can give the plugin batch prices that you have checked with FueliX. Set `options.fuelix.batchRates` in the plugin
options. The rates are not a default, and the plugin does not fill in missing values.

The example below is illustrative. `example-model` and all numbers are fictional and are not provider pricing. Replace
them with prices that you have checked.

```jsonc
{
  "package": "github:fsodanogm2dev/td-opencode-plugin",
  "options": {
    "fuelix": {
      "batchRates": {
        // Name the document that states the FueliX batch prices that you use.
        "source": "<link or document that identifies the verified FueliX batch prices>",
        "currency": "USD",
        "models": {
          // The key is the model ID that the results report. Prices are per million tokens.
          "example-model": {
            "input": 1.0,         // fictional number
            "output": 5.0,        // fictional number
            "cacheRead": 0.1,     // optional, fictional number
            "cacheWrite5m": 1.25, // optional, fictional number
            "cacheWrite1h": 2.0   // optional, fictional number
          }
        }
      }
    }
  }
}
```

Rules:

- `source` is required. It is a link or a document title that identifies the price list. It is a label for you. The
  plugin cannot check it, and it is not proof of provider billing.
- `currency` must be `"USD"`.
- `models` has one entry for each model ID that appears in the results (`message.model`). The plugin removes the
  `fuelix-anthropic/` prefix from the keys.
- `input` and `output` are required. They are prices in USD for one million tokens.
- `cacheRead`, `cacheWrite5m`, and `cacheWrite1h` are optional. Add each one that your batches use.
- Rate cards are flat prices. They do not encode context-length tiers. Your source prices must cover every request,
  including any context-length premium that applies to it.
- The plugin rejects unknown fields and invalid numbers. It then ignores the whole `batchRates` option and logs a
  warning. The cost stays `unavailable`.

### When an estimate exists

The plugin computes an estimate during `fuelix_batch_collect`, from the token usage in the collected results and your
rates. Before collection, no estimate exists, because the usage is not known. The estimate has the kind `estimate`, with
your `source` label.

The cost is `unavailable` in these cases:

- You configured no rates, or the rates are invalid.
- A succeeded result has no model, no usage, or incomplete usage.
- A succeeded result uses a model that has no rate in `models`.
- A result uses a token class that has no price, for example cache reads without `cacheRead`.
- A result reports cache write tokens without a split between 5 minute and 1 hour writes. The plugin does not guess
  the time to live.
- A succeeded result reports positive server-tool billables, such as web searches or web fetches. The rate card has no
  price for these charges.

A batch with several models gets a total only when every succeeded result has a rate and complete usage. The plugin
never shows a partial total as the full cost. Results with the type `errored`, `canceled`, or `expired` add no charge to
the estimate. The tool output counts them separately.

The estimate stays in the job record. Changing configured rates does not reprice batches that are already collected.

An estimate is not the invoice. The plugin does not read billing amounts from undocumented response fields, and no
billing interface is part of this feature, so an actual cost is not available. Check your FueliX billing for the real
charge.

## Example prompts

Submit a file and show the history:

```text
Submit the batch in examples/batch-requests.json to FueliX, then list the batches of this session.
```

Show the history in OpenChamber:

```text
Show this session's batch history inline.
```

Collect a finished batch:

```text
Check the status of FueliX batch <batch_id>. If it has ended, collect the results and tell me how many requests
succeeded and failed, and where the files are.
```

In OpenChamber, the agent can draw the tool summary with the existing inline renderer. The plugin registers no user
interface and does not draw or click a dashboard by itself. OpenChamber needs no change. In plain OpenCode, the output
is text.

## Verification status

- Unit tests with fake responses cover the request parser, the client, the artifact files, the cost estimate, and the
  tools. Run `bun test test/unit/fuelix` and `bun run typecheck`.
- [`test/integration/batch-tools.test.ts`](../test/integration/batch-tools.test.ts) exercises all six tools on an isolated
  OpenCode server with a mock FueliX gateway. Run `bun test test/integration/batch-tools.test.ts --timeout 180000`.
- The plugin was not tested with a real FueliX key. It did not run a live, paid batch.
- The plugin did not verify the authenticated FueliX batch endpoint, the result download, or billing against the
  gateway.
- The plugin did not verify that the model `claude-haiku-5-5` supports batches on your gateway.
- The plugin ships no verified FueliX batch rate card. The vendor documents above describe the compatible API only.
