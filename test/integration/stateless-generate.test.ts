import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { FAKE_KEY, startFuelixServer, startMockFuelix, waitForFuelixModels, type MockFuelix } from "./fuelix-helpers.ts"
import type { IsolatedServer } from "./harness.ts"
import { authScheme } from "./wire.ts"

const TIMEOUT = 120_000
const MODEL_ID = "claude-sonnet-5-5"

/** Anthropic Messages stream with one text block. */
function anthropicStream(text: string): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

/** Anthropic Messages JSON response with one text block. */
function anthropicJson(text: string): Response {
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: MODEL_ID,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  })
}

// `/api/experimental/generate/text` does not run Session hooks. OpenChamber uses it for walkthroughs.
describe("stateless generation with fuelix-anthropic", () => {
  let mock: MockFuelix
  let server: IsolatedServer

  beforeAll(async () => {
    mock = startMockFuelix({
      models: [MODEL_ID],
      handler: (request) => {
        if (request.method !== "POST" || !request.path.endsWith("/messages")) return undefined
        if (authScheme(request.headers) !== "bearer") {
          return Response.json({ title: "Unauthorized", detail: ["Invalid or missing API key"], status: 401 }, { status: 401 })
        }
        return request.body?.stream ? anthropicStream("hello") : anthropicJson("hello")
      },
    })
    server = await startFuelixServer({ baseURL: mock.url, key: FAKE_KEY })
    await waitForFuelixModels(server, [MODEL_ID])
  }, TIMEOUT)

  afterAll(async () => {
    await server?.stop()
    mock?.stop()
  })

  test(
    "generate/text sends Bearer auth and returns the text",
    async () => {
      const response = await server.api<{ data?: { text: string } }>("POST", "/api/experimental/generate/text", {
        prompt: "Say hello",
        model: { providerID: "fuelix-anthropic", id: MODEL_ID },
      })
      const calls = mock.requests.filter((request) => request.path.endsWith("/messages"))
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
        expect(call.headers["x-api-key"]).toBeUndefined()
      }
      expect(response.status).toBe(200)
      expect(response.json.data?.text).toBe("hello")
    },
    TIMEOUT,
  )
})
