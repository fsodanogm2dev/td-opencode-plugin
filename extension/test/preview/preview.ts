/**
 * Development preview, not shipped. Shows the real built panel and status
 * section in sandboxed iframes, each driven by the mock host with a fake report
 * and an in-memory guard service. No real service or model is called.
 * Run: bun test/preview/serve.ts, then open http://localhost:4319/test/preview/
 */
import { reportPath } from "../../panel/hash.ts"
import { json, OTHER_PROJECT, PROJECT, scenarios } from "../support/fixtures.ts"
import { CHILD, createFakeGuardService, guard, iso, runtime, SESSION, type FakeState } from "../support/guard-service.ts"
import { createMockHost, LIGHT_THEME, type FileAnswer, type GenerateAnswer } from "../support/mock-host.ts"

type Case = {
  label: string
  directory: string | null
  answer: FileAnswer | null
  light?: boolean
  width?: number
  height: number
  guards?: Partial<FakeState>
  session?: string | null
  surface?: "panel" | "status"
}

const PUSH = guard({
  id: "g_push",
  label: "Force pushes blocked",
  summary: "Stops force pushes to any remote.",
  request: "never force push",
  message: "A TD-Plugin guard set by the user blocks force pushes. Do not try another way. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["push"]], flags: ["--force"] }],
})
const ENV = guard({
  id: "g_env",
  label: ".env edits blocked",
  summary: "Stops edits to .env files.",
  request: "don't let the agent edit .env files",
  message: "A TD-Plugin guard set by the user blocks edits to .env files. Continue with other work.",
  rules: [{ kind: "permission", action: "edit", resources: ["**/.env", "**/.env.*"] }],
})
const ACTIVE = { id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session" as const, createdAt: iso(-600_000), expiresAt: null }
const ENFORCED: Partial<FakeState> = { revision: 4, guards: [guard(), PUSH, ENV], activations: [ACTIVE], runtime: runtime({ revision: 4 }) }
const NOT_ENFORCED: Partial<FakeState> = {
  revision: 4,
  guards: [guard(), PUSH],
  activations: [{ ...ACTIVE, scope: "request" }],
  lifecycle: [{ activationId: "a_1", fact: "uncertain", at: iso(), reason: "event-stream-lost", instance: "inst_1" }],
  runtime: runtime({ revision: 4, recordedAt: iso(-300_000) }),
}

const DRAFT = {
  label: "Git commits blocked",
  summary: "Stops the agent from creating git commits.",
  message: "A TD-Plugin guard set by the user blocks git commit. Do not try another way. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
}

const generate = (prompt: string): GenerateAnswer => {
  if (/after|before|\d\s*pm/i.test(prompt)) {
    return { text: JSON.stringify({ unsupported: "Guards cannot check the time of day. Ask to block git commit at all times, and release the guard when you want to commit." }) }
  }
  if (/commit/i.test(prompt)) return { text: JSON.stringify({ draft: DRAFT }) }
  return { text: JSON.stringify({ draft: { ...DRAFT, rules: [{ kind: "command", program: "/usr/bin/git" }] } }) }
}

const report = (value: unknown): FileAnswer => ({ content: json(value) })

const CASES: Case[] = [
  { label: "Guards: enforced, one active", directory: PROJECT, answer: report(scenarios.unchanged), guards: ENFORCED, height: 1500 },
  { label: "Guards (300px), light", directory: PROJECT, answer: report(scenarios.unchanged), guards: ENFORCED, light: true, width: 300, height: 1700 },
  { label: "Guards: not enforced, inherited request (300px)", directory: PROJECT, answer: report(scenarios.unchanged), guards: NOT_ENFORCED, session: CHILD, width: 300, height: 1500 },
  { label: "Guards: no session", directory: PROJECT, answer: report(scenarios.unchanged), guards: ENFORCED, session: null, height: 1200 },
  { label: "Guards: damaged store (300px)", directory: PROJECT, answer: report(scenarios.unchanged), guards: { guards: [guard()], corrupt: true }, width: 300, height: 900 },
  { label: "Guards: damaged store, light", directory: PROJECT, answer: report(scenarios.unchanged), guards: { guards: [guard()], corrupt: true }, light: true, width: 300, height: 900 },
  { label: "Status section", directory: PROJECT, answer: null, guards: ENFORCED, surface: "status", height: 90 },
  { label: "Status section, light, not enforced", directory: PROJECT, answer: null, guards: NOT_ENFORCED, session: CHILD, surface: "status", light: true, height: 110 },
  { label: "Models added", directory: PROJECT, answer: report(scenarios.added), height: 1400 },
  { label: "No change (earlier change kept)", directory: PROJECT, answer: report(scenarios.unchanged), height: 1400 },
  { label: "Changes found, reload failed", directory: PROJECT, answer: report(scenarios.reloadFailed), height: 1400 },
  { label: "No FueliX key", directory: PROJECT, answer: report(scenarios.noKey), height: 1400 },
  { label: "Rejected result", directory: PROJECT, answer: report(scenarios.rejected), height: 1400 },
  { label: "Check failed", directory: PROJECT, answer: report(scenarios.failed), height: 1400 },
  { label: "Out of date report", directory: PROJECT, answer: report(scenarios.stale), height: 1400 },
  { label: "First check running", directory: PROJECT, answer: report(scenarios.firstCheckPending), height: 1400 },
  { label: "No report", directory: OTHER_PROJECT, answer: null, height: 420 },
  { label: "File access not approved", directory: PROJECT, answer: { code: "NOT_GRANTED" }, height: 420 },
  { label: "Damaged report", directory: PROJECT, answer: { content: "{ half" }, height: 420 },
  { label: "No project open", directory: null, answer: report(scenarios.global), height: 1400 },
  { label: "Light theme", directory: PROJECT, answer: report(scenarios.added), light: true, height: 1400 },
  { label: "Narrow rail (300px)", directory: PROJECT, answer: report(scenarios.rejected), width: 300, height: 1700 },
  {
    label: "Narrow rail (300px), light",
    directory: PROJECT,
    answer: report(scenarios.failed),
    light: true,
    width: 300,
    height: 1700,
  },
  { label: "Model history: change from another chat (300px)", directory: PROJECT, answer: report(scenarios.history), width: 300, height: 1900 },
  { label: "Model history (300px), light", directory: PROJECT, answer: report(scenarios.history), light: true, width: 300, height: 1900 },
  { label: "Model history: long, older history omitted", directory: PROJECT, answer: report(scenarios.historyLong), height: 2000 },
  {
    label: "Model history could not be read",
    directory: PROJECT,
    answer: report({ ...scenarios.unchanged, modelHistory: { since: "soon", truncated: false, entries: [] } }),
    height: 1500,
  },
  { label: "Model history: none yet", directory: PROJECT, answer: report(scenarios.historyNull), width: 300, height: 1500 },
]

const grid = document.getElementById("grid")!
const only = new URLSearchParams(location.search).get("case")

for (const [index, item] of CASES.entries()) {
  if (only !== null && Number(only) !== index) continue
  const figure = document.createElement("figure")
  const caption = document.createElement("figcaption")
  caption.textContent = `${index}. ${item.label}`
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.title = item.label
  frame.style.width = `${item.width ?? 360}px`
  frame.style.height = `${item.height}px`
  frame.style.background = item.light ? LIGHT_THEME.tokens.background : "#151313"
  figure.append(caption, frame)
  grid.append(figure)

  const mock = createMockHost({ post: (data) => frame.contentWindow?.postMessage(data, "*") })
  if (item.light) mock.setTheme(LIGHT_THEME)
  const fake = createFakeGuardService(item.guards ?? { guards: [guard()] })
  mock.setService((call) => fake.handle(call))
  mock.setGenerate(async (call) => {
    await new Promise((r) => setTimeout(r, 400))
    return generate(call.prompt)
  })
  const session = item.session === undefined ? SESSION : item.session
  mock.setSession(session ? { id: session, title: "Chat", busy: false } : null)
  mock.setSurface(item.surface ?? "panel")
  void reportPath(item.directory).then((path) => {
    if (item.answer) mock.files.set(path, item.answer)
  })
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: string }
    if (data?.type === "resize" && item.surface === "status") {
      const height = (event.data as { payload?: { height?: number } }).payload?.height
      if (typeof height === "number") frame.style.height = `${height}px`
    }
    if (data?.type === "hello") {
      void reportPath(item.directory).then(() => mock.ready(item.directory))
      return
    }
    mock.receive(event.data)
  })
  frame.src = item.surface === "status" ? "/panel/status.html" : "/panel/index.html"
}
