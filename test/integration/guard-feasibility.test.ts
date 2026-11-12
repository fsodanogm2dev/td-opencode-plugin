/**
 * Guard feasibility spike. Proves, on an isolated OpenCode server with a deterministic fake provider, whether
 * `ctx.permission.hook("evaluate")` can deny ordinary auto-allowed tool calls.
 *
 * Blockers checked:
 *  1. The evaluate hook runs for an auto-allowed shell tool call, with the command in `resources` or `metadata`.
 *  2. A denied shell call does not execute, and the agent continues with a permitted command.
 *  3. A subagent (child session) uses the same hook with the child sessionID, and `session.get` gives the parentID.
 *
 * It also records the durable `session.execution.*` events.
 *
 * Runtime artifacts go to `<tmpdir>/opencode/guard-feasibility-*` (or `GUARD_ARTIFACT_DIR`). No key, no live model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLifecycleText, resolveLifecycleViews } from "../../src/guards/lifecycle-history.ts"
import { parseLifecycleLine, parseRuntimeReport, type Activation } from "../../src/guards/schema.ts"
import { FAKE_KEY, listModels, startMockFuelix, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { pluginEntry, repoRoot, startIsolatedServer, waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"

const MODEL = { providerID: "fuelix", id: "gemini-2.5-flash-lite" } as const
const DENY_TOKEN = "guard-denied"
const DENY_MESSAGE = "TD guard blocks this action"

const artifactDir = process.env.GUARD_ARTIFACT_DIR ?? join(tmpdir(), "opencode", `guard-feasibility-${Date.now()}`)
mkdirSync(artifactDir, { recursive: true })
const probeLog = join(artifactDir, "probe-evaluations.jsonl")
const requestLog = join(artifactDir, "provider-requests.jsonl")
const reportFile = join(artifactDir, "report.json")
const report: Record<string, unknown> = { artifactDir }

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic fake provider (OpenAI Chat Completions streaming)
// ---------------------------------------------------------------------------------------------------------------------

type Script = { tool: string; args: Record<string, unknown> } | { text: string }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}

function sse(model: string, script: Script): Response {
  const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1_700_000_000, model }
  const frames: unknown[] =
    "tool" in script
      ? [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: script.tool, arguments: JSON.stringify(script.args) } },
                  ],
                },
              },
            ],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
  frames.push({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

interface Scenario {
  /** Tool name of the shell tool, filled in from the first request that lists tools. */
  shellTool: string
  taskTool: string
  dir: string
}
const scenario: Scenario = { shellTool: "shell", taskTool: "subagent", dir: "" }
const toolNames = new Set<string>()
const toolSchemas: Record<string, unknown> = {}

function respond(request: RecordedRequest): Response | Promise<Response> | undefined {
  if (request.path !== "/chat/completions") return undefined
  const body = request.body
  const model = String(body?.model ?? MODEL.id)
  appendLog(requestLog, {
    messages: (body?.messages ?? []).map((m: any) => ({ role: m.role, content: textOf(m.content).slice(0, 300), tool_calls: m.tool_calls?.map((c: any) => c.function) })),
    tools: (body?.tools ?? []).map((t: any) => t.function?.name),
  })
  const tools: any[] = body?.tools ?? []
  if (tools.length === 0) return sse(model, { text: "Probe title" }) // Title request has no tools.
  for (const tool of tools) {
    toolNames.add(tool.function?.name)
    if (["shell", "subagent", "execute"].includes(tool.function?.name)) toolSchemas[tool.function.name] ??= { description: String(tool.function.description).slice(0, 3000), parameters: tool.function.parameters }
  }
  const messages: any[] = body.messages ?? []
  // The latest user message selects the scenario. Only tool results after it count, so one session can run many prompts.
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user")
  const firstUser = textOf(messages[lastUserIndex]?.content)
  const toolResults = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").length
  const deniedCmd = `echo "git commit -m ${DENY_TOKEN}"; printf x > ${scenario.dir}/denied-root.marker`
  const allowedCmd = `printf x > ${scenario.dir}/allowed-root.marker`

  if (firstUser.includes("SCENARIO_HANG")) return new Promise<Response>(() => {}) // never answers
  if (firstUser.includes("SCENARIO_ROOT")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: deniedCmd, timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: allowedCmd, timeout: 20000 } })
    return sse(model, { text: "ROOT DONE" })
  }
  if (firstUser.includes("SCENARIO_EXEC")) {
    // Code Mode: the shell tool is called from inside the `execute` tool.
    const code = `return await tools.shell({ command: ${JSON.stringify(deniedCmd.replace("denied-root", "denied-exec"))} })`
    if (toolResults === 0) return sse(model, { tool: "execute", args: { code } })
    return sse(model, { text: "EXEC DONE" })
  }
  if (firstUser.includes("SCENARIO_PARENT")) {
    if (toolResults === 0) {
      return sse(model, {
        tool: scenario.taskTool,
        args: { description: "child probe", prompt: "SCENARIO_CHILD run the commands", agent: "general" },
      })
    }
    return sse(model, { text: "PARENT DONE" })
  }
  if (firstUser.includes("SCENARIO_CHILD")) {
    const denied = `echo "git commit -m ${DENY_TOKEN}"; printf x > ${scenario.dir}/denied-child.marker`
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: denied, timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/allowed-child.marker`, timeout: 20000 } })
    return sse(model, { text: "CHILD DONE" })
  }
  // Real guard scenarios. They run a fake `git` (logs one line per run) and harmless marker commands.
  if (firstUser.includes("GSCN_ONE")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "git commit -m guarded", timeout: 20000 } })
    return sse(model, { text: "GSCN ONE DONE" })
  }
  if (firstUser.includes("GSCN_ROOT")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "git commit -m guarded", timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: `echo 'git commit' > ${scenario.dir}/echo-quoted.marker`, timeout: 20000 } })
    if (toolResults === 2) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/allowed-g-root.marker`, timeout: 20000 } })
    return sse(model, { text: "GSCN ROOT DONE" })
  }
  if (firstUser.includes("GSCN_PARENT")) {
    if (toolResults === 0) {
      return sse(model, { tool: scenario.taskTool, args: { description: "g child", prompt: "GSCN_CHILD run the commands", agent: "general" } })
    }
    return sse(model, { text: "GSCN PARENT DONE" })
  }
  if (firstUser.includes("GSCN_CHILD")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "/usr/bin/env git -C . commit -m guarded", timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/allowed-g-child.marker`, timeout: 20000 } })
    return sse(model, { text: "GSCN CHILD DONE" })
  }
  return sse(model, { text: "UNSCRIPTED" })
}

function appendLog(file: string, entry: unknown) {
  writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: "a" })
}

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------------------------------------------------

describe("guard feasibility (permission evaluate hook)", () => {
  let mock: MockFuelix
  let server: IsolatedServer
  let feed: EventFeed
  let sandbox: string

  beforeAll(async () => {
    mock = startMockFuelix({ models: [MODEL.id], handler: (request) => respond(request) })
    const probeDir = join(repoRoot(), "test", "fixtures", "guards-probe")
    server = await startIsolatedServer({
      config: {
        plugins: [
          pluginEntry({ fuelix: { baseURL: mock.url, keychainService: false, refreshMinutes: 0 } }),
          { package: probeDir, options: { logFile: probeLog, denyToken: DENY_TOKEN, message: DENY_MESSAGE } },
        ],
      },
      env: { FUELIX_API_KEY: FAKE_KEY },
    })
    sandbox = join(server.dirs.root, "sandbox")
    mkdirSync(sandbox, { recursive: true })
    Bun.spawnSync(["git", "init", "-q", sandbox])
    scenario.dir = sandbox
    await waitFor(
      async () => {
        const { models } = await listModels(server)
        return models.some((m) => m.providerID === MODEL.providerID && m.id === MODEL.id) ? true : undefined
      },
      60_000,
      "fake model",
    )
    await new Promise((resolve) => setTimeout(resolve, 2000))
    feed = await server.subscribe()
    report.pluginsReady = readJsonl(probeLog).some((e) => e.kind === "setup")
  }, 120_000)

  afterAll(async () => {
    writeFileSync(
      reportFile,
      JSON.stringify({ ...report, toolNames: [...toolNames], toolSchemas, serverLogs: server?.logs().slice(-4000) }, null, 2),
    )
    feed?.close()
    await server?.stop()
    mock?.stop()
    console.log(`guard feasibility artifacts: ${artifactDir}`)
  })

  async function runSession(text: string) {
    const created = await server.api<{ data: { id: string } }>("POST", "/api/session", {
      location: { directory: sandbox },
      model: MODEL,
    })
    expect(created.status).toBe(200)
    const sessionID = created.json.data.id
    const sent = await server.api("POST", `/api/session/${sessionID}/prompt`, { text })
    expect(sent.status).toBe(200)
    await server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    return sessionID
  }

  const executionEvents = () =>
    feed.events
      .filter((e) => e.type.startsWith("session.execution."))
      .map((e) => ({ type: e.type, sessionID: e.data?.sessionID, reason: e.data?.reason }))

  test("root session: evaluate runs for shell, denies without executing, agent continues", async () => {
    const before = readJsonl(probeLog).length
    const sessionID = await runSession("SCENARIO_ROOT please run the probe commands")
    const evaluations = readJsonl(probeLog).slice(before).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID)
    report.root = { sessionID, evaluations, execution: executionEvents().filter((e) => e.sessionID === sessionID) }
    const messages = await server.api<any>("GET", `/api/session/${sessionID}/message`)
    report.rootMessages = JSON.stringify(messages.json).slice(0, 6000)

    // (1) hook ran for the shell tool call(s) and exposes the command.
    expect(evaluations.length).toBeGreaterThanOrEqual(2)
    const withCommand = evaluations.filter((e) => JSON.stringify({ r: e.resources, m: e.metadata }).includes("denied-root.marker") || JSON.stringify({ r: e.resources, m: e.metadata }).includes("allowed-root.marker"))
    expect(withCommand.length).toBeGreaterThanOrEqual(2)
    expect(evaluations.some((e) => e.denied)).toBe(true)
    // Incoming effect shows whether the call was auto-allowed before the hook.
    report.rootIncomingEffects = evaluations.map((e) => ({ action: e.action, incomingEffect: e.incomingEffect, denied: e.denied }))

    // (2) side effect blocked, permitted command ran, and the model saw the guard message and continued.
    expect(existsSync(join(sandbox, "denied-root.marker"))).toBe(false)
    expect(existsSync(join(sandbox, "allowed-root.marker"))).toBe(true)
    expect(JSON.stringify(messages.json)).toContain(DENY_MESSAGE)
    expect(JSON.stringify(messages.json)).toContain("ROOT DONE")
    const provider = readJsonl(requestLog)
    const secondRequest = provider.find((r) => r.messages.some((m: any) => m.role === "tool" && String(m.content).includes(DENY_MESSAGE)))
    expect(secondRequest).toBeDefined()

    // Execution events for the root.
    const exec = executionEvents().filter((e) => e.sessionID === sessionID).map((e) => e.type)
    expect(exec).toContain("session.execution.started")
    expect(exec).toContain("session.execution.succeeded")
  }, 120_000)

  test("subagent: child session uses evaluate with child sessionID and parentID", async () => {
    const before = readJsonl(probeLog).length
    const sessionID = await runSession("SCENARIO_PARENT delegate to a child")
    const evaluations = readJsonl(probeLog).slice(before).filter((e) => e.kind === "evaluate")
    const children = [...new Set(evaluations.map((e) => e.sessionID).filter((id) => id !== sessionID))]
    report.subagent = {
      parentSessionID: sessionID,
      evaluations,
      children,
      execution: executionEvents(),
      markers: {
        deniedChild: existsSync(join(sandbox, "denied-child.marker")),
        allowedChild: existsSync(join(sandbox, "allowed-child.marker")),
      },
    }
    expect(children.length).toBe(1)
    const childEvals = evaluations.filter((e) => e.sessionID === children[0])
    expect(childEvals.length).toBeGreaterThanOrEqual(2)
    for (const e of childEvals) expect(e.parentID).toBe(sessionID)
    // The task tool call itself, in the parent, is also evaluated.
    expect(evaluations.some((e) => e.sessionID === sessionID && e.action === "subagent" && e.resources.includes("general"))).toBe(true)
    expect(childEvals.some((e) => e.denied)).toBe(true)
    expect(existsSync(join(sandbox, "denied-child.marker"))).toBe(false)
    expect(existsSync(join(sandbox, "allowed-child.marker"))).toBe(true)
    const exec = executionEvents()
    expect(exec.some((e) => e.sessionID === children[0] && e.type === "session.execution.started")).toBe(true)
  }, 120_000)

  test("code mode: shell called through the execute tool (bypass check)", async () => {
    const before = readJsonl(probeLog).length
    const sessionID = await runSession("SCENARIO_EXEC run code")
    const evaluations = readJsonl(probeLog).slice(before).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID)
    const messages = await server.api<any>("GET", `/api/session/${sessionID}/message`)
    report.codeMode = {
      sessionID,
      evaluations,
      deniedMarkerExists: existsSync(join(sandbox, "denied-exec.marker")),
      provider: readJsonl(requestLog).filter((r) => r.messages.some((m: any) => m.role === "user" && String(m.content).includes("SCENARIO_EXEC"))).slice(-1),
      messages: JSON.stringify(messages.json).slice(0, 3000),
    }
    // Observed on 2.2.5: built-in tools are not callable from Code Mode, so `execute` is not a shell bypass here.
    // Plugin and MCP tools in the Code Mode catalog are NOT probed.
    expect(JSON.stringify(messages.json)).toContain("Unknown tool 'shell'")
    expect(existsSync(join(sandbox, "denied-exec.marker"))).toBe(false)
  }, 120_000)

  test("interrupt: durable session.execution.interrupted event", async () => {
    // A scripted model call that never returns lets the test interrupt a running execution.
    const created = await server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: sandbox }, model: MODEL })
    const sessionID = created.json.data.id
    await server.api("POST", `/api/session/${sessionID}/prompt`, { text: "SCENARIO_HANG" })
    await waitFor(async () => (executionEvents().some((e) => e.sessionID === sessionID && e.type === "session.execution.started") ? true : undefined), 30_000, "hang started")
    const interrupted = await server.api("POST", `/api/session/${sessionID}/interrupt`)
    report.interruptStatus = interrupted.status
    await new Promise((resolve) => setTimeout(resolve, 1500))
    report.interrupt = executionEvents().filter((e) => e.sessionID === sessionID)
    expect(executionEvents().some((e) => e.sessionID === sessionID && e.type === "session.execution.interrupted")).toBe(true)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// Real guards: `setupGuards` from this repository, loaded as a local plugin on an isolated server.
// The test writes `store.json` as the extension service does. A fake `git` records each run, so a blocked command
// is proven not to have executed. The `guards-probe` plugin only records the effect that arrives at the hook.
// ---------------------------------------------------------------------------------------------------------------------

interface GuardRig {
  server: IsolatedServer
  feed: EventFeed
  mock: MockFuelix
  sandbox: string
  binDir: string
  probeFile: string
  guardsDir: string
  stop(): Promise<void>
}

const COMMIT_GUARD = {
  id: "g-commit",
  label: "No commits",
  summary: "Blocks git commit",
  request: "Never commit",
  message: "TD guard test: git commit is blocked for this session.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
  createdAt: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-12T10:00:00.000Z",
}

async function startRig(extraConfig: Record<string, unknown> = {}, probeFirst = false): Promise<GuardRig> {
  const sandbox = mkdtempSync(join(tmpdir(), "td-guards-sandbox-"))
  const binDir = mkdtempSync(join(tmpdir(), "td-guards-bin-"))
  const fakeGit = join(binDir, "git")
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "x\\n" >> "$GUARD_MARKER_DIR/git-runs.log"\n')
  chmodSync(fakeGit, 0o755)
  scenario.dir = sandbox
  const probeFile = join(sandbox, "probe-evaluations.jsonl")
  const mock = startMockFuelix({ models: [MODEL.id], handler: (request) => respond(request) })
  const entry = pluginEntry({ fuelix: { baseURL: mock.url, keychainService: false, refreshMinutes: 0 } })
  const probe = { package: join(repoRoot(), "test", "fixtures", "guards-probe"), options: { logFile: probeFile, denyToken: "NEVER-MATCHES-THIS-TOKEN" } }
  const server = await startIsolatedServer({
    config: {
      plugins: probeFirst ? [probe, entry] : [entry, probe],
      ...extraConfig,
    },
    env: { FUELIX_API_KEY: FAKE_KEY, PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, GUARD_MARKER_DIR: sandbox },
  })
  await waitFor(
    async () => {
      const { models } = await listModels(server)
      return models.some((m) => m.providerID === MODEL.providerID && m.id === MODEL.id) ? true : undefined
    },
    60_000,
    "fake model",
  )
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const feed = await server.subscribe()
  return {
    server,
    feed,
    mock,
    sandbox,
    binDir,
    probeFile,
    guardsDir: join(server.dirs.home, ".td-opencode-plugin", "guards"),
    async stop() {
      feed.close()
      await server.stop()
      mock.stop()
      rmSync(sandbox, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    },
  }
}

describe("guards: real plugin on an isolated server", () => {
  let rig: GuardRig
  let revision = 0
  const gitRuns = () => (existsSync(join(rig.sandbox, "git-runs.log")) ? readFileSync(join(rig.sandbox, "git-runs.log"), "utf8").split("\n").filter(Boolean).length : 0)
  const facts = () =>
    existsSync(join(rig.guardsDir, "lifecycle.jsonl"))
      ? readFileSync(join(rig.guardsDir, "lifecycle.jsonl"), "utf8").split("\n").map(parseLifecycleLine).filter((fact) => fact !== undefined)
      : []

  /** Writes the store as the extension service does: atomically, with a new revision. */
  function writeStore(activations: unknown[]) {
    revision++
    mkdirSync(rig.guardsDir, { recursive: true })
    const temporary = join(rig.guardsDir, `.store-${revision}.tmp`)
    writeFileSync(temporary, JSON.stringify({ schema: "td-guards/1", revision, guards: [COMMIT_GUARD], activations }))
    renameSync(temporary, join(rig.guardsDir, "store.json"))
  }
  const activation = (id: string, sessionId: string, extra: Partial<Activation> = {}): Activation => ({
    id,
    guardId: COMMIT_GUARD.id,
    sessionId,
    scope: "session",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    ...extra,
  })
  async function newSession(): Promise<string> {
    const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: rig.sandbox }, model: MODEL })
    expect(created.status).toBe(200)
    return created.json.data.id
  }
  async function prompt(sessionID: string, text: string) {
    // A connection that idled during a long wait can be closed by the server. The request was then not sent: retry once.
    const send = async () => {
      try {
        return await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text })
      } catch {
        return await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text })
      }
    }
    const sent = await send()
    expect(sent.status).toBe(200)
    await rig.server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const messages = await rig.server.api<any>("GET", `/api/session/${sessionID}/message`)
    return JSON.stringify(messages.json)
  }

  beforeAll(async () => {
    rig = await startRig()
  }, 150_000)
  afterAll(async () => {
    await rig?.stop()
  })

  test("without a guard the fake git runs; the plugin reports itself registered", async () => {
    const before = gitRuns()
    const sessionID = await newSession()
    const messages = await prompt(sessionID, "GSCN_ONE commit")
    expect(messages).toContain("GSCN ONE DONE")
    expect(gitRuns()).toBe(before + 1)
    const runtimeDir = join(rig.guardsDir, "runtime")
    await waitFor(async () => (existsSync(runtimeDir) && readdirSync(runtimeDir).some((f) => f.endsWith(".json")) ? true : undefined), 20_000, "runtime report")
    const reports = readdirSync(runtimeDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseRuntimeReport(JSON.parse(readFileSync(join(runtimeDir, f), "utf8"))))
    expect(reports.every((r) => r.ok)).toBe(true)
    const ok = reports.flatMap((r) => (r.ok ? [r.value] : []))
    expect(ok.some((r) => r.registered && r.coveredActions.includes("shell") && r.storeState === "missing")).toBe(true)
    for (const f of readdirSync(runtimeDir)) expect(statSync(join(runtimeDir, f)).mode & 0o077).toBe(0)
  }, 120_000)

  test("root: a guarded command is denied before it runs, quoted text and other work proceed, no prompt", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-root", sessionID)])
    const before = gitRuns()
    const probeBefore = readJsonl(rig.probeFile).length
    const messages = await prompt(sessionID, "GSCN_ROOT run the commands")
    expect(gitRuns()).toBe(before) // The fake git never ran.
    expect(messages).toContain(COMMIT_GUARD.message)
    expect(messages).toContain("GSCN ROOT DONE")
    expect(existsSync(join(rig.sandbox, "echo-quoted.marker"))).toBe(true) // echo 'git commit' is only text.
    expect(existsSync(join(rig.sandbox, "allowed-g-root.marker"))).toBe(true)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked" && e.data?.sessionID === sessionID)).toHaveLength(0)
    const evaluations = readJsonl(rig.probeFile).slice(probeBefore).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID)
    report.guardsRoot = { incoming: evaluations.map((e) => ({ action: e.action, incomingEffect: e.incomingEffect })) }
    expect(evaluations.length).toBeGreaterThanOrEqual(3)
    const provider = readJsonl(requestLog)
    expect(provider.some((r) => r.messages.some((m: any) => m.role === "tool" && String(m.content).includes(COMMIT_GUARD.message)))).toBe(true)
  }, 120_000)

  test("subagent: the child session inherits the guard from its root", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-parent", sessionID)])
    const before = gitRuns()
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE")
    expect(gitRuns()).toBe(before)
    expect(existsSync(join(rig.sandbox, "allowed-g-child.marker"))).toBe(true)
    const children = [...new Set(readJsonl(rig.probeFile).filter((e) => e.parentID === sessionID).map((e) => e.sessionID))]
    expect(children.length).toBe(1)
    const child = await rig.server.api<any>("GET", `/api/session/${children[0]}/message`)
    expect(JSON.stringify(child.json)).toContain(COMMIT_GUARD.message)
  }, 120_000)

  test("an unguarded session is unaffected; deleting the activation stops the guard", async () => {
    const guarded = await newSession()
    const free = await newSession()
    writeStore([activation("act-g", guarded)])
    const before = gitRuns()
    await prompt(guarded, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before)
    await prompt(free, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
    writeStore([])
    await prompt(guarded, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 2)
  }, 120_000)

  test("explicit expiry is honored at the next action; no expiry means the guard stays", async () => {
    const timed = await newSession()
    const forever = await newSession()
    writeStore([
      activation("act-timed", timed, { expiresAt: new Date(Date.now() + 6_000).toISOString() }),
      activation("act-forever", forever),
    ])
    const before = gitRuns()
    await prompt(timed, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // Before expiry: denied.
    await new Promise((resolve) => setTimeout(resolve, 6_000)) // The explicit expiry passes. No timer fires in the plugin.
    await prompt(timed, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1) // After expiry: allowed.
    await prompt(forever, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1) // No expiry: still denied.
  }, 120_000)

  test("request scope: bound on the next run, released after the root and its subagent end", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-request", sessionID, { scope: "request" })])
    const before = gitRuns()
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE")
    expect(gitRuns()).toBe(before)
    await waitFor(async () => (facts().some((f) => f.activationId === "act-request" && f.fact === "ended") ? true : undefined), 20_000, "ended fact")
    const mine = facts().filter((f) => f.activationId === "act-request")
    report.requestFacts = mine
    const bound = mine.find((f) => f.fact === "bound")
    const ended = mine.find((f) => f.fact === "ended")
    expect(bound?.reason).toBe("observed-start")
    expect(ended?.reason).toBe("request-completed")
    expect(mine.some((f) => f.fact === "uncertain")).toBe(false)
    expect(Date.parse(bound!.at)).toBeLessThanOrEqual(Date.parse(ended!.at))
    // The store still lists the activation (only the service deletes it). The backend has released it.
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
  }, 120_000)

  test("request scope with a built-in subagent: child denied, root and child end, persisted end, next request runs", async () => {
    const sessionID = await newSession()
    const requestActivation = activation("act-conj", sessionID, { scope: "request" })
    writeStore([requestActivation])
    const storeFile = join(rig.guardsDir, "store.json")
    const storeBefore = readFileSync(storeFile, "utf8")
    rmSync(join(rig.sandbox, "allowed-g-child.marker"), { force: true })
    const before = gitRuns()
    const probeBefore = readJsonl(rig.probeFile).length
    const askedBefore = rig.feed.events.filter((e) => e.type === "permission.asked").length

    // Request 1: the root delegates to a built-in subagent whose first command is guarded.
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE") // The agent continued.
    expect(gitRuns()).toBe(before) // Neither session ran the fake git.
    const evaluations = readJsonl(rig.probeFile).slice(probeBefore)
    const childID = [...new Set(evaluations.filter((e) => e.parentID === sessionID).map((e) => e.sessionID))][0] as string
    expect(childID).toBeDefined()
    const child = JSON.stringify((await rig.server.api<any>("GET", `/api/session/${childID}/message`)).json)
    expect(child).toContain(COMMIT_GUARD.message) // The child was denied directly.
    expect(child).toContain("GSCN CHILD DONE")
    expect(existsSync(join(rig.sandbox, "allowed-g-child.marker"))).toBe(true)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(askedBefore) // No prompts.

    // The persisted log proves one clean sequence, and the end is later than the end of BOTH sessions.
    await waitFor(async () => (facts().some((f) => f.activationId === "act-conj" && f.fact === "ended") ? true : undefined), 20_000, "ended fact")
    const mine = facts().filter((f) => f.activationId === "act-conj")
    expect(mine.map((f) => f.fact).filter((fact, index, all) => all.indexOf(fact) === index)).toEqual(["bound", "ended"])
    // Each plugin instance of the server may bind. The instance that ended must have bound before it ended.
    const ended = mine.find((f) => f.fact === "ended")!
    const bound = mine.find((f) => f.fact === "bound" && f.instance === ended.instance)
    expect(bound).toBeDefined()
    expect(mine.indexOf(bound!)).toBeLessThan(mine.indexOf(ended))
    expect(ended.reason).toBe("request-completed")
    expect(mine.some((f) => f.fact === "uncertain")).toBe(false)
    const lifecycleText = readFileSync(join(rig.guardsDir, "lifecycle.jsonl"), "utf8")
    const view = resolveLifecycleViews([requestActivation], parseLifecycleText(lifecycleText, false))[0]!
    expect(view).toMatchObject({ phase: "ended", releasable: true, trust: "ok" })
    const terminal = rig.feed.events.filter(
      (e) => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type) && (e.data?.sessionID === sessionID || e.data?.sessionID === childID),
    )
    expect(new Set(terminal.map((e) => e.data.sessionID))).toEqual(new Set([sessionID, childID]))
    for (const event of terminal) expect(Date.parse(ended.at)).toBeGreaterThanOrEqual(Number(event.raw?.created))

    // Request 2, in the same session: allowed. Neither the service nor the UI changed the store.
    expect(readFileSync(storeFile, "utf8")).toBe(storeBefore)
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(askedBefore)
  }, 150_000)

  test("request scope: a user interruption ends the request", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-interrupt", sessionID, { scope: "request" })])
    await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text: "SCENARIO_HANG" })
    await waitFor(async () => (facts().some((f) => f.activationId === "act-interrupt" && f.fact === "bound") ? true : undefined), 30_000, "bound fact")
    await rig.server.api("POST", `/api/session/${sessionID}/interrupt`)
    await waitFor(async () => (facts().some((f) => f.activationId === "act-interrupt" && f.fact === "ended") ? true : undefined), 30_000, "ended fact")
    expect(facts().some((f) => f.activationId === "act-interrupt" && f.fact === "uncertain")).toBe(false)
  }, 120_000)

  test("deleting store.json while a guard is active keeps it; a valid store without the activation releases it", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-delete", sessionID)])
    const before = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // The plugin reads the good store here.
    expect(gitRuns()).toBe(before)
    rmSync(join(rig.guardsDir, "store.json"))
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // The file is gone; the last good guard still applies.
    writeStore([]) // The service releases by writing a valid store.
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
  }, 120_000)

  test("a request end that another instance persisted releases the guard with no service call", async () => {
    const sessionID = await newSession()
    const created = new Date().toISOString()
    writeStore([activation("act-dead", sessionID, { scope: "request", createdAt: created })])
    const guarded = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // Binds the request in the backend (the root starts after creation).
    expect(gitRuns()).toBe(guarded)
    // A dead instance wrote the end of ANOTHER request; the live instances never saw its events.
    const other = await newSession()
    const createdOther = new Date().toISOString()
    writeStore([activation("act-dead-2", other, { scope: "request", createdAt: createdOther })])
    const at = Date.parse(createdOther) + 1
    const fact = (kind: string, ms: number, reason: string) =>
      `\n${JSON.stringify({ activationId: "act-dead-2", fact: kind, at: new Date(ms).toISOString(), reason, instance: "dead-instance" })}\n`
    writeFileSync(join(rig.guardsDir, "lifecycle.jsonl"), `${fact("bound", at, "observed-start")}{"activationId":"act-dead-2","fa${fact("ended", at + 1, "request-completed")}`, { flag: "a" })
    const baseline = gitRuns()
    await prompt(other, "GSCN_ONE commit")
    expect(gitRuns()).toBe(baseline + 1) // The persisted clean end releases it, despite the crashed fragment.
  }, 120_000)

  test("a new location with an invalid store fails closed, stays closed while the file is missing, and opens on a valid store", async () => {
    const location = mkdtempSync(join(tmpdir(), "td-guards-loc-"))
    try {
      const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: location }, model: MODEL })
      expect(created.status).toBe(200)
      const sessionID = created.json.data.id
      mkdirSync(rig.guardsDir, { recursive: true })
      writeFileSync(join(rig.guardsDir, "store.json"), "{ not a store")
      const before = gitRuns()
      const closed = await prompt(sessionID, "GSCN_ONE commit")
      report.recoveryClosed = closed.slice(0, 600)
      expect(gitRuns()).toBe(before)
      expect(closed).toContain("could not be loaded")
      rmSync(join(rig.guardsDir, "store.json"))
      await prompt(sessionID, "GSCN_ONE commit")
      expect(gitRuns()).toBe(before) // A repair can show a missing file. Still closed.
      writeStore([])
      await prompt(sessionID, "GSCN_ONE commit")
      expect(gitRuns()).toBe(before + 1) // A valid empty store opens it.
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  }, 150_000)

  test("an invalid store file after a good read keeps the last good store", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-lastgood", sessionID)])
    const before = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // The plugin reads the good store here.
    expect(gitRuns()).toBe(before)
    writeFileSync(join(rig.guardsDir, "store.json"), "{ torn write")
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // The last good store still applies.
  }, 120_000)
})

describe("guards: ordinary approval that would prompt", () => {
  let rig: GuardRig
  beforeAll(async () => {
    const rule = [{ action: "shell", resource: "*", effect: "ask" }]
    // The probe loads first, so it records the effect that ordinary permissions produce before the guard hook runs.
    rig = await startRig({ permissions: rule }, true)
  }, 150_000)
  afterAll(async () => {
    await rig?.stop()
  })

  test("a guarded command is denied without a prompt, and the agent continues", async () => {
    const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: rig.sandbox }, model: MODEL })
    const sessionID = created.json.data.id
    mkdirSync(rig.guardsDir, { recursive: true })
    writeFileSync(
      join(rig.guardsDir, "store.json"),
      JSON.stringify({
        schema: "td-guards/1",
        revision: 1,
        guards: [COMMIT_GUARD],
        activations: [{ id: "act-ask", guardId: COMMIT_GUARD.id, sessionId: sessionID, scope: "session", createdAt: new Date().toISOString(), expiresAt: null }],
      }),
    )
    await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text: "GSCN_ONE commit" })
    await rig.server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const messages = JSON.stringify((await rig.server.api<any>("GET", `/api/session/${sessionID}/message`)).json)
    const incoming = readJsonl(rig.probeFile).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID)
    report.askRig = { incoming: incoming.map((e) => ({ action: e.action, incomingEffect: e.incomingEffect })) }
    expect(messages).toContain(COMMIT_GUARD.message)
    expect(messages).toContain("GSCN ONE DONE")
    expect(existsSync(join(rig.sandbox, "git-runs.log"))).toBe(false)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(0)
    const pending = await rig.server.api<any>("GET", "/api/permission")
    expect(incoming.length).toBeGreaterThanOrEqual(1)
    expect(incoming.every((e) => e.incomingEffect === "ask")).toBe(true) // Ordinary permissions would have prompted.
    if (pending.status === 200 && pending.json !== undefined) expect(JSON.stringify(pending.json)).not.toContain("git commit")
  }, 120_000)
})
