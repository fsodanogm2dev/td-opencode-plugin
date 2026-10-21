/**
 * Title model. The plugin sets `family` on one model per provider, so OpenCode generates session titles on a cheap
 * model (`model.small`). A mock FueliX records which model receives the title request and which receives the agent
 * request. No real key and no network beyond the mock.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { FAKE_KEY, listModels, startFuelixServer, startMockFuelix, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"
import { runPromptFlow } from "./session-flow.ts"

const SESSION_MODEL = "claude-opus-4-8"
const TITLE_MODEL = "claude-haiku-5-5"
const MODELS = [SESSION_MODEL, TITLE_MODEL, "gpt-6-luna", "gemini-3.1-flash-lite"]

const hasTools = (request: RecordedRequest) => Array.isArray(request.body?.tools) && request.body.tools.length > 0

/** One Anthropic Messages stream with the text "OK". */
function anthropicStream(model: string): Response {
  const usage = { input_tokens: 10, output_tokens: 2 }
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model, usage: { ...usage, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }],
    ["message_stop", { type: "message_stop" }],
  ]
  const body = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

interface Stack {
  mock: MockFuelix
  server: IsolatedServer
  feed: EventFeed
}

const stacks: Stack[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.feed.close()
    await stack.server.stop()
    stack.mock.stop()
  }
})

async function start(config?: Record<string, unknown>): Promise<Stack> {
  const mock = startMockFuelix({
    models: MODELS,
    handler: (request) => (request.path === "/v1/messages" ? anthropicStream(request.body?.model) : undefined),
  })
  const server = await startFuelixServer({ baseURL: mock.url, key: FAKE_KEY, ...(config ? { config } : {}) })
  await waitFor(
    async () => {
      const { models } = await listModels(server)
      const ready = [SESSION_MODEL, TITLE_MODEL].every((id) => models.some((m) => m.providerID === "fuelix-anthropic" && m.id === id))
      return ready && mock.requests.some((r) => r.path === "/v1/models") ? true : undefined
    },
    60_000,
    "plugin models",
  )
  await new Promise((resolve) => setTimeout(resolve, 2000)) // Let the provider reload settle.
  const stack = { mock, server, feed: await server.subscribe() }
  stacks.push(stack)
  return stack
}

async function runSession(stack: Stack) {
  const start = stack.mock.requests.length
  const flow = await runPromptFlow({
    server: stack.server,
    feed: stack.feed,
    model: { providerID: "fuelix-anthropic", id: SESSION_MODEL },
    prompts: ["Reply with exactly the word OK."],
  })
  expect(flow.failures).toEqual([])
  const sent = stack.mock.requests.slice(start).filter((r) => r.path === "/v1/messages")
  return { agent: sent.filter(hasTools), title: sent.filter((r) => !hasTools(r)) }
}

describe("title model", () => {
  test("the plugin marks only the title model of each provider with a family", async () => {
    const stack = await start()
    const { models } = await listModels(stack.server)
    const families = models
      .filter((m) => m.providerID.startsWith("fuelix"))
      .map((m) => `${m.providerID}/${m.id}=${(m as unknown as { family?: string }).family ?? ""}`)
      .sort()
    expect(families).toEqual([
      `fuelix-anthropic/${TITLE_MODEL}=claude-haiku`,
      `fuelix-anthropic/${SESSION_MODEL}=`,
      "fuelix-openai/gpt-6-luna=gpt-luna",
      "fuelix/gemini-3.1-flash-lite=gemini-flash-lite",
    ])
  }, 120_000)

  test("the title request goes to the title model and the agent request goes to the session model", async () => {
    const stack = await start()
    const { agent, title } = await runSession(stack)
    expect(agent.length).toBeGreaterThanOrEqual(1)
    for (const request of agent) expect(request.body.model).toBe(SESSION_MODEL)
    expect(title.length).toBeGreaterThanOrEqual(1)
    for (const request of title) expect(request.body.model).toBe(TITLE_MODEL)
  }, 180_000)

  // OpenCode 2.0.32 reads `agents` natively. The legacy `agent` key takes a "provider/model" string.
  const overrides: [string, Record<string, unknown>][] = [
    ["agents.title.model", { agents: { title: { model: { providerID: "fuelix-anthropic", model: SESSION_MODEL } } } }],
    ["legacy agent.title.model", { agent: { title: { model: `fuelix-anthropic/${SESSION_MODEL}` } } }],
  ]
  for (const [name, config] of overrides) {
    test(`${name} overrides the title model`, async () => {
      const stack = await start(config)
      const { agent, title } = await runSession(stack)
      expect(agent.length).toBeGreaterThanOrEqual(1)
      for (const request of agent) expect(request.body.model).toBe(SESSION_MODEL)
      expect(title.length).toBeGreaterThanOrEqual(1)
      for (const request of title) expect(request.body.model).toBe(SESSION_MODEL)
    }, 180_000)
  }
})
