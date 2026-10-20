/**
 * Phase 3 gate: a real, isolated OpenCode with the plugin feeds a real, isolated td-telemetry (receiver, dashboard,
 * hook scripts, SQLite store). The FueliX gateway is a local mock.
 *
 * Skipped unless `TD_TELEMETRY_REF` points at a td-telemetry checkout:
 *
 *   TD_TELEMETRY_REF=/path/to/td-telemetry bun test test/integration/td-telemetry.test.ts --timeout 400000
 *
 * The idle `SessionEnd` scenario waits about one minute and runs only with `TD_SLOW=1`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { entryFor, expectedCost, FAKE_KEY, loadCatalog, startMockFuelix, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { type EventFeed, type IsolatedServer, pluginEntry, startIsolatedServer, waitFor } from "./harness.ts"
import { runPromptFlow, type FlowResult } from "./session-flow.ts"
import {
  CHAT_USAGE,
  chatHandler,
  initGitRepo,
  ScratchStore,
  startScratchTelemetry,
  TEST_BRANCH,
  TOOL_CALL_ID,
  TOOL_STEP_USAGE,
  type EventRow,
  type SegmentRow,
  type ScratchTelemetry,
} from "./td-telemetry-helpers.ts"

const ref = process.env.TD_TELEMETRY_REF
const MODEL = "gemini-2.5-flash-lite"
const PROMPT = "Reply with OK."
const FILE_SECRET = "FILE-CONTENT-SECRET-7731"

interface Stack {
  telemetry: ScratchTelemetry
  mock: MockFuelix
  chatRequests: RecordedRequest[]
  server: IsolatedServer
  store: ScratchStore
  feed: EventFeed
}

const stacks: Stack[] = []

afterAll(async () => {
  for (const stack of stacks) {
    stack.store.close()
    await stack.server.stop()
    stack.mock.stop()
    await stack.telemetry.stop()
  }
})

/** Scratch td-telemetry, mock FueliX, and an isolated OpenCode with the plugin. All are stopped in `afterAll`. */
async function startStack(input: { idleMinutes: number; mode: "text" | "tool"; filePath?: () => string }): Promise<Stack> {
  const telemetry = await startScratchTelemetry(ref as string)
  const chatRequests: RecordedRequest[] = []
  const mock = startMockFuelix({
    models: [MODEL],
    handler: chatHandler(chatRequests, { mode: input.mode, ...(input.filePath ? { filePath: input.filePath } : {}) }),
  })
  const store = new ScratchStore(telemetry.dbFile)
  const server = await startIsolatedServer({
    config: {
      plugins: [
        pluginEntry({
          fuelix: { baseURL: mock.url, keychainService: false, refreshMinutes: 0 },
          telemetry: { root: ref, receiverURL: `http://127.0.0.1:${telemetry.receiverPort}`, idleMinutes: input.idleMinutes },
        }),
      ],
    },
    env: {
      FUELIX_API_KEY: FAKE_KEY,
      // The mock FueliX URL needs the opt-in. The harness will set it by default.
      TD_OPENCODE_ALLOW_CUSTOM_FUELIX_URL: "1",
      TD_DATA_DIR: telemetry.env.TD_DATA_DIR as string,
      TD_RECEIVER_PORT: telemetry.env.TD_RECEIVER_PORT as string,
      TD_DASHBOARD_PORT: telemetry.env.TD_DASHBOARD_PORT as string,
      TD_RUNTIME_REPLACE: "never",
    },
  })
  const stack: Stack = { telemetry, mock, chatRequests, server, store, feed: undefined as never }
  stacks.push(stack)
  // A git repo on a feature branch, with no remote. Created before any session exists.
  initGitRepo(server.dirs.project)

  await waitFor(
    async () => {
      const response = await server.api<{ data: Array<{ id: string; state: { status: string } }> }>("GET", "/api/plugin")
      return response.json?.data?.find((plugin) => plugin.id === "td-opencode-plugin")?.state.status === "active" ? true : undefined
    },
    60_000,
    "plugin active",
  )
  await waitFor(
    async () => {
      const response = await server.api<{ data: Array<{ id: string; providerID: string }> }>("GET", "/api/model")
      return response.json?.data?.some((model) => model.providerID === "fuelix" && model.id === MODEL) ? true : undefined
    },
    60_000,
    `model fuelix/${MODEL}`,
  )
  stack.feed = await server.subscribe()
  return stack
}

function failureContext(stack: Stack): string {
  const seen = stack.feed.events
    .filter((event) => event.type.startsWith("session.tool.") || event.type.startsWith("permission."))
    .map((event) => ({ type: event.type, id: event.data?.id, name: event.data?.name, sessionID: event.data?.sessionID }))
  return `toolEvents=${JSON.stringify(seen)}\nsegments=${JSON.stringify(stack.store.segments())}\ncounts=${JSON.stringify(stack.store.counts())}\nopencode logs:\n${stack.server.logs().slice(-3000)}\ntd logs:\n${stack.telemetry.logs().slice(-2000)}`
}

function pricing(usage: { prompt_tokens: number; completion_tokens: number }): number {
  const entry = entryFor(loadCatalog(), MODEL)
  expect(entry?.cost).toBeDefined()
  return expectedCost(entry!, { input: usage.prompt_tokens, output: usage.completion_tokens, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
}

/** The segment is keyed by the branch, and the project root falls back to the git common dir (no remote). */
function expectBranchSegment(segment: SegmentRow, projectDir: string) {
  expect(segment.feature_key).toBe(`branch-${TEST_BRANCH}`)
  expect(segment.feature_label).toBe(TEST_BRANCH)
  expect([projectDir, realpathSync(projectDir)]).toContain(segment.project_root)
}

const payloadOf = (row: EventRow) => JSON.parse(row.payload_json)

function printSummary(title: string, store: ScratchStore, extra: Array<Record<string, unknown>> = []) {
  console.log(`\n${title}`)
  console.table(Object.entries(store.counts()).map(([type, rows]) => ({ "event type": type, rows })))
  if (extra.length > 0) console.table(extra)
}

describe.skipIf(!ref)("td-telemetry end to end", () => {
  test(
    "an OpenCode prompt reaches the td-telemetry store with project, turn, model, and cost",
    async () => {
      const stack = await startStack({ idleMinutes: 1, mode: "text" })
      const { server, store, telemetry, chatRequests } = stack

      const flow = await runPromptFlow({
        server,
        feed: stack.feed,
        model: { providerID: "fuelix", id: MODEL },
        prompts: [PROMPT],
        promptTimeoutMs: 120_000,
      })
      expect(flow.failures).toEqual([])
      expect(flow.steps.length).toBeGreaterThanOrEqual(1)
      const sessionID = flow.sessionID
      const stepCost = flow.steps.reduce((sum, step) => sum + step.cost, 0)
      const stepCount = flow.steps.length

      const found = await waitFor(
        async () => {
          const segments = store.segments(sessionID)
          const events = store.events(sessionID)
          const apiRequests = events.filter((row) => row.type === "api_request")
          const prompts = events.filter((row) => row.type === "user_prompt")
          return segments.length > 0 && (segments[0]?.turns ?? 0) >= 1 && apiRequests.length >= stepCount && prompts.length >= 1
            ? { segments, events, apiRequests }
            : undefined
        },
        30_000,
        "td-telemetry rows",
      ).catch((error) => {
        throw new Error(`${String(error)}\n${failureContext(stack)}`)
      })

      const segment = found.segments[0]!
      const projectDir = server.dirs.project
      expectBranchSegment(segment, projectDir)
      // Exactly one: a second plugin instance for an aliased directory must not run its own hooks.
      expect(found.segments).toHaveLength(1)
      expect(segment.turns).toBe(1)
      expect(segment.kind).toBe("work")

      const types = new Set(found.events.map((row) => row.type))
      expect(types.has("user_prompt")).toBe(true)
      expect(types.has("api_request")).toBe(true)

      const priced = pricing(CHAT_USAGE)
      const costs = found.apiRequests.map((row) => payloadOf(row).costUsd as number)
      expect(costs).toHaveLength(stepCount)
      const storedCost = costs.reduce((sum, cost) => sum + cost, 0)
      expect(storedCost).toBeCloseTo(stepCost, 12)
      expect(storedCost).toBeCloseTo(priced * stepCount, 12)
      expect(storedCost).toBeGreaterThan(0)

      for (const row of found.apiRequests) {
        const payload = payloadOf(row)
        expect(payload.querySource).toBe("repl_main_thread")
        expect(payload.model).toBe(MODEL)
        expect(payload.inputTokens).toBe(CHAT_USAGE.prompt_tokens)
        expect(payload.outputTokens).toBe(CHAT_USAGE.completion_tokens)
        expect(row.segment_id).not.toBeNull()
        expect(row.segment_id).toBe(segment.id)
      }

      const allEvents = store.events()
      expect(allEvents.some((row) => JSON.stringify(row).includes("Reply with OK"))).toBe(false)

      expect(chatRequests.length).toBeGreaterThanOrEqual(1)
      expect(Object.values(chatRequests[0]!.headers).some((value) => value.includes(FAKE_KEY))).toBe(true)

      const projects = await waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${telemetry.dashboardPort}/api/projects`, { signal: AbortSignal.timeout(5000) })
          if (!response.ok) return undefined
          const list = (await response.json()) as Array<{ projectRoot: string; costUsd: number }>
          return list.find((item) => item.projectRoot === segment.project_root && item.costUsd > 0) ? list : undefined
        },
        30_000,
        "dashboard /api/projects",
      )
      const listed = projects.find((item) => item.projectRoot === segment.project_root)!

      printSummary("scenario 1: plain prompt", store, [
        { what: "OpenCode step cost (event stream)", usd: stepCost },
        { what: "catalog price (12000 in + 3 out)", usd: priced * stepCount },
        { what: "td-telemetry api_request costUsd", usd: storedCost },
        { what: "dashboard /api/projects costUsd", usd: listed.costUsd },
        { what: "segment conversation_title (ai-title file)", usd: String(store.segments(sessionID)[0]?.conversation_title) },
      ])
    },
    300_000,
  )

  test(
    "a read tool call yields two api_request rows, a tool_decision, and a tool_result",
    async () => {
      let readPath = ""
      const stack = await startStack({ idleMinutes: 30, mode: "tool", filePath: () => readPath })
      const { server, store } = stack
      readPath = join(server.dirs.project, "notes.txt")
      writeFileSync(readPath, `first line\n${FILE_SECRET}\n`)

      const flow = await runPromptFlow({
        server,
        feed: stack.feed,
        model: { providerID: "fuelix", id: MODEL },
        prompts: [`Read ${readPath} and summarize it.`],
        promptTimeoutMs: 120_000,
      })
      expect(flow.failures).toEqual([])
      expect(flow.steps).toHaveLength(2)
      const sessionID = flow.sessionID

      const toolEvents = stack.feed.events.filter((event) => event.type.startsWith("session.tool.") && event.data?.sessionID === sessionID)
      const toolOutcome = toolEvents.find((event) => event.type === "session.tool.success" || event.type === "session.tool.failed")
      expect(toolOutcome).toBeDefined()
      const expectedSuccess = toolOutcome!.type === "session.tool.success"

      const found = await waitFor(
        async () => {
          const events = store.events(sessionID)
          const count = (type: string) => events.filter((row) => row.type === type).length
          return count("api_request") >= 2 && count("tool_result") >= 1 && count("tool_decision") >= 1 && count("user_prompt") >= 1
            ? events
            : undefined
        },
        30_000,
        "td-telemetry rows with tool events",
      ).catch((error) => {
        throw new Error(`${String(error)}\n${failureContext(stack)}`)
      })

      const rows = (type: string) => found.filter((row) => row.type === type)
      expect(rows("api_request")).toHaveLength(2)
      expect(rows("tool_decision")).toHaveLength(1)
      expect(rows("tool_result")).toHaveLength(1)
      expect(rows("user_prompt")).toHaveLength(1)

      // Two distinct requests, each with OpenCode's own step cost.
      const requests = rows("api_request")
      const requestIDs = requests.map((row) => row.request_id)
      expect(new Set(requestIDs).size).toBe(2)
      const stored = requests.map((row) => payloadOf(row).costUsd as number)
      expect(stored[0]).toBeCloseTo(flow.steps[0]!.cost, 12)
      expect(stored[1]).toBeCloseTo(flow.steps[1]!.cost, 12)
      expect(stored[0]).toBeCloseTo(pricing(TOOL_STEP_USAGE[0]), 12)
      expect(stored[1]).toBeCloseTo(pricing(TOOL_STEP_USAGE[1]), 12)
      expect(requests.map((row) => payloadOf(row).inputTokens)).toEqual([12000, 12500])

      const decision = payloadOf(rows("tool_decision")[0]!)
      expect(decision).toMatchObject({ toolUseId: TOOL_CALL_ID, decision: "accept", source: "config", toolName: "read" })
      const result = payloadOf(rows("tool_result")[0]!)
      expect(result.toolName).toBe("read")
      expect(result.success).toBe(expectedSuccess)
      expect(result.toolUseId).toBe(TOOL_CALL_ID)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      for (const row of found) expect(row.segment_id).not.toBeNull()
      const toolSegments = store.segments(sessionID)
      expect(toolSegments).toHaveLength(1)
      expect(toolSegments[0]!.turns).toBe(1)
      expectBranchSegment(toolSegments[0]!, server.dirs.project)
      expect(found.every((row) => row.segment_id === toolSegments[0]!.id)).toBe(true)
      expect(new Set(found.map((row) => row.segment_id)).size).toBe(1)

      // No file content, no prompt text.
      const all = JSON.stringify(store.events())
      expect(all).not.toContain(FILE_SECRET)
      expect(all).not.toContain("first line")
      expect(all).not.toContain("summarize it")
      expect(all).not.toContain(readPath)

      printSummary("scenario 2: read tool call", store, [
        { what: "request_ids", value: requestIDs.join(", ") },
        { what: "step costs (OpenCode)", value: flow.steps.map((step) => step.cost).join(", ") },
        { what: "stored costUsd", value: stored.join(", ") },
        { what: "tool_result", value: JSON.stringify(result) },
      ])
    },
    300_000,
  )

  test.skipIf(process.env.TD_SLOW !== "1")(
    "an idle session ends its segment (SessionEnd after idleMinutes)",
    async () => {
      const stack = await startStack({ idleMinutes: 1, mode: "text" })
      const { server, store } = stack
      const flow: FlowResult = await runPromptFlow({
        server,
        feed: stack.feed,
        model: { providerID: "fuelix", id: MODEL },
        prompts: [PROMPT],
        promptTimeoutMs: 120_000,
      })
      const sessionID = flow.sessionID
      const started = Date.now()
      const open = await waitFor(
        async () => (store.segments(sessionID).length > 0 ? store.segments(sessionID) : undefined),
        30_000,
        "segment row",
      )
      expect(open[0]!.ended_at).toBeNull()
      const ended = await waitFor(
        async () => {
          const segments = store.segments(sessionID)
          return segments.length > 0 && segments.every((segment) => segment.ended_at !== null) ? segments : undefined
        },
        150_000,
        "segments.ended_at",
      ).catch((error) => {
        throw new Error(`${String(error)}\n${failureContext(stack)}`)
      })
      const waitedMs = Date.now() - started
      expect(ended).toHaveLength(1)
      expectBranchSegment(ended[0]!, server.dirs.project)
      expect(ended[0]!.ended_at!).toBeGreaterThanOrEqual(ended[0]!.started_at)
      // SessionEnd fires idleMinutes (1) after the last activity of the segment.
      expect(ended[0]!.ended_at! - ended[0]!.started_at).toBeGreaterThanOrEqual(55_000)
      printSummary("scenario 3: idle SessionEnd", store, [{ what: "seconds from prompt end to ended_at", value: Math.round(waitedMs / 1000) }])
    },
    200_000,
  )
})
