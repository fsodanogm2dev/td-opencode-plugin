/**
 * `/fuelix-batch <prompt>` on a real isolated OpenCode server. The FueliX gateway is a local mock that records every
 * request and implements the Message Batches endpoints. No real key, no production request, no paid work.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { FAKE_KEY, startFuelixServer, startMockFuelix, waitForFuelixModels, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"

const TIMEOUT = 180_000
const MODEL_ID = "claude-haiku-4-5"
const BATCH_MODEL = "claude-haiku-5-5-anthropic"
const PROMPT = "  INLINE-PROMPT-BODY-777 with \"quotes\"\nand a second line  "
const RESULT_TEXT = "INLINE-RESULT-BODY-888"

function sse(events: [string, unknown][]): Response {
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const messageStart = (id: string) =>
  ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }] as [string, unknown]

const textStream = (text: string) =>
  sse([
    messageStart("msg_text"),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ])

const toolUseStream = (id: string, name: string, input: unknown) =>
  sse([
    messageStart("msg_tool"),
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ])

const blocksOf = (message: any): any[] =>
  typeof message?.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message?.content) ? message.content : []

function parseJSON(text: string): any {
  try {
    const value = JSON.parse(text)
    return typeof value === "string" ? (parseJSON(value) ?? value) : value
  } catch {
    return undefined
  }
}

const toolResultText = (block: any): string =>
  typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: any) => part?.text ?? "").join("") : ""

const CALL = /CALL_TOOL (\w+) (\{.*\})/

describe("/fuelix-batch command", () => {
  let mock: MockFuelix
  let server: IsolatedServer
  let feed: EventFeed
  let session = ""
  let ended = false
  let toolSeq = 0
  const batchPosts = () => mock.requests.filter((request) => request.method === "POST" && request.path === "/v1/messages/batches")
  const modelRequests = () => mock.requests.filter((request) => request.path === "/v1/messages")

  beforeAll(async () => {
    mock = startMockFuelix({
      models: [MODEL_ID, BATCH_MODEL],
      handler: (request: RecordedRequest) => {
        if (request.path === "/v1/messages" && request.method === "POST") {
          const body = request.body
          if (!(Array.isArray(body?.tools) && body.tools.length > 0)) return textStream("Title")
          const blocks = blocksOf(body.messages?.at(-1))
          if (blocks.some((block) => block.type === "tool_result")) return textStream("Tool finished.")
          const match = CALL.exec(blocks.filter((block) => block.type === "text").map((block) => block.text as string).join("\n"))
          if (!match) return textStream("No scripted call.")
          toolSeq += 1
          const code =
            `try { return { ok: true, value: await tools.${match[1]}(${match[2]}) } } ` +
            `catch (error) { return { ok: false, error: String(error && error.message ? error.message : error) } }`
          return toolUseStream(`toolu_cmd_${toolSeq}`, "execute", { code })
        }
        if (!request.path.startsWith("/v1/messages/batches")) return undefined
        const parts = request.path.split("/").filter(Boolean)
        const view = () => ({
          id: "msgbatch_cmd_1",
          type: "message_batch",
          processing_status: ended ? "ended" : "in_progress",
          request_counts: ended ? { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 } : { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
          created_at: "2026-11-05T10:00:00Z",
          ended_at: ended ? "2026-11-05T10:05:00Z" : null,
          results_url: ended ? `${mock.url}/v1/messages/batches/msgbatch_cmd_1/results` : null,
        })
        if (parts.length === 3 && request.method === "POST") return Response.json(view())
        if (parts.length === 4 && request.method === "GET") return Response.json(view())
        if (parts.length === 5 && parts[4] === "results" && request.method === "GET") {
          const line = {
            custom_id: "prompt",
            result: { type: "succeeded", message: { id: "msg_1", type: "message", role: "assistant", model: BATCH_MODEL, content: [{ type: "text", text: RESULT_TEXT }], stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 7 } } },
          }
          return new Response(`${JSON.stringify(line)}\n`, { headers: { "content-type": "application/x-jsonl" } })
        }
        return undefined
      },
    })
    server = await startFuelixServer({ baseURL: mock.url, key: FAKE_KEY })
    await waitForFuelixModels(server, [MODEL_ID, BATCH_MODEL])
    await new Promise((resolve) => setTimeout(resolve, 2000))
    feed = await server.subscribe()
    const created = await server.api<{ data: { id: string } }>("POST", "/api/session", {
      location: { directory: server.dirs.project },
      model: { providerID: "fuelix-anthropic", id: MODEL_ID },
    })
    if (created.status !== 200) throw new Error(`session create failed: HTTP ${created.status}`)
    session = created.json.data.id
  }, TIMEOUT)

  afterAll(async () => {
    feed?.close()
    await server?.stop()
    mock?.stop()
  })

  const command = (text: string, extra: Record<string, unknown> = {}) =>
    server.api("POST", `/api/session/${session}/command`, { name: "fuelix-batch", text, ...extra })

  /** Feedback of the command: a synthetic item that the plugin put into the session inbox. */
  const synthetics = () =>
    feed.events.filter((event) => event.type === "session.inbox.enqueued" && event.data?.sessionID === session && event.data?.item?.type === "synthetic")
  const syntheticText = (event: { data: any }): string => String(event.data.item.payload.text)

  async function nextSynthetic(before: number) {
    return waitFor(async () => (synthetics().length > before ? synthetics()[before] : undefined), 30_000, "synthetic feedback")
  }

  test(
    "is listed by the command API",
    async () => {
      const listed = await server.api<{ data: { name: string; description?: string }[] }>("GET", "/api/command")
      expect(listed.status).toBe(200)
      const entry = listed.json.data.find((item) => item.name === "fuelix-batch")
      expect(entry).toBeDefined()
      expect(entry!.description).toContain(BATCH_MODEL)
    },
    TIMEOUT,
  )

  test(
    "a blank invocation shows usage and posts nothing",
    async () => {
      const before = synthetics().length
      const posts = mock.requests.length
      const response = await command("   ")
      expect(response.status).toBe(204)
      const event = await nextSynthetic(before)
      expect(syntheticText(event)).toContain("Usage: /fuelix-batch <prompt>")
      expect(batchPosts()).toHaveLength(0)
      expect(mock.requests.length).toBe(posts)
    },
    TIMEOUT,
  )

  test(
    "attachments are rejected without a POST",
    async () => {
      const before = synthetics().length
      const response = await command("see file", { files: [{ uri: `file://${server.dirs.project}/ignored.txt` }] })
      expect(response.status).toBe(204)
      const event = await nextSynthetic(before)
      expect(syntheticText(event)).toContain("plain prompt text only")
      expect(batchPosts()).toHaveLength(0)
    },
    TIMEOUT,
  )

  test(
    "submits one batch request with the exact prompt, the default model and token cap, and no generation request",
    async () => {
      const before = synthetics().length
      const generationBefore = modelRequests().length
      const response = await command(PROMPT)
      expect(response.status).toBe(204)
      const event = await nextSynthetic(before)
      // Allow a stray model turn to show up if the feedback wrongly resumed the session.
      await new Promise((resolve) => setTimeout(resolve, 1500))

      const posts = batchPosts()
      expect(posts).toHaveLength(1)
      expect(posts[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
      expect(posts[0]!.headers["x-api-key"]).toBeUndefined()
      expect(posts[0]!.body).toEqual({
        requests: [{ custom_id: "prompt", params: { model: BATCH_MODEL, max_tokens: 4096, messages: [{ role: "user", content: PROMPT }] } }],
      })
      expect(modelRequests().length).toBe(generationBefore)
      const text = syntheticText(event)
      expect(text).toContain("msgbatch_cmd_1")
      expect(text).not.toContain("INLINE-PROMPT-BODY-777")
      expect(text).not.toContain(FAKE_KEY)
    },
    TIMEOUT,
  )

  test(
    "an identical prompt is posted again only after the first batch was accepted (no unresolved record)",
    async () => {
      const before = synthetics().length
      await command(PROMPT)
      await nextSynthetic(before)
      expect(batchPosts()).toHaveLength(2)
    },
    TIMEOUT,
  )

  /** Sends a prompt that makes the mock model call `tool`, and returns the tool result JSON. */
  async function callTool(tool: string, input: Record<string, unknown>) {
    const startIndex = mock.requests.length
    const settled = () =>
      feed.events.filter((event) => (event.type === "session.step.ended" || event.type === "session.step.failed") && event.data?.sessionID === session).length
    const stepsBefore = settled()
    const sent = await server.api("POST", `/api/session/${session}/prompt`, { text: `CALL_TOOL ${tool} ${JSON.stringify(input)}` })
    expect(sent.status).toBe(200)
    await server.api("POST", `/api/experimental/session/${session}/wait`)
    await waitFor(async () => (settled() >= stepsBefore + 2 ? true : undefined), 30_000, `two steps of ${tool}`)
    const results = mock.requests
      .slice(startIndex)
      .filter((request) => request.path === "/v1/messages" && Array.isArray(request.body?.tools) && request.body.tools.length > 0)
      .flatMap((request) => blocksOf(request.body.messages?.at(-1)).filter((block) => block.type === "tool_result"))
    expect(results).toHaveLength(1)
    const wrapper = parseJSON(toolResultText(results[0]))
    expect(wrapper?.ok).toBe(true)
    return { text: String(wrapper.value), json: parseJSON(String(wrapper.value)) }
  }

  test(
    "the same session inspects, checks, and collects the command job with its tools",
    async () => {
      const list = await callTool("fuelix_batch_list", {})
      expect(list.json.jobs).toHaveLength(2)
      const job = list.json.jobs[0]
      expect(job.inputPath).toBe("inline:/fuelix-batch")
      expect(job.batchID).toBe("msgbatch_cmd_1")
      expect(list.text).not.toContain("INLINE-PROMPT-BODY-777")

      const inspect = await callTool("fuelix_batch_inspect", { batch_id: job.jobID })
      expect(inspect.json.requests.items).toEqual([{ index: 0, custom_id: "prompt", model: BATCH_MODEL, max_tokens: 4096 }])

      const status = await callTool("fuelix_batch_status", { batch_id: job.jobID })
      expect(status.json.remote.status).toBe("in_progress")

      ended = true
      const collect = await callTool("fuelix_batch_collect", { batch_id: job.jobID })
      expect(collect.json.collection.state).toBe("collected")
      expect(collect.json.collection.counts).toEqual({ succeeded: 1, errored: 0, canceled: 0, expired: 0 })
      const successes = await readFile(collect.json.collection.artifacts.successes, "utf8")
      expect(successes).toContain(RESULT_TEXT)
      expect(collect.text).not.toContain(RESULT_TEXT)
      const snapshot = await readFile(collect.json.collection.artifacts.requests, "utf8")
      expect(snapshot).toContain("INLINE-PROMPT-BODY-777")
      expect(snapshot).not.toContain(FAKE_KEY)
      expect(JSON.stringify(batchPosts().length)).toBe("2")
    },
    TIMEOUT,
  )

  test(
    "no key reaches the server log",
    () => {
      expect(server.logs()).not.toContain(FAKE_KEY)
      for (const event of synthetics()) expect(syntheticText(event)).not.toContain(FAKE_KEY)
    },
    TIMEOUT,
  )
})
