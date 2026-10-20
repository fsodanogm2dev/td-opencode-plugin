/**
 * Wire replay. A mock FueliX serves the response bodies that `live-usage.test.ts` recorded in
 * `test/fixtures/fuelix-wire/`. OpenCode runs the same two-prompt flow with a fake key. The test checks
 * that OpenCode's per-step tokens and cost equal the values derived from the recorded usage and the catalog prices.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { entryFor, expectedCost, FAKE_KEY, listModels, loadCatalog, startFuelixServer, startMockFuelix, type MockFuelix } from "./fuelix-helpers.ts"
import { repoRoot, waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"
import { runPromptFlow } from "./session-flow.ts"
import { normalizeUsage, type RawUsage, type WireKind } from "./wire.ts"

const FIXTURE_DIR = process.env.TD_FIXTURE_DIR ?? join(repoRoot(), "test", "fixtures", "fuelix-wire")
const MODELS = [
  { providerID: "fuelix-openai", id: "gpt-5-nano" },
  { providerID: "fuelix-anthropic", id: "claude-haiku-4-5" },
  { providerID: "fuelix", id: "gemini-2.5-flash-lite" },
] as const

interface Fixture {
  name: string
  providerID: string
  modelID: string
  path: string
  status: number
  contentType: string
  tools: boolean
  kind: WireKind
  usage: RawUsage | undefined
  body: string
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return []
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".body.json"))
    .sort()
    .map((file) => {
      const meta = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
      return { ...meta, name: file.replace(/\.json$/, ""), body: readFileSync(join(FIXTURE_DIR, meta.bodyFile), "utf8") } as Fixture
    })
}

const fixtures = loadFixtures()
const of = (modelID: string, tools: boolean) =>
  fixtures.filter((f) => f.modelID === modelID && f.tools === tools).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

describe("wire replay", () => {
  const catalog = loadCatalog()
  const calls = new Map<string, number>()
  let mock: MockFuelix
  let server: IsolatedServer
  let feed: EventFeed

  beforeAll(async () => {
    expect(fixtures.length).toBeGreaterThan(0)
    mock = startMockFuelix({
      models: MODELS.map((m) => m.id),
      handler: (request) => {
        const model = request.body?.model as string | undefined
        if (!model) return undefined
        const tools = Array.isArray(request.body?.tools) && request.body.tools.length > 0
        const candidates = of(model, tools)
        if (candidates.length === 0) return new Response(`no fixture for ${model} tools=${tools}`, { status: 500 })
        const key = `${model}:${tools}`
        const n = calls.get(key) ?? 0
        calls.set(key, n + 1)
        const fixture = candidates[Math.min(n, candidates.length - 1)]!
        return new Response(fixture.body, { status: fixture.status, headers: { "content-type": fixture.contentType } })
      },
    })
    server = await startFuelixServer({ baseURL: mock.url, key: FAKE_KEY })
    await waitFor(
      async () => {
        const { models } = await listModels(server)
        const ready = MODELS.every((m) => models.some((x) => x.providerID === m.providerID && x.id === m.id))
        const discovered = mock.requests.some((r) => r.path === "/v1/models")
        return ready && discovered ? true : undefined
      },
      60_000,
      "plugin models",
    )
    await new Promise((resolve) => setTimeout(resolve, 2000)) // Let the provider reload settle.
    feed = await server.subscribe()
  }, 120_000)

  afterAll(async () => {
    feed?.close()
    await server?.stop()
    mock?.stop()
  })

  for (const model of MODELS) {
    test(
      `${model.providerID}/${model.id}: tokens and cost follow the recorded usage`,
      async () => {
        const entry = entryFor(catalog, model.id)
        expect(entry?.cost).toBeDefined()
        const agent = of(model.id, true)
        const aux = of(model.id, false)
        expect(agent.length).toBeGreaterThanOrEqual(2)

        const start = mock.requests.length
        const flow = await runPromptFlow({
          server,
          feed,
          model: { providerID: model.providerID, id: model.id },
          prompts: ["Reply with exactly the word OK.", "Reply with exactly the word OK."],
        })
        expect(flow.failures).toEqual([])
        expect(flow.steps.length).toBe(2)

        const priced = (usage: RawUsage, kind: WireKind) => {
          const u = normalizeUsage(kind, usage)
          const cost = expectedCost(entry!, {
            input: u.input,
            output: u.outputTotal - (u.reasoning ?? 0),
            reasoning: u.reasoning ?? 0,
            cacheRead: u.cacheRead,
            cacheWrite: u.cacheWrite,
          })
          return { u, cost }
        }

        flow.steps.forEach((step, index) => {
          const fixture = agent[index]!
          const { u, cost } = priced(fixture.usage!, fixture.kind)
          expect(step.tokens.input).toBe(u.input)
          expect(step.tokens.output + step.tokens.reasoning).toBe(u.outputTotal)
          if (u.reasoning !== undefined) expect(step.tokens.reasoning).toBe(u.reasoning)
          expect(step.tokens.cache.read).toBe(u.cacheRead)
          expect(step.tokens.cache.write).toBe(u.cacheWrite)
          expect(Math.abs(step.cost - cost)).toBeLessThan(1e-9)
        })

        // The session total adds the title-generation request, if the run made one.
        const titleRequests = mock.requests.slice(start).filter((r) => r.path !== "/v1/models" && !(Array.isArray(r.body?.tools) && r.body.tools.length > 0))
        const sums = { input: 0, output: 0, read: 0, write: 0, cost: 0 }
        const used = [...flow.steps.map((_, index) => agent[index]!), ...titleRequests.map((_, index) => aux[Math.min(index, aux.length - 1)]!)]
        for (const fixture of used) {
          if (!fixture?.usage) continue
          const { u, cost } = priced(fixture.usage, fixture.kind)
          sums.input += u.input
          sums.output += u.outputTotal
          sums.read += u.cacheRead
          sums.write += u.cacheWrite
          sums.cost += cost
        }
        expect(flow.session.tokens.input).toBe(sums.input)
        expect(flow.session.tokens.output + flow.session.tokens.reasoning).toBe(sums.output)
        expect(flow.session.tokens.cache.read).toBe(sums.read)
        expect(flow.session.tokens.cache.write).toBe(sums.write)
        expect(Math.abs(flow.session.cost - sums.cost)).toBeLessThan(1e-9)

        // Auth: bearer only, on every request to the gateway.
        const sent = mock.requests.slice(start).filter((r) => r.path !== "/v1/models")
        expect(sent.length).toBeGreaterThanOrEqual(2)
        for (const request of sent) {
          expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
          expect(request.headers["x-api-key"]).toBeUndefined()
          expect(request.path).toBe(agent[0]!.path)
          expect(request.body?.model).toBe(model.id)
        }
      },
      120_000,
    )
  }
})
