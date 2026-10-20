/**
 * Live usage parity test. Skipped unless `TD_LIVE=1` and `FUELIX_API_KEY` are set.
 *
 * A recording proxy sits between OpenCode and the real FueliX gateway. For each cheap model the test sends two
 * prompts, then compares the usage that FueliX reported on the wire with the per-step tokens and cost that
 * OpenCode recorded. The proxy never stores the key; it records only the auth scheme.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { entryFor, expectedCost, listModels, loadCatalog, startFuelixServer } from "./fuelix-helpers.ts"
import { repoRoot, waitFor, type EventFeed } from "./harness.ts"
import { runPromptFlow, type FlowResult } from "./session-flow.ts"
import { authScheme, hasTools, kindOfPath, normalizeUsage, parseUsage, type NormalizedUsage, type RawUsage, type WireKind } from "./wire.ts"

const KEY = process.env.FUELIX_API_KEY ?? ""
const LIVE = process.env.TD_LIVE === "1" && KEY !== ""
// The override exists so the test itself can be checked against a local stand-in without cost.
const UPSTREAM = process.env.TD_LIVE_UPSTREAM ?? "https://api.fuelix.ai"
const RECORD = process.env.RECORD_FIXTURES === "1"
const FIXTURE_DIR = process.env.TD_FIXTURE_DIR ?? join(repoRoot(), "test", "fixtures", "fuelix-wire")

const MODELS = [
  { providerID: "fuelix-openai", id: "gpt-5-nano" },
  { providerID: "fuelix-anthropic", id: "claude-haiku-4-5" },
  { providerID: "fuelix", id: "gemini-2.5-flash-lite" },
] as const

interface ProxyRecord {
  index: number
  method: string
  path: string
  requestModel: string | undefined
  tools: boolean
  status: number
  scheme: "bearer" | "x-api-key" | "none"
  contentType: string
  kind: WireKind | undefined
  usage: RawUsage | undefined
  /** Response body text. It is model output only (no headers, no key). */
  body: string
  done: Promise<void>
}

/** Recording proxy. Never reads the key; it looks only at the auth scheme. */
function startRecordingProxy() {
  const records: ProxyRecord[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
      let json: any
      try {
        json = text ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      headers.set("accept-encoding", "identity")
      const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { method: request.method, headers, body: text })
      const contentType = upstream.headers.get("content-type") ?? ""
      const record: ProxyRecord = {
        index: records.length,
        method: request.method,
        path: url.pathname,
        requestModel: typeof json?.model === "string" ? json.model : undefined,
        tools: hasTools(json),
        status: upstream.status,
        scheme: authScheme(request.headers),
        contentType,
        kind: kindOfPath(url.pathname),
        usage: undefined,
        body: "",
        done: Promise.resolve(),
      }
      records.push(record)
      if (!upstream.body) return new Response(null, { status: upstream.status })
      const chunks: Uint8Array[] = []
      let finish: () => void = () => {}
      record.done = new Promise<void>((resolve) => {
        finish = resolve
      })
      // Collect what the client reads. Finalize when the stream ends or when the client cancels it
      // (OpenCode can stop reading after the last chunk, so a flush callback alone is not enough).
      let finalized = false
      const finalize = () => {
        if (finalized) return
        finalized = true
        record.body = Buffer.concat(chunks).toString("utf8")
        if (record.kind) record.usage = parseUsage(record.kind, contentType, record.body)
        finish()
      }
      const reader = upstream.body.getReader()
      const forClient = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              controller.close()
              finalize()
              return
            }
            chunks.push(value)
            controller.enqueue(value)
          } catch (error) {
            finalize()
            controller.error(error)
          }
        },
        async cancel(reason) {
          finalize()
          await reader.cancel(reason).catch(() => undefined)
        },
      })
      const responseHeaders = new Headers(upstream.headers)
      for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) responseHeaders.delete(name)
      return new Response(forClient, { status: upstream.status, headers: responseHeaders })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, records, stop: () => void server.stop(true) }
}

interface Row {
  step: string
  field: string
  fuelix: string
  opencode: string
  match: string
}

const fmtCost = (value: number) => value.toFixed(10)

function compareStep(
  label: string,
  fuelix: NormalizedUsage,
  step: FlowResult["steps"][number],
  expected: number,
  rows: Row[],
  mismatches: string[],
) {
  const add = (field: string, left: number | undefined, right: number, tolerance = 0) => {
    const comparable = left !== undefined
    const ok = !comparable || Math.abs(left - right) <= tolerance
    rows.push({
      step: label,
      field,
      fuelix: comparable ? (tolerance > 0 ? fmtCost(left) : String(left)) : "n/a",
      opencode: tolerance > 0 ? fmtCost(right) : String(right),
      match: comparable ? (ok ? "yes" : "NO") : "—",
    })
    if (!ok) mismatches.push(`${label} ${field}: FueliX ${left} vs OpenCode ${right}`)
  }
  add("input", fuelix.input, step.tokens.input)
  add("output+reasoning", fuelix.outputTotal, step.tokens.output + step.tokens.reasoning)
  add("reasoning", fuelix.reasoning, step.tokens.reasoning)
  add("cache.read", fuelix.cacheRead, step.tokens.cache.read)
  add("cache.write", fuelix.cacheWrite, step.tokens.cache.write)
  add("cost (USD)", expected, step.cost, 1e-9)
  for (const note of fuelix.notes) rows.push({ step: label, field: "note", fuelix: note, opencode: "", match: "—" })
}

function table(rows: Row[]): string {
  const lines = ["| step | field | FueliX | OpenCode | match |", "|---|---|---|---|---|"]
  for (const row of rows) lines.push(`| ${row.step} | ${row.field} | ${row.fuelix} | ${row.opencode} | ${row.match} |`)
  return lines.join("\n")
}

function saveFixtures(providerID: string, modelID: string, agent: ProxyRecord[], aux: ProxyRecord[]) {
  mkdirSync(FIXTURE_DIR, { recursive: true })
  const save = (record: ProxyRecord, name: string) => {
    if (record.body.includes(KEY)) throw new Error("refusing to write a fixture that contains the key")
    const sse = record.contentType.includes("text/event-stream")
    const bodyFile = `${name}${sse ? ".sse" : ".body.json"}`
    writeFileSync(join(FIXTURE_DIR, bodyFile), record.body)
    writeFileSync(
      join(FIXTURE_DIR, `${name}.json`),
      `${JSON.stringify(
        {
          providerID,
          modelID,
          path: record.path,
          status: record.status,
          contentType: record.contentType,
          bodyFile,
          tools: record.tools,
          kind: record.kind,
          usage: record.usage,
        },
        null,
        2,
      )}\n`,
    )
  }
  agent.forEach((record, index) => save(record, `${providerID}-${modelID}-${index + 1}`))
  aux.forEach((record, index) => save(record, `${providerID}-${modelID}-aux-${index + 1}`))
}

describe.skipIf(!LIVE)("live FueliX usage parity", () => {
  test(
    "OpenCode tokens and cost match the usage that FueliX reports",
    async () => {
      const catalog = loadCatalog()
      const proxy = startRecordingProxy()
      const server = await startFuelixServer({ baseURL: proxy.url, key: KEY })
      let feed: EventFeed | undefined
      const mismatches: string[] = []
      const failures: string[] = []
      try {
        // Discovery goes through the proxy too. Wait until it finished and the target models exist.
        // The first API request boots the location (and the plugin), so list the models on every poll.
        await waitFor(async () => {
          const { models } = await listModels(server)
          const discovery = proxy.records.find((r) => r.path === "/v1/models")
          if (!discovery) return undefined
          await Promise.race([discovery.done, new Promise((resolve) => setTimeout(resolve, 5_000))])
          return MODELS.every((m) => models.some((x) => x.providerID === m.providerID && x.id === m.id)) ? true : undefined
        }, 90_000, "discovery and target models")
        await new Promise((resolve) => setTimeout(resolve, 2000)) // Let the provider reload settle.
        feed = await server.subscribe()

        for (const model of MODELS) {
          const entry = entryFor(catalog, model.id)
          if (!entry?.cost) throw new Error(`catalog has no price for ${model.id}`)
          const start = proxy.records.length
          const flow = await runPromptFlow({
            server,
            feed,
            model: { providerID: model.providerID, id: model.id },
            prompts: ["Reply with exactly the word OK.", "Reply with exactly the word OK."],
          })
          const mine = proxy.records.slice(start).filter((r) => r.path !== "/v1/models")
          await Promise.all(mine.map((r) => Promise.race([r.done, new Promise((resolve) => setTimeout(resolve, 10_000))])))
          const agent = mine.filter((r) => r.tools && r.requestModel === model.id && r.kind)
          const aux = mine.filter((r) => !agent.includes(r))
          const label = `${model.providerID}/${model.id}`

          for (const failure of flow.failures) failures.push(`${label}: ${failure}`)
          for (const record of mine) {
            if (record.scheme !== "bearer") failures.push(`${label}: ${record.path} used auth scheme ${record.scheme}`)
            if (record.status !== 200) failures.push(`${label}: ${record.path} returned HTTP ${record.status}`)
          }
          if (agent.length !== flow.steps.length) {
            mismatches.push(`${label}: ${agent.length} agent requests but ${flow.steps.length} OpenCode steps`)
          }

          const rows: Row[] = []
          for (let i = 0; i < Math.min(agent.length, flow.steps.length); i++) {
            const record = agent[i]!
            if (!record.usage) {
              mismatches.push(`${label} step ${i + 1}: no usage in the ${record.kind} response`)
              continue
            }
            const fuelix = normalizeUsage(record.kind!, record.usage)
            const expected = expectedCost(entry, {
              input: fuelix.input,
              output: fuelix.outputTotal - (fuelix.reasoning ?? 0),
              reasoning: fuelix.reasoning ?? 0,
              cacheRead: fuelix.cacheRead,
              cacheWrite: fuelix.cacheWrite,
            })
            compareStep(`${i + 1} (${record.kind})`, fuelix, flow.steps[i]!, expected, rows, mismatches)
          }

          // Session totals. OpenCode adds the title-generation request to the session total, so the FueliX side
          // is the sum over every request of the run (agent and non-agent).
          const sum = { input: 0, output: 0, read: 0, write: 0, cost: 0 }
          for (const record of mine) {
            if (!record.usage || !record.kind) continue
            const u = normalizeUsage(record.kind, record.usage)
            sum.input += u.input
            sum.output += u.outputTotal
            sum.read += u.cacheRead
            sum.write += u.cacheWrite
            sum.cost += expectedCost(entry, {
              input: u.input,
              output: u.outputTotal - (u.reasoning ?? 0),
              reasoning: u.reasoning ?? 0,
              cacheRead: u.cacheRead,
              cacheWrite: u.cacheWrite,
            })
          }
          const total = flow.session
          const totalRow = (field: string, left: number, right: number, tolerance = 0) => {
            const ok = Math.abs(left - right) <= tolerance
            rows.push({
              step: "session total",
              field,
              fuelix: tolerance > 0 ? fmtCost(left) : String(left),
              opencode: tolerance > 0 ? fmtCost(right) : String(right),
              match: ok ? "yes" : "NO",
            })
            if (!ok) mismatches.push(`${label} session total ${field}: FueliX ${left} vs OpenCode ${right}`)
          }
          totalRow("input", sum.input, total.tokens.input)
          totalRow("output+reasoning", sum.output, total.tokens.output + total.tokens.reasoning)
          totalRow("cache.read", sum.read, total.tokens.cache.read)
          totalRow("cache.write", sum.write, total.tokens.cache.write)
          totalRow("cost (USD)", sum.cost, total.cost, 1e-9)

          console.log(`\n### ${label}\n\n${table(rows)}\n`)
          if (aux.length > 0) {
            console.log(`Non-agent requests of ${label}:`)
            for (const record of aux) {
              const usage = record.usage && record.kind ? normalizeUsage(record.kind, record.usage) : undefined
              console.log(
                `- ${record.method} ${record.path} model=${record.requestModel} tools=${record.tools} status=${record.status} auth=${record.scheme} usage=${usage ? JSON.stringify({ input: usage.input, output: usage.outputTotal, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }) : "n/a"}`,
              )
            }
          }
          if (RECORD) saveFixtures(model.providerID, model.id, agent, aux)
        }
      } finally {
        feed?.close()
        await server.stop()
        proxy.stop()
      }
      if (mismatches.length > 0) console.log(`MISMATCHES:\n${mismatches.map((m) => `- ${m}`).join("\n")}`)
      expect(failures).toEqual([])
      expect(mismatches).toEqual([])
    },
    300_000,
  )
})
