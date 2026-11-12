/**
 * Helpers for the Jev integration tests (OpenCode V2 2.2.5).
 *
 * - `startScriptedGateway`: a mock FueliX gateway on the Chat Completions wire (`fuelix` provider, `POST /chat/completions`).
 *   It streams scripted tool calls and then final text. A request without tools is the title request.
 * - `startMockJev`: a mock TypeSafe `POST /v1/systemone` on loopback with per-test behavior.
 * - `startJevStack`: both mocks plus an isolated OpenCode server with `options.jev` enabled. Keychain lookups are off.
 * - `drivePrompt`: sends one prompt, answers pending permission requests with a controlled policy, and collects results.
 *
 * Only fake keys appear here. Tests never run destructive commands: a rejected command must never execute.
 */

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FAKE_KEY, startMockFuelix, type MockFuelix, type RecordedRequest } from "./fuelix-helpers.ts"
import { pluginEntry, startIsolatedServer, waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"

export const FAKE_JEV_KEY = "ts-test-not-a-real-typesafe-key"
export const JEV_MODEL = "jev-1.14.0"
export const AGENT_PROVIDER = "fuelix"
export const AGENT_MODEL = "gemini-2.5-flash-lite"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------------------------------
// Scripted FueliX gateway (Chat Completions)
// ---------------------------------------------------------------------------------------------------------------------

/** One scripted model turn. `shell` is the OpenCode V2 shell tool: arguments `command`, `workdir`, `timeout`. */
export type ScriptStep = { readonly tool: { readonly name: string; readonly args: Record<string, unknown> } } | { readonly text: string }

export interface ScriptedGateway {
  readonly mock: MockFuelix
  /** Chat Completions requests with tools: the agent loop. */
  agentRequests(): RecordedRequest[]
  /** Chat Completions requests without tools: the title request. */
  titleRequests(): RecordedRequest[]
  /** Replaces the queue of turns for the agent loop. When the queue is empty, the model answers "done". */
  script(steps: readonly ScriptStep[]): void
  stop(): void
}

function chunk(model: string, delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
}

export function chatStream(model: string, step: ScriptStep, callNumber: number): Response {
  const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }
  let body = chunk(model, { role: "assistant", content: "" })
  if ("tool" in step) {
    body += chunk(model, {
      tool_calls: [{ index: 0, id: `call_${callNumber}`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }],
    })
    body += chunk(model, {}, "tool_calls")
  } else {
    body += chunk(model, { content: step.text })
    body += chunk(model, {}, "stop")
  }
  body += `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model, choices: [], usage })}\n\n`
  body += "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

export function startScriptedGateway(models: readonly string[] = [AGENT_MODEL]): ScriptedGateway {
  let queue: ScriptStep[] = []
  let calls = 0
  const mock = startMockFuelix({
    models: [...models],
    handler: (request) => {
      if (!request.path.endsWith("/chat/completions")) return undefined
      const model = String(request.body?.model ?? AGENT_MODEL)
      const hasTools = Array.isArray(request.body?.tools) && request.body.tools.length > 0
      if (!hasTools) return chatStream(model, { text: "Jev test title" }, ++calls)
      return chatStream(model, queue.shift() ?? { text: "done" }, ++calls)
    },
  })
  const hasTools = (r: RecordedRequest) => Array.isArray(r.body?.tools) && r.body.tools.length > 0
  const chat = () => mock.requests.filter((r) => r.path.endsWith("/chat/completions"))
  return {
    mock,
    agentRequests: () => chat().filter(hasTools),
    titleRequests: () => chat().filter((r) => !hasTools(r)),
    script: (steps) => {
      queue = [...steps]
    },
    stop: () => mock.stop(),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock TypeSafe (System One)
// ---------------------------------------------------------------------------------------------------------------------

export interface JevRecordedRequest {
  headers: Record<string, string>
  /** Parsed body: `{ model, state, questions }`. */
  body: any
  /** The `state` as one string, for substring assertions. */
  stateText: string
}

export type JevBehavior =
  | { readonly kind: "answer" }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "hang" }

export interface MockJevInput {
  /** Chooses the behavior for one request. Default: `{ kind: "answer" }`. */
  behavior?: (request: JevRecordedRequest) => JevBehavior
  /**
   * Builds the answer for one question. Default: `noul` → 0.01, `choice` → the first option, `score` → 0.
   * Tests override this to make Jev call a command risky or to choose compression answers once the point's questions are known.
   */
  answer?: (input: { name: string; question: any; request: JevRecordedRequest }) => unknown
}

export interface MockJev {
  readonly url: string
  readonly requests: JevRecordedRequest[]
  setBehavior(next: MockJevInput["behavior"]): void
  setAnswer(next: MockJevInput["answer"]): void
  stop(): void
}

export function defaultAnswer(input: { name: string; question: any }): unknown {
  const { question } = input
  if (question?.type === "noul") return { type: "noul", noul: 0.01 }
  if (question?.type === "score") return { type: "score", score: 0, probabilities: { "0": 1 }, confidence: 1 }
  const options = Object.keys(question?.criteria ?? {})
  const choice = options[0] ?? "none"
  return { type: "choice", choice, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])), confidence: 1 }
}

export function startMockJev(input: MockJevInput = {}): MockJev {
  let behavior = input.behavior
  let answer = input.answer
  const requests: JevRecordedRequest[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(raw) {
      const url = new URL(raw.url)
      const headers: Record<string, string> = {}
      raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value
      })
      const text = await raw.text()
      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
      const recorded: JevRecordedRequest = { headers, body, stateText: typeof body?.state === "string" ? body.state : JSON.stringify(body?.state ?? null) }
      if (url.pathname !== "/v1/systemone") return new Response("not found", { status: 404 })
      requests.push(recorded)
      const chosen = behavior?.(recorded) ?? { kind: "answer" as const }
      if (chosen.kind === "http") return new Response(JSON.stringify({ error: "synthetic failure" }), { status: chosen.status, headers: { "content-type": "application/json" } })
      if (chosen.kind === "malformed") return new Response("this is not json {", { headers: { "content-type": "application/json" } })
      if (chosen.kind === "hang") {
        await sleep(20_000)
        return new Response("late", { status: 504 })
      }
      const answers: Record<string, unknown> = {}
      for (const [name, question] of Object.entries<any>(body?.questions ?? {})) {
        answers[name] = (answer ?? defaultAnswer)({ name, question, request: recorded })
      }
      return Response.json({ model: JEV_MODEL, answers, usage: { input_tokens: 10, output_tokens: 0 } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setBehavior: (next) => {
      behavior = next
    },
    setAnswer: (next) => {
      answer = next
    },
    stop: () => void server.stop(true),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------------------------------------------------

export interface JevPointsInput {
  safetyPreCheck?: Record<string, unknown>
  testCompression?: Record<string, unknown>
  skillPruning?: Record<string, unknown>
  reasoningBudget?: Record<string, unknown>
}

export type PermissionEffect = "allow" | "deny" | "ask"
export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}
export type PermissionMap = Record<string, PermissionEffect | Record<string, PermissionEffect>>

/** Converts a map to the native ordered rule array. Object key order is insertion order, so `"*"` first means "default, then exceptions". */
export function permissionRules(input: PermissionMap | PermissionRule[]): PermissionRule[] {
  if (Array.isArray(input)) return input
  const rules: PermissionRule[] = []
  for (const [action, value] of Object.entries(input)) {
    if (typeof value === "string") rules.push({ action, resource: "*", effect: value })
    else for (const [resource, effect] of Object.entries(value)) rules.push({ action, resource, effect })
  }
  return rules
}

export interface JevStackInput {
  /** Default: enabled with scope A (safety and compression enforce, skills and reasoning shadow). */
  jev?: Record<string, unknown> | false
  points?: JevPointsInput
  /**
   * Shell permission, as a convenient map or as native rules. A map such as `{ shell: "allow" }` or
   * `{ shell: { "*": "allow", "touch x*": "deny" } }` becomes the ordered native V2 `permissions` array
   * (`{ action, resource, effect }`; the last matching rule wins, as probed on 2.2.5). Never the deprecated `permission` map.
   */
  permission?: PermissionMap | PermissionRule[]
  config?: Record<string, unknown>
  /** Extra plugin entries, for example a probe plugin. */
  extraPlugins?: { package: string; options?: Record<string, unknown> }[]
  env?: Record<string, string>
  jevMock?: MockJevInput
  /** Omit the TypeSafe key from the server environment. */
  noJevKey?: boolean
  /**
   * Write the controlled project skill `jev-fixture-review` (`.agents/skills/jev-fixture-review/SKILL.md` in the isolated
   * project) after the server starts and before the first location request, so OpenCode's skill scanner finds it at boot.
   * Default false. Never writes under the repository.
   */
  fixtureSkills?: boolean
}

export const FIXTURE_SKILL = {
  id: "jev-fixture-review",
  name: "jev-fixture-review",
  description: "Use this fixture skill when the user asks for a jev-fixture-review of an integration test.",
  body: "# Jev fixture review\n\nThis skill exists only for the isolated Jev integration test.\n",
} as const

async function writeFixtureSkills(projectDir: string): Promise<void> {
  const dir = join(projectDir, ".agents", "skills", FIXTURE_SKILL.id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${FIXTURE_SKILL.id}\ndescription: ${FIXTURE_SKILL.description}\n---\n\n${FIXTURE_SKILL.body}`,
  )
}

export interface JevStack {
  gateway: ScriptedGateway
  jev: MockJev
  server: IsolatedServer
  feed: EventFeed
  stop(): Promise<void>
}

/**
 * Scope A: safety and compression enforce. Skill and reasoning points are not listed, so they keep their option
 * default (`off`). Tests that need shadow observations enable them explicitly with `points`.
 */
export const SCOPE_A_POINTS = {
  safetyPreCheck: { mode: "enforce", failClosed: true, riskThreshold: 0.2 },
  testCompression: { mode: "enforce" },
} as const

export async function startJevStack(input: JevStackInput = {}): Promise<JevStack> {
  const gateway = startScriptedGateway()
  const jev = startMockJev(input.jevMock)
  const jevOptions =
    input.jev === false
      ? undefined
      : { enabled: true, model: JEV_MODEL, baseURL: jev.url, keychainService: false, points: { ...SCOPE_A_POINTS, ...input.points }, ...input.jev }
  let server: IsolatedServer
  try {
    server = await startIsolatedServer({
      config: {
        ...(input.permission === undefined ? {} : { permissions: permissionRules(input.permission) }),
        ...input.config,
        plugins: [
          pluginEntry({ fuelix: { baseURL: gateway.mock.url, keychainService: false, refreshMinutes: 0 }, ...(jevOptions ? { jev: jevOptions } : {}) }),
          ...(input.extraPlugins ?? []),
        ],
      },
      env: {
        FUELIX_API_KEY: FAKE_KEY,
        ...(input.noJevKey ? {} : { TYPESAFE_API_KEY: FAKE_JEV_KEY }),
        // The plugin honors a custom TypeSafe origin only with this opt-in. Tests point it at a loopback mock.
        TD_OPENCODE_ALLOW_CUSTOM_JEV_URL: "1",
        ...input.env,
      },
    })
  } catch (error) {
    gateway.stop()
    jev.stop()
    throw error
  }
  // The first location request boots the project. Write the skill before it, so the scanner finds it.
  if (input.fixtureSkills) await writeFixtureSkills(server.dirs.project)
  await waitFor(
    async () => {
      const response = await server.api<{ data: { providerID: string; id: string }[] }>("GET", "/api/model")
      const found = response.json.data?.some((m) => m.providerID === AGENT_PROVIDER && m.id === AGENT_MODEL)
      return found && gateway.mock.requests.some((r) => r.path === "/v1/models") ? true : undefined
    },
    60_000,
    "FueliX models",
  )
  await sleep(1500) // Let the provider reload settle.
  const feed = await server.subscribe()
  return {
    gateway,
    jev,
    server,
    feed,
    stop: async () => {
      feed.close()
      await server.stop()
      gateway.stop()
      jev.stop()
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Prompt driver with permission policy
// ---------------------------------------------------------------------------------------------------------------------

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  metadata?: Record<string, unknown>
  message?: string
  source?: unknown
}

export type PermissionDecision = "once" | "always" | "reject"

export interface DriveResult {
  sessionID: string
  /** Every pending permission request seen, once each, in order. */
  permissions: PermissionRequest[]
  /** Decisions sent, in the same order. */
  decisions: PermissionDecision[]
  /** `GET /api/session/{id}/message` data, oldest first. */
  messages: any[]
  /** Tool parts of assistant messages, in order. */
  tools: any[]
  /** Concatenated final assistant text. */
  text: string
}

export interface DriveInput {
  stack: JevStack
  prompt: string
  steps: readonly ScriptStep[]
  /** Controls each pending permission request. Default: reject. Never approve a destructive command in a test. */
  decide?: (request: PermissionRequest, index: number) => PermissionDecision
  timeoutMs?: number
  /** Reuse a session. Default: create one on the `fuelix` agent model. */
  sessionID?: string
}

export async function createSession(stack: JevStack): Promise<string> {
  const created = await stack.server.api<{ data: { id: string } }>("POST", "/api/session", {
    location: { directory: stack.server.dirs.project },
    model: { providerID: AGENT_PROVIDER, id: AGENT_MODEL },
  })
  if (created.status !== 200) throw new Error(`session create failed: HTTP ${created.status} ${JSON.stringify(created.json)}`)
  return created.json.data.id
}

export async function messagesOf(stack: JevStack, sessionID: string): Promise<any[]> {
  const response = await stack.server.api<{ data: any[] }>("GET", `/api/session/${sessionID}/message?order=asc&limit=200`)
  if (response.status !== 200) throw new Error(`message list failed: HTTP ${response.status}`)
  return response.json.data
}

export async function drivePrompt(input: DriveInput): Promise<DriveResult> {
  const { stack } = input
  const { server } = stack
  const timeout = input.timeoutMs ?? 90_000
  const decide = input.decide ?? (() => "reject" as const)
  stack.gateway.script(input.steps)
  const sessionID = input.sessionID ?? (await createSession(stack))

  const sent = await server.api("POST", `/api/session/${sessionID}/prompt`, { text: input.prompt })
  if (sent.status !== 200) throw new Error(`prompt failed: HTTP ${sent.status} ${JSON.stringify(sent.json)}`)

  const permissions: PermissionRequest[] = []
  const decisions: PermissionDecision[] = []
  const seen = new Set<string>()
  let finished = false
  const waiting = server
    .api("POST", `/api/experimental/session/${sessionID}/wait`)
    .then(() => {
      finished = true
    })
    .catch(() => {
      finished = true
    })

  const deadline = Date.now() + timeout
  while (!finished && Date.now() < deadline) {
    const pending = await server.api<{ data: PermissionRequest[] }>("GET", `/api/session/${sessionID}/permission`)
    for (const request of pending.json?.data ?? []) {
      if (seen.has(request.id)) continue
      seen.add(request.id)
      const decision = decide(request, permissions.length)
      permissions.push(request)
      decisions.push(decision)
      await server.api("POST", `/api/session/${sessionID}/permission/${request.id}/reply`, { decision })
    }
    await sleep(100)
  }
  if (!finished) throw new Error(`session did not become idle within ${timeout} ms`)
  await waiting
  await sleep(1000) // Trailing events and the title request.

  const messages = await messagesOf(stack, sessionID)
  const assistants = messages.filter((m) => m.type === "assistant")
  const tools = assistants.flatMap((m) => (m.content ?? []).filter((part: any) => part.type === "tool"))
  const text = assistants.flatMap((m) => (m.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text)).join("\n")
  return { sessionID, permissions, decisions, messages, tools, text }
}

// ---------------------------------------------------------------------------------------------------------------------
// Result readers
// ---------------------------------------------------------------------------------------------------------------------

/** Text of a completed or failed tool part, from `state.content`. */
export function toolOutput(tool: any): string {
  const content: any[] = tool?.state?.content ?? []
  return content.map((part) => (part?.type === "text" ? String(part.text) : "")).join("")
}

export function shellCommands(result: DriveResult): string[] {
  return result.tools.filter((t) => t.name === "shell").map((t) => String(t.state?.input?.command ?? ""))
}

/** All text of a recorded chat request: system, user, assistant, and tool messages, as one string. */
export function requestText(request: RecordedRequest): string {
  return JSON.stringify(request.body?.messages ?? [])
}

/** Messages of the next agent request after a tool ran: the `tool` role message contents as strings. */
export function toolMessagesOf(request: RecordedRequest): string[] {
  return (request.body?.messages ?? [])
    .filter((m: any) => m.role === "tool")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
}

/**
 * Normalizes a chat request for comparison: session-dependent IDs and dates are replaced. Used to show that shadow
 * points leave the outgoing request unchanged.
 */
export function normalizeRequest(request: RecordedRequest): unknown {
  const text = JSON.stringify(request.body)
    .replace(/ses_[A-Za-z0-9]+/g, "<session>")
    .replace(/msg_[A-Za-z0-9]+/g, "<message>")
    .replace(/call_\d+/g, "<call>")
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, "<date>")
    .replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{4}/g, "<date>")
    .replace(/td-opencode-it-[A-Za-z0-9]+/g, "<root>")
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------------------------------------------------
// Files: telemetry, logs, artifacts, leak scan
// ---------------------------------------------------------------------------------------------------------------------

/** Telemetry JSONL path under the isolated XDG data directory. */
export function telemetryPath(server: IsolatedServer): string {
  return join(server.dirs.data, "td-opencode-plugin", "jev", "telemetry.jsonl")
}

export function readTelemetry(server: IsolatedServer): any[] {
  const path = telemetryPath(server)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { unparsable: true }
      }
    })
}

/** Largest file that a leak scan reads. Larger files (for example SQLite databases) are skipped. */
export const SCAN_MAX_BYTES = 8 * 1024 * 1024

/**
 * Regular files under `root`, recursively, with absolute paths. Uses `lstat`: a symlink (file or directory) is never
 * followed, so a scan cannot leave the root through a link such as a cache directory.
 */
export function listFiles(root: string): string[] {
  const out: string[] = []
  let info
  try {
    info = lstatSync(root)
  } catch {
    return out
  }
  if (!info.isDirectory()) return out
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    let entry
    try {
      entry = lstatSync(path)
    } catch {
      continue
    }
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...listFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** Files of `dir` (no symlinks, at most `SCAN_MAX_BYTES` each) that contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = []
  for (const path of listFiles(dir)) {
    try {
      if (lstatSync(path).size > SCAN_MAX_BYTES) continue
      if (readFileSync(path).includes(needle)) found.push(path)
    } catch {
      // unreadable
    }
  }
  return found
}

/** File names under the plugin's Jev data directory (`$XDG_DATA_HOME/td-opencode-plugin/jev`). */
export function jevDataFiles(server: IsolatedServer): string[] {
  return listFiles(join(server.dirs.data, "td-opencode-plugin", "jev"))
}

/** POSIX mode bits (`0o600`, `0o700`) of a path. */
export function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777
}
