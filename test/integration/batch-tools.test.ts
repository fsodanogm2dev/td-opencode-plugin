/**
 * FueliX batch tools on a real isolated OpenCode server. The FueliX gateway is a local mock: it scripts model turns
 * (the mock model calls one batch tool per prompt) and it implements the Anthropic Message Batches endpoints.
 * No real key, no production request, no paid work.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, lstat, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FAKE_KEY, startFuelixServer, startMockFuelix, waitForFuelixModels, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"

const TIMEOUT = 180_000
const MODEL_ID = "claude-haiku-4-5"
const BATCH_ID = "msgbatch_test_1"
const TOOLS = [
  "fuelix_batch_submit",
  "fuelix_batch_list",
  "fuelix_batch_inspect",
  "fuelix_batch_status",
  "fuelix_batch_cancel",
  "fuelix_batch_collect",
] as const
type ToolName = (typeof TOOLS)[number]

const PROMPT_SECRET_1 = "PROMPT-BODY-SECRET-DOC-ONE"
const PROMPT_SECRET_2 = "PROMPT-BODY-SECRET-DOC-TWO"
const RESULT_SECRET = "RESULT-BODY-SECRET-DOC-ONE"
const ERROR_SECRET = "ERROR-BODY-SECRET-DOC-TWO"

// ---------------------------------------------------------------------------------------------------------------------
// Mock gateway
// ---------------------------------------------------------------------------------------------------------------------

function sse(events: [string, unknown][]): Response {
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const messageStart = (id: string) =>
  ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }] as [string, unknown]

function textStream(text: string): Response {
  return sse([
    messageStart("msg_text"),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

function toolUseStream(id: string, name: string, input: unknown): Response {
  return sse([
    messageStart("msg_tool"),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ])
}

/** Text of a message `content` (string or block array), for the block types that carry text. */
function blocksOf(message: any): any[] {
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }]
  return Array.isArray(message?.content) ? message.content : []
}

function toolResultText(block: any): string {
  if (typeof block.content === "string") return block.content
  if (Array.isArray(block.content)) return block.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("")
  return ""
}

function parseJSON(text: string): any {
  try {
    const value = JSON.parse(text)
    return typeof value === "string" ? (parseJSON(value) ?? value) : value
  } catch {
    return undefined
  }
}

const CALL = /CALL_TOOL (\w+) (\{.*\})/

interface MockBatch {
  id: string
  status: "in_progress" | "canceling" | "ended"
  requestIDs: string[]
  createdAt: string
  cancelAt: string | null
  endedAt: string | null
}

interface Gateway {
  mock: MockFuelix
  /** Ends the batch (successes and errors become available). */
  finish(id: string): void
  batchRequests(): RecordedRequest[]
}

function startGateway(): Gateway {
  const batches = new Map<string, MockBatch>()
  let toolSeq = 0

  const view = (batch: MockBatch) => ({
    id: batch.id,
    type: "message_batch",
    processing_status: batch.status,
    request_counts:
      batch.status === "ended"
        ? { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 }
        : { processing: batch.requestIDs.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: batch.createdAt,
    ended_at: batch.endedAt,
    expires_at: new Date(Date.parse(batch.createdAt) + 24 * 3600_000).toISOString(),
    cancel_initiated_at: batch.cancelAt,
    archived_at: null,
    results_url: batch.status === "ended" ? `${mock.url}/v1/messages/batches/${batch.id}/results` : null,
  })

  const mock: MockFuelix = startMockFuelix({
    models: [MODEL_ID],
    handler: (request) => {
      if (request.path === "/v1/messages" && request.method === "POST") {
        const body = request.body
        const hasTools = Array.isArray(body?.tools) && body.tools.length > 0
        if (!hasTools) return textStream("Batch tool lifecycle")
        const last = body.messages?.at(-1)
        const blocks = blocksOf(last)
        if (blocks.some((block) => block.type === "tool_result")) return textStream("Tool finished.")
        const text = blocks.filter((block) => block.type === "text").map((block) => block.text as string).join("\n")
        const match = CALL.exec(text)
        if (!match) return textStream("No scripted call.")
        toolSeq += 1
        // OpenCode 2.0.32 lists plugin tools in the Code Mode catalog; the model calls them inside `execute`.
        // The wrapper returns the outcome as data, so a rejected tool call stays readable.
        const code =
          `try { return { ok: true, value: await tools.${match[1]}(${match[2]}) } } ` +
          `catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) } }`
        return toolUseStream(`toolu_batch_${toolSeq}`, "execute", { code })
      }

      if (!request.path.startsWith("/v1/messages/batches")) return undefined
      const parts = request.path.split("/").filter(Boolean) // v1 messages batches [id] [action]
      if (parts.length === 3 && request.method === "POST") {
        const requests: { custom_id: string }[] = request.body?.requests ?? []
        const id = `msgbatch_test_${batches.size + 1}`
        const batch: MockBatch = {
          id,
          status: "in_progress",
          requestIDs: requests.map((item) => item.custom_id),
          createdAt: new Date().toISOString(),
          cancelAt: null,
          endedAt: null,
        }
        batches.set(id, batch)
        return Response.json(view(batch))
      }
      const batch = batches.get(parts[3] ?? "")
      if (!batch) return Response.json({ type: "error", error: { type: "not_found_error", message: "no such batch" } }, { status: 404 })
      if (parts.length === 4 && request.method === "GET") return Response.json(view(batch))
      if (parts.length === 5 && parts[4] === "cancel" && request.method === "POST") {
        if (batch.status === "in_progress") {
          batch.status = "canceling"
          batch.cancelAt = new Date().toISOString()
        }
        return Response.json(view(batch))
      }
      if (parts.length === 5 && parts[4] === "results" && request.method === "GET") {
        if (batch.status !== "ended") return new Response("not ready", { status: 404 })
        // Reversed order: the client must match by custom_id.
        const lines = [
          { custom_id: batch.requestIDs[1], result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: ERROR_SECRET }, request_id: "req_test_2" } } },
          {
            custom_id: batch.requestIDs[0],
            result: {
              type: "succeeded",
              message: {
                id: "msg_batch_1",
                type: "message",
                role: "assistant",
                model: MODEL_ID,
                content: [{ type: "text", text: RESULT_SECRET }],
                stop_reason: "end_turn",
                usage: { input_tokens: 11, output_tokens: 7 },
              },
            },
          },
        ]
        return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-jsonl" } })
      }
      return undefined
    },
  })

  return {
    mock,
    finish: (id) => {
      const batch = batches.get(id)
      if (!batch) throw new Error(`unknown mock batch ${id}`)
      batch.status = "ended"
      batch.endedAt = new Date().toISOString()
    },
    batchRequests: () => mock.requests.filter((request) => request.path.startsWith("/v1/messages/batches")),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Tool runner: one scripted model turn per prompt
// ---------------------------------------------------------------------------------------------------------------------

interface ToolOutput {
  /** Text of the `tool_result` block that OpenCode sent back to the model. */
  text: string
  isError: boolean
  /** Parsed JSON, when the text is JSON. */
  json: any
}

describe("fuelix batch tools", () => {
  let gateway: Gateway
  let server: IsolatedServer
  let feed: EventFeed
  const outputs: { tool: ToolName; session: string; output: ToolOutput }[] = []
  const sessions: Record<"a" | "b", string> = { a: "", b: "" }
  let jobID = ""
  let inputPath = ""
  let artifactPaths: string[] = []
  let submitStarted = 0
  let submitFinished = 0

  async function createSession(): Promise<string> {
    const created = await server.api<{ data: { id: string } }>("POST", "/api/session", {
      location: { directory: server.dirs.project },
      model: { providerID: "fuelix-anthropic", id: MODEL_ID },
    })
    if (created.status !== 200) throw new Error(`session create failed: HTTP ${created.status} ${JSON.stringify(created.json)}`)
    return created.json.data.id
  }

  /** Sends one prompt that makes the mock model call `tool`, waits for the turn, and returns the tool result. */
  async function callTool(sessionID: string, tool: ToolName, input: Record<string, unknown>): Promise<ToolOutput> {
    const startIndex = gateway.mock.requests.length
    const settled = () =>
      feed.events.filter((event) => (event.type === "session.step.ended" || event.type === "session.step.failed") && event.data?.sessionID === sessionID).length
    const before = settled()
    const sent = await server.api("POST", `/api/session/${sessionID}/prompt`, { text: `CALL_TOOL ${tool} ${JSON.stringify(input)}` })
    if (sent.status !== 200) throw new Error(`prompt failed: HTTP ${sent.status} ${JSON.stringify(sent.json)}`)
    await server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await waitFor(async () => (settled() >= before + 2 ? true : undefined), 30_000, `two steps of ${tool}`)
    const failed = feed.events.filter((event) => event.type === "session.step.failed" && event.data?.sessionID === sessionID)
    expect(failed.map((event) => JSON.stringify(event.data?.error))).toEqual([])

    const followUps = gateway.mock.requests
      .slice(startIndex)
      .filter((request) => request.path === "/v1/messages" && Array.isArray(request.body?.tools) && request.body.tools.length > 0)
      .flatMap((request) => blocksOf(request.body.messages?.at(-1)).filter((block) => block.type === "tool_result"))
    expect(followUps.length).toBe(1)
    const block = followUps[0]
    expect(block.is_error === true).toBe(false) // The `execute` call itself must work.
    const wrapper = parseJSON(toolResultText(block))
    expect(wrapper).toBeDefined()
    // `value` is the string that the batch tool returned (bounded JSON text).
    const text: string = wrapper.ok === true ? String(wrapper.value ?? "") : String(wrapper.error ?? "")
    const output: ToolOutput = { text, isError: wrapper.ok !== true, json: parseJSON(text) }
    outputs.push({ tool, session: sessionID, output })
    return output
  }

  const mockModelRequests = () => gateway.mock.requests.filter((request) => request.path === "/v1/messages")

  beforeAll(async () => {
    gateway = startGateway()
    server = await startFuelixServer({ baseURL: gateway.mock.url, key: FAKE_KEY })
    await waitForFuelixModels(server, [MODEL_ID])
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Let the provider reload settle.
    feed = await server.subscribe()

    inputPath = join(server.dirs.project, "batch-input.json")
    await writeFile(
      inputPath,
      JSON.stringify({
        requests: [
          { custom_id: "doc-1", params: { model: `fuelix-anthropic/${MODEL_ID}`, max_tokens: 32, messages: [{ role: "user", content: `Summarize fake text. ${PROMPT_SECRET_1}` }] } },
          { custom_id: "doc-2", params: { model: `fuelix-anthropic/${MODEL_ID}`, max_tokens: 32, messages: [{ role: "user", content: `Summarize fake text. ${PROMPT_SECRET_2}` }] } },
        ],
      }),
      { mode: 0o600 },
    )
    await chmod(inputPath, 0o600)
    sessions.a = await createSession()
    sessions.b = await createSession()
  }, TIMEOUT)

  afterAll(async () => {
    feed?.close()
    await server?.stop()
    gateway?.mock.stop()
  })

  test(
    "submit registers six tools, sends Bearer only and unprefixed models, and returns before collection",
    async () => {
      submitStarted = Date.now()
      const out = await callTool(sessions.a, "fuelix_batch_submit", { input_path: inputPath })
      submitFinished = Date.now()
      expect(out.isError).toBe(false)

      // Registration: the inference request carries all six definitions.
      // OpenCode 2.0.32 lists plugin tools in the Code Mode catalog of the system prompt.
      const agentRequest = mockModelRequests().find((request) => Array.isArray(request.body?.tools) && request.body.tools.length > 0)!
      const system = JSON.stringify(agentRequest.body.system)
      for (const tool of TOOLS) expect(system).toContain(`tools.${tool}(`)

      // The mock gateway got exactly one POST, with Bearer auth and unprefixed model IDs.
      const posts = gateway.batchRequests().filter((request) => request.method === "POST")
      expect(posts.length).toBe(1)
      expect(posts[0]!.path).toBe("/v1/messages/batches")
      expect(posts[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(posts[0]!.headers["x-api-key"]).toBeUndefined()
      const sentRequests = posts[0]!.body.requests as { custom_id: string; params: { model: string } }[]
      expect(sentRequests.map((request) => request.custom_id)).toEqual(["doc-1", "doc-2"])
      for (const request of sentRequests) expect(request.params.model).toBe(MODEL_ID)

      // Not collected: no results download, and the output is bounded JSON that names both IDs.
      expect(gateway.batchRequests().some((request) => request.path.endsWith("/results"))).toBe(false)
      expect(out.json).toBeDefined()
      expect(out.text).toContain(BATCH_ID)
      expect(out.json.batchID).toBe(BATCH_ID)
      expect(out.json.submission).toBe("submitted")
      expect(out.json.remote.status).toBe("in_progress")
      expect(out.json.remote.counts).toEqual({ processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 })
      expect(out.json.collection.state).toBe("not_collected")
      expect(out.json.requests.count).toBe(2)
      jobID = out.json.jobID
      expect(jobID).toMatch(/^[A-Za-z0-9_-]+$/)
      // The protected request snapshot lives in the isolated data directory, and the file is private.
      expect(out.json.requestsPath.startsWith(server.dirs.data)).toBe(true)
      expect((await lstat(out.json.requestsPath)).mode & 0o777).toBe(0o600)
      expect(out.text.length).toBeLessThan(8_000)
      expect(out.text).not.toContain("collected\":true")
      // The turn (model call, plugin submit, model follow-up) ends promptly.
      expect(submitFinished - submitStarted).toBeLessThan(60_000)
    },
    TIMEOUT,
  )

  test(
    "list, status, and inspect show the batch of the originating session",
    async () => {
      const list = await callTool(sessions.a, "fuelix_batch_list", { limit: 5 })
      expect(list.isError).toBe(false)
      expect(list.text).toContain(BATCH_ID)
      expect(list.json.jobs.map((job: { jobID: string }) => job.jobID)).toEqual([jobID])

      const status = await callTool(sessions.a, "fuelix_batch_status", { batch_id: BATCH_ID })
      expect(status.isError).toBe(false)
      expect(status.text).toContain(BATCH_ID)
      expect(status.text).toContain("in_progress")
      expect(status.text).toMatch(/\d{4}-\d{2}-\d{2}T/) // Time of the batch.

      const inspect = await callTool(sessions.a, "fuelix_batch_inspect", { batch_id: BATCH_ID, limit: 5 })
      expect(inspect.isError).toBe(false)
      expect(inspect.text).toContain(BATCH_ID)
      expect(inspect.text).toContain("doc-1")
      expect(inspect.text).toContain("doc-2")
      expect(inspect.json.job.requestsPath.startsWith(server.dirs.data)).toBe(true)
      expect(inspect.json.requests.items.map((item: { custom_id: string; model: string }) => [item.custom_id, item.model])).toEqual([
        ["doc-1", MODEL_ID],
        ["doc-2", MODEL_ID],
      ])
    },
    TIMEOUT,
  )

  test(
    "cancellation is requested, not complete, and collection waits for the end",
    async () => {
      const cancel = await callTool(sessions.a, "fuelix_batch_cancel", { batch_id: BATCH_ID })
      expect(cancel.isError).toBe(false)
      expect(cancel.text).toContain("canceling")
      expect(gateway.batchRequests().filter((request) => request.path.endsWith("/cancel")).length).toBe(1)

      const status = await callTool(sessions.a, "fuelix_batch_status", { batch_id: BATCH_ID })
      expect(status.json.remote.status).toBe("canceling")
      expect(cancel.json.remote.status).toBe("canceling")

      // The batch has not ended, so collection must not download results.
      const early = await callTool(sessions.a, "fuelix_batch_collect", { batch_id: BATCH_ID })
      expect(early.json.collection.state).toBe("not_collected")
      expect(early.json.note).toContain("not ended")
      expect(gateway.batchRequests().some((request) => request.path.endsWith("/results"))).toBe(false)
    },
    TIMEOUT,
  )

  test(
    "collect writes private artifacts, maps results by custom ID, and a repeat does not download again",
    async () => {
      gateway.finish(BATCH_ID)
      const collect = await callTool(sessions.a, "fuelix_batch_collect", { batch_id: BATCH_ID })
      expect(collect.isError).toBe(false)
      const downloads = () => gateway.batchRequests().filter((request) => request.path.endsWith("/results"))
      expect(downloads().length).toBe(1)
      expect(downloads()[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)

      const artifacts = collect.json?.collection?.artifacts as Record<string, string> | undefined
      expect(artifacts).toBeDefined()
      expect(Object.keys(artifacts!).sort()).toEqual(["failures", "manifest", "requests", "results", "successes"])
      expect(collect.json.jobID).toBe(jobID)
      expect(collect.json.collection.state).toBe("collected")
      expect(collect.json.collection.counts).toEqual({ succeeded: 1, errored: 1, canceled: 0, expired: 0 })
      expect(collect.json.remote.status).toBe("ended")
      expect(collect.json.cost.kind).toBe("unavailable") // The mock supplies no verified price.
      artifactPaths = Object.values(artifacts!)
      const names = artifactPaths.map((path) => path.split("/").at(-1)).sort()
      expect(names).toEqual(["failures.jsonl", "manifest.json", "requests.json", "results.jsonl", "successes.jsonl"])

      const jobDir = artifactPaths[0]!.split("/").slice(0, -1).join("/")
      expect(jobDir.startsWith(server.dirs.root)).toBe(true)
      expect(jobDir.endsWith(jobID)).toBe(true)
      expect((await lstat(jobDir)).mode & 0o777).toBe(0o700)
      for (const path of artifactPaths) {
        expect(path.startsWith(`${jobDir}/`)).toBe(true)
        const stat = await lstat(path)
        expect(stat.isFile()).toBe(true)
        expect(stat.mode & 0o777).toBe(0o600)
      }
      const read = (name: string) => readFile(artifactPaths.find((path) => path.endsWith(`/${name}`))!, "utf8")
      const successes = await read("successes.jsonl")
      const failures = await read("failures.jsonl")
      expect(successes).toContain("doc-1")
      expect(successes).toContain(RESULT_SECRET)
      expect(successes).not.toContain("doc-2")
      expect(failures).toContain("doc-2")
      expect(failures).toContain("errored")
      expect(failures).not.toContain("doc-1")
      const raw = await read("results.jsonl")
      expect(raw).toContain(RESULT_SECRET)
      // The gateway returned results in reverse order. The raw file keeps that order; the manifest maps by custom ID.
      expect(raw.indexOf("doc-2")).toBeLessThan(raw.indexOf("doc-1"))
      const requestsFile = await read("requests.json")
      expect(requestsFile).toContain("doc-2")
      expect(requestsFile).not.toContain("fuelix-anthropic/") // Snapshot keeps the unprefixed model that was sent.
      expect(requestsFile).toContain(`"model":"${MODEL_ID}"`)
      const manifest = JSON.parse(await read("manifest.json"))
      expect(manifest.batchID).toBe(BATCH_ID)
      expect(manifest.collection.order).toEqual([
        { index: 0, custom_id: "doc-1", type: "succeeded" },
        { index: 1, custom_id: "doc-2", type: "errored" },
      ])

      // A second collection reuses the local artifacts.
      const again = await callTool(sessions.a, "fuelix_batch_collect", { batch_id: BATCH_ID })
      expect(again.isError).toBe(false)
      expect(again.json.collection.state).toBe("collected")
      expect(again.json.collection.artifacts).toEqual(artifacts!)
      expect(downloads().length).toBe(1)
    },
    TIMEOUT,
  )

  test(
    "another session sees no batch and cannot reach the remote ID, and the gateway is not called",
    async () => {
      const list = await callTool(sessions.b, "fuelix_batch_list", {})
      expect(list.json.jobs).toEqual([])
      expect(list.text).not.toContain(BATCH_ID)
      expect(list.text).not.toContain(jobID)

      const before = gateway.batchRequests().length
      const rejected: ToolOutput[] = []
      for (const tool of ["fuelix_batch_status", "fuelix_batch_inspect", "fuelix_batch_cancel", "fuelix_batch_collect"] as const) {
        const out = await callTool(sessions.b, tool, { batch_id: BATCH_ID })
        rejected.push(out)
        // Rejected, and the output does not reveal the batch of the other session.
        expect(out.isError || /not[ _]found|unknown|no (such )?batch|not available|rejected/i.test(out.text)).toBe(true)
        expect(out.text).not.toContain("doc-1")
        expect(out.text).not.toContain(jobID)
      }
      expect(rejected.length).toBe(4)
      expect(gateway.batchRequests().length).toBe(before)
    },
    TIMEOUT,
  )

  test(
    "outputs never contain the key or request and result bodies",
    () => {
      expect(outputs.length).toBeGreaterThanOrEqual(10)
      for (const { tool, output } of outputs) {
        for (const secret of [FAKE_KEY, PROMPT_SECRET_1, PROMPT_SECRET_2, RESULT_SECRET, ERROR_SECRET, "Summarize fake text"]) {
          if (output.text.includes(secret)) throw new Error(`${tool} output contains ${secret.slice(0, 12)}...`)
        }
      }
      // Batch endpoints never receive an x-api-key header.
      for (const request of gateway.batchRequests()) {
        expect(request.headers["x-api-key"]).toBeUndefined()
        expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      }
      // The key is not in the server log.
      expect(server.logs()).not.toContain(FAKE_KEY)
    },
    TIMEOUT,
  )
})
