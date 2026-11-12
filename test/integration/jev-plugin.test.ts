/**
 * Jev integration. A real isolated OpenCode V2 server (2.2.5), a scripted Chat Completions gateway (the `fuelix`
 * provider), and a mock TypeSafe `POST /v1/systemone` on loopback. Fake keys only. No paid or live request.
 *
 * Facts that these tests rely on (probed on OpenCode 2.2.5):
 * - The shell tool is `shell` with `command`, `workdir`, `timeout`. Its permission `action` is `shell`.
 * - `permission.asked` carries `{ id, sessionID, action, resources, save?, metadata?, source?, message? }`. Pending requests:
 *   `GET /api/session/{id}/permission`. Reply: `POST /api/session/{id}/permission/{requestID}/reply` with `{ decision }`.
 * - A plain rejection ends the agent step: no later model request follows. Tests assert a sentinel file, never the next request.
 * - No destructive command runs. `rm -rf` targets a name that does not exist, and a rejected command never runs (sentinel files).
 *
 * The mock classifies Jev requests by the question IDs of `src/jev/questions.ts`: `is_destructive` (safety),
 * `error_type` and `is_flaky` (compression), `reasoning_depth` (reasoning), and `s<index>` (skills).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { FAKE_KEY } from "./fuelix-helpers.ts"
import { redactText } from "../../src/jev/redact.ts"
import { ERROR_TYPE_QUESTION_ID, FLAKY_QUESTION_ID, REASONING_QUESTION_ID, SAFETY_QUESTION_ID, skillQuestionId } from "../../src/jev/questions.ts"
import { waitFor } from "./harness.ts"
import {
  AGENT_MODEL,
  AGENT_PROVIDER,
  FAKE_JEV_KEY,
  FIXTURE_SKILL,
  JEV_MODEL,
  drivePrompt,
  filesContaining,
  jevDataFiles,
  listFiles,
  modeOf,
  normalizeRequest,
  readTelemetry,
  requestText,
  shellCommands,
  startJevStack,
  telemetryPath,
  toolMessagesOf,
  toolOutput,
  type JevBehavior,
  type JevRecordedRequest,
  type JevStack,
  type JevStackInput,
} from "./jev-helpers.ts"

const stacks: JevStack[] = []

afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.stop()
})

async function start(input: JevStackInput = {}): Promise<JevStack> {
  const stack = await startJevStack(input)
  stacks.push(stack)
  return stack
}

// ---------------------------------------------------------------------------------------------------------------------
// Mock answers
// ---------------------------------------------------------------------------------------------------------------------

// Point questions are fixed by the source (`src/jev/questions.ts`). No text is guessed.
const questionIds = (request: JevRecordedRequest): string[] => Object.keys(request.body?.questions ?? {})
const SKILL_ID_PATTERN = /^s\d+$/
const isSafetyRequest = (request: JevRecordedRequest): boolean => questionIds(request).includes(SAFETY_QUESTION_ID)
const isCompressionRequest = (request: JevRecordedRequest): boolean => questionIds(request).includes(ERROR_TYPE_QUESTION_ID)
const isReasoningRequest = (request: JevRecordedRequest): boolean => questionIds(request).includes(REASONING_QUESTION_ID)
const isSkillRequest = (request: JevRecordedRequest): boolean => {
  const ids = questionIds(request)
  return ids.length > 0 && ids.every((id) => SKILL_ID_PATTERN.test(id))
}

const RISKY_MARKER = "risky-sentinel"

/**
 * Answers by question ID. The safety answer is high only for a command with the marker. Compression answers
 * `assertion` and not flaky. Reasoning answers level 1. The first skill (the fixture skill, listed first) is relevant.
 */
function answerFor({ name, request }: { name: string; question: any; request: JevRecordedRequest }): unknown {
  switch (name) {
    case SAFETY_QUESTION_ID:
      return { type: "noul", noul: request.stateText.includes(RISKY_MARKER) ? 0.97 : 0.01 }
    case ERROR_TYPE_QUESTION_ID:
      return { type: "choice", choice: "assertion", probabilities: { assertion: 0.9, syntax: 0.04, environment: 0.04, timeout: 0.02 }, confidence: 0.9 }
    case FLAKY_QUESTION_ID:
      return { type: "noul", noul: 0.05 }
    case REASONING_QUESTION_ID:
      return { type: "score", score: 1, probabilities: { "0": 0.1, "1": 0.8, "2": 0.08, "3": 0.02 }, confidence: 0.8 }
    default:
      if (SKILL_ID_PATTERN.test(name)) return { type: "noul", noul: name === "s0" ? 0.9 : 0.05 }
      return { type: "noul", noul: 0.01 }
  }
}

const scopeAMock = { answer: answerFor }

const shellStep = (command: string, extra: Record<string, unknown> = {}) => ({ tool: { name: "shell", args: { command, timeout: 20_000, ...extra } } }) as const

/** Jev requests whose state shows the given text. */
const jevRequestsAbout = (stack: JevStack, text: string) => stack.jev.requests.filter((r) => r.stateText.includes(text))

// ---------------------------------------------------------------------------------------------------------------------
// 1. Disabled
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev disabled", () => {
  for (const [label, jev] of [
    ["no options.jev", false],
    ["enabled: false", { enabled: false }],
  ] as const) {
    test(`sends no Jev request and changes no permission (${label})`, async () => {
      const stack = await start({ jev, permission: { shell: "allow" }, jevMock: scopeAMock })
      const result = await drivePrompt({
        stack,
        prompt: "make a file",
        steps: [shellStep("touch disabled-sentinel"), { text: "done" }],
      })
      expect(result.permissions).toEqual([])
      expect(existsSync(join(stack.server.dirs.project, "disabled-sentinel"))).toBe(true)
      expect(stack.jev.requests).toEqual([])
      expect(stack.gateway.agentRequests().length).toBe(2)
    }, 180_000)
  }

  test("does not hide the TypeSafe key from the shell when Jev is disabled (baseline for the scrub test)", async () => {
    const stack = await start({ jev: false, permission: { shell: "allow" } })
    const result = await drivePrompt({ stack, prompt: "env", steps: [shellStep(`printf 'KEYSEEN=[%s]\\n' "\${TYPESAFE_API_KEY-unset}"`), { text: "done" }] })
    // This documents the OpenCode default: the plugin only scrubs when Jev is enabled.
    expect(toolOutput(result.tools[0])).toContain(`KEYSEEN=[${FAKE_JEV_KEY}]`)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 2-3. Deterministic safety, harmless commands
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev safety: deterministic checks", () => {
  test("asks for a destructive command although the rule says allow, with no Jev request; rejection means it never ran", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const sentinel = join(stack.server.dirs.project, "rm-ran-sentinel")
    // The directory does not exist. The `&&` sentinel proves that a rejected command did not run at all.
    const command = `rm -rf ./jev-dummy-nonexistent-build && touch rm-ran-sentinel`
    const result = await drivePrompt({ stack, prompt: "clean", steps: [shellStep(command), { text: "done" }], decide: () => "reject" })

    expect(result.permissions.length).toBe(1)
    const request = result.permissions[0]!
    expect(request.action).toBe("shell")
    expect(request.resources.join(" ")).toContain("rm -rf")
    expect(result.decisions).toEqual(["reject"])
    expect(result.tools.length).toBe(1)
    expect(result.tools[0].state.status).toBe("error")
    expect(existsSync(sentinel)).toBe(false)
    // The check is local: no upstream call for the command.
    expect(jevRequestsAbout(stack, "jev-dummy-nonexistent-build")).toEqual([])
    // Rejection never saves an approval that could bypass later checks.
    const saved = await stack.server.api<{ data: unknown[] }>("GET", "/api/permission/saved")
    expect(saved.status).toBe(200)
    expect(saved.json.data).toEqual([])
  }, 180_000)

  test("still asks the second time (no remembered approval path)", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const command = `rm -rf ./jev-dummy-nonexistent-build && touch rm-ran-sentinel`
    const first = await drivePrompt({ stack, prompt: "clean", steps: [shellStep(command), { text: "done" }] })
    const second = await drivePrompt({ stack, prompt: "clean again", steps: [shellStep(command), { text: "done" }], sessionID: first.sessionID })
    expect(first.permissions.length).toBe(1)
    expect(second.permissions.length).toBe(1)
    expect(existsSync(join(stack.server.dirs.project, "rm-ran-sentinel"))).toBe(false)
  }, 180_000)

  test("a harmless read-only command sends no Jev request and asks nothing", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "list", steps: [shellStep("ls"), { text: "done" }] })
    expect(result.permissions).toEqual([])
    expect(shellCommands(result)).toEqual(["ls"])
    expect(result.tools[0].state.status).toBe("completed")
    expect(stack.jev.requests).toEqual([])
    expect(stack.gateway.agentRequests().length).toBe(2)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 4. Candidate commands and failure escalation
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev safety: upstream decision and failures", () => {
  test("a low-risk answer lets a non-read-only command run as the rule says (allow preserved)", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch benign-sentinel"), { text: "done" }] })
    expect(result.permissions).toEqual([])
    expect(existsSync(join(stack.server.dirs.project, "benign-sentinel"))).toBe(true)
    const calls = jevRequestsAbout(stack, "benign-sentinel")
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${FAKE_JEV_KEY}`)
    expect(calls[0]!.body.model).toBe(JEV_MODEL)
    expect(typeof calls[0]!.body.questions).toBe("object")
  }, 180_000)

  test("a high-risk answer asks; rejection never runs the command", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "touch", steps: [shellStep(`touch ${RISKY_MARKER}`), { text: "done" }] })
    expect(result.permissions.length).toBe(1)
    expect(result.permissions[0]!.action).toBe("shell")
    expect(result.decisions).toEqual(["reject"])
    expect(existsSync(join(stack.server.dirs.project, RISKY_MARKER))).toBe(false)
    expect(jevRequestsAbout(stack, RISKY_MARKER).length).toBeGreaterThanOrEqual(1)
  }, 180_000)

  const failures: [string, JevBehavior, Record<string, unknown>?][] = [
    ["HTTP 529", { kind: "http", status: 529 }],
    ["HTTP 500", { kind: "http", status: 500 }],
    ["malformed JSON", { kind: "malformed" }],
    ["timeout", { kind: "hang" }, { timeoutMs: 300 }],
  ]
  for (const [label, behavior, safety] of failures) {
    test(`asks and does not run when Jev fails closed (${label})`, async () => {
      const stack = await start({
        permission: { shell: "allow" },
        points: { safetyPreCheck: { mode: "enforce", failClosed: true, riskThreshold: 0.2, ...safety } },
        jevMock: { behavior: () => behavior, answer: scopeAMock.answer },
      })
      const result = await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch typesafe529-sentinel"), { text: "done" }] })
      expect(result.permissions.length).toBe(1)
      expect(result.permissions[0]!.action).toBe("shell")
      expect(result.decisions).toEqual(["reject"])
      expect(existsSync(join(stack.server.dirs.project, "typesafe529-sentinel"))).toBe(false)
      expect(result.tools[0].state.status).toBe("error")
      expect(jevRequestsAbout(stack, "typesafe529-sentinel").length).toBeGreaterThanOrEqual(1)
      // Upstream error text never reaches OpenCode's permission request or the tool error as a key.
      expect(JSON.stringify(result.permissions)).not.toContain(FAKE_JEV_KEY)
    }, 180_000)
  }

  // `pwd` alone is read-only. The redirection makes the full command write a file, so the scanner must not skip the
  // check although the permission resources (probed on 2.2.5: split subcommands) show only `pwd`.
  test("a redirection makes a read-only command a candidate: low risk runs it", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "pwd", steps: [shellStep("pwd > redirection-sentinel"), { text: "done" }] })
    expect(result.permissions).toEqual([])
    expect(existsSync(join(stack.server.dirs.project, "redirection-sentinel"))).toBe(true)
    // Jev saw the full command, so the check was not skipped as read-only.
    expect(jevRequestsAbout(stack, "redirection-sentinel").length).toBeGreaterThanOrEqual(1)
  }, 180_000)

  test("a redirection with a high-risk answer asks; rejection never writes the file", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "pwd", steps: [shellStep(`pwd > redirection-${RISKY_MARKER}`), { text: "done" }] })
    expect(result.permissions.length).toBe(1)
    expect(result.decisions).toEqual(["reject"])
    expect(existsSync(join(stack.server.dirs.project, `redirection-${RISKY_MARKER}`))).toBe(false)
  }, 180_000)

  for (const [label, behavior] of [
    ["HTTP 529", { kind: "http", status: 529 }],
    ["malformed JSON", { kind: "malformed" }],
  ] as const) {
    test(`a redirection asks and does not write when Jev fails closed (${label})`, async () => {
      const stack = await start({ permission: { shell: "allow" }, jevMock: { behavior: () => behavior, answer: scopeAMock.answer } })
      const result = await drivePrompt({ stack, prompt: "pwd", steps: [shellStep("pwd > redirection-sentinel"), { text: "done" }] })
      expect(result.permissions.length).toBe(1)
      expect(result.decisions).toEqual(["reject"])
      expect(existsSync(join(stack.server.dirs.project, "redirection-sentinel"))).toBe(false)
    }, 180_000)
  }

  test("without failClosed an upstream failure leaves the rule (allow) unchanged", async () => {
    const stack = await start({
      permission: { shell: "allow" },
      points: { safetyPreCheck: { mode: "enforce", failClosed: false, riskThreshold: 0.2 } },
      jevMock: { behavior: () => ({ kind: "http", status: 529 }), answer: scopeAMock.answer },
    })
    const result = await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch open-sentinel"), { text: "done" }] })
    expect(result.permissions).toEqual([])
    expect(existsSync(join(stack.server.dirs.project, "open-sentinel"))).toBe(true)
  }, 180_000)

  test("without a TypeSafe key, deterministic checks still ask and other commands follow the rule", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock, noJevKey: true })
    const destructive = await drivePrompt({
      stack,
      prompt: "clean",
      steps: [shellStep("rm -rf ./jev-dummy-nonexistent-build && touch rm-ran-sentinel"), { text: "done" }],
    })
    expect(destructive.permissions.length).toBe(1)
    expect(existsSync(join(stack.server.dirs.project, "rm-ran-sentinel"))).toBe(false)
    const other = await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch nokey-sentinel"), { text: "done" }] })
    expect(other.permissions).toEqual([])
    expect(existsSync(join(stack.server.dirs.project, "nokey-sentinel"))).toBe(true)
    expect(stack.jev.requests).toEqual([])
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 5. Existing ask and deny stay
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev safety: existing rules stay", () => {
  test("ask stays ask (the user still decides) and deny stays deny (no request, never run)", async () => {
    const stack = await start({
      permission: { shell: { "*": "allow", "printf ask-marker*": "ask", "touch deny-sentinel*": "deny" } },
      jevMock: scopeAMock,
    })
    const asked = await drivePrompt({ stack, prompt: "ask", steps: [shellStep("printf ask-marker"), { text: "done" }] })
    expect(asked.permissions.length).toBe(1)
    expect(asked.permissions[0]!.resources.join(" ")).toContain("printf ask-marker")
    expect(asked.tools[0].state.status).toBe("error")

    const denied = await drivePrompt({ stack, prompt: "deny", steps: [shellStep("touch deny-sentinel"), { text: "done" }] })
    expect(denied.permissions).toEqual([])
    expect(denied.tools[0].state.status).toBe("error")
    expect(denied.tools[0].state.error.type).toBe("permission.rejected")
    expect(JSON.stringify(denied.tools[0].state.error)).toContain("denied")
    expect(existsSync(join(stack.server.dirs.project, "deny-sentinel"))).toBe(false)
  }, 180_000)

  test("a configured ask for every shell command is not weakened by a low-risk answer", async () => {
    const stack = await start({ permission: { shell: "ask" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch asked-sentinel"), { text: "done" }] })
    expect(result.permissions.length).toBe(1)
    expect(existsSync(join(stack.server.dirs.project, "asked-sentinel"))).toBe(false)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 6. Compression
// ---------------------------------------------------------------------------------------------------------------------

// Fake values, never real keys. The server environment carries them (never config). The sensitive command names only
// the variables, so the model-visible tool input never holds a secret literal. Only its output does.
const SECRET_BEARER = "bearer-token-not-real-0123456789abcdef"
const SECRET_SK = "sk-test-not-a-real-key-compress-0123456789"
const SECRET_ENV = "hunter2-not-a-real-password-value"
const SECRET_ENV_VALUES: Record<string, string> = {
  TEST_JEV_SECRET_BEARER: SECRET_BEARER,
  TEST_JEV_SECRET_SK: SECRET_SK,
  TEST_JEV_SECRET_PASSWORD: SECRET_ENV,
}
const EXCERPT_FAILURE = "FAIL test/marker.test.ts > adds numbers"
const EXCERPT_ASSERT = "AssertionError: expected 3 to be 4"
/** Debug facts that redaction would alter. Enforce mode must keep them in the output (no redacted replacement). */
const DEBUG_LINES = ["token=abc123", "password_hash: null", "password_hash: undefined"] as const

const PADDING_BEFORE = `yes 'PASS test/padding.test.ts > keeps spacing between the words of the line' | head -n 90`
const PADDING_AFTER = `yes 'PASS test/more-padding.test.ts > keeps spacing between the words of the line' | head -n 40`
const FAILURE_BLOCK = [`echo '${EXCERPT_FAILURE}'`, `echo '${EXCERPT_ASSERT}'`, `echo '    at test/marker.test.ts:12:5'`]

/** A failing test run (about 6 KB) with nothing that redaction changes: padding, failure, assertion, stack, exit 1. */
const CLEAN_FAILING_COMMAND = [PADDING_BEFORE, ...FAILURE_BLOCK, PADDING_AFTER, `exit 1`].join("; ")

/** The same run plus lines that redaction changes: secrets from the environment and debug values. */
const SENSITIVE_FAILING_COMMAND = [
  PADDING_BEFORE,
  ...FAILURE_BLOCK,
  `echo "Authorization: Bearer $TEST_JEV_SECRET_BEARER"`,
  `echo "API_KEY=$TEST_JEV_SECRET_PASSWORD"`,
  `echo "using $TEST_JEV_SECRET_SK"`,
  ...DEBUG_LINES.map((line) => `echo '${line}'`),
  PADDING_AFTER,
  `exit 1`,
].join("; ")

const runLocally = (command: string, env: Record<string, string> = {}): string =>
  Bun.spawnSync(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } }).stdout.toString()

const rawCleanOutput = (): string => runLocally(CLEAN_FAILING_COMMAND)
const rawSensitiveOutput = (): string => runLocally(SENSITIVE_FAILING_COMMAND, SECRET_ENV_VALUES)

const paddingLines = (text: string) => text.split("\n").filter((line) => line.includes("keeps spacing between the words")).length
/** Plugin log files (`logs/<hash>/<hash>.log`). Telemetry is not a log. */
const logFiles = (stack: JevStack) => jevDataFiles(stack.server).filter((path) => path.endsWith(".log"))

describe("Jev compression", () => {
  test("clean failing output: a shorter summary reaches history and the next model; excerpts stay readable in a private log", async () => {
    const raw = rawCleanOutput()
    expect(raw.length).toBeGreaterThan(5000)
    expect(redactText(raw)).toBe(raw) // The output is clean: redaction changes nothing.
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "run the tests", steps: [shellStep(CLEAN_FAILING_COMMAND), { text: "I read the failure." }] })

    expect(result.permissions).toEqual([])
    expect(result.tools.length).toBe(1)
    const tool = result.tools[0]
    const stored = toolOutput(tool)
    // History: shorter than the raw output, and the failure excerpts survive.
    expect(tool.state.status).toBe("completed")
    expect(stored.length).toBeLessThan(raw.length)
    expect(stored).toContain(EXCERPT_FAILURE)
    expect(stored).toContain(EXCERPT_ASSERT)
    expect(stored).toContain("test/marker.test.ts:12")

    // The next model request carries the same shorter text, not the raw output.
    const next = stack.gateway.agentRequests().at(-1)!
    const sent = toolMessagesOf(next).join("\n")
    expect(sent.length).toBeLessThan(raw.length)
    expect(sent).toContain(EXCERPT_FAILURE)
    expect(sent).toContain(EXCERPT_ASSERT)
    expect(sent).toContain("test/marker.test.ts:12")
    // Fewer lines of padding reach the model than the command printed (count invariant, not a fixed tail).
    expect(paddingLines(sent)).toBeLessThan(paddingLines(raw))

    // Compression asked Jev once for this output, with the classification questions.
    const asked = stack.jev.requests.filter(isCompressionRequest)
    expect(asked.length).toBe(1)
    expect(questionIds(asked[0]!).sort()).toEqual([ERROR_TYPE_QUESTION_ID, FLAKY_QUESTION_ID].sort())

    // Clean available copy: a private log with the failure excerpts, named in the compressed result.
    const logs = logFiles(stack)
    expect(logs.length).toBe(1)
    const path = logs[0]!
    expect(modeOf(path) & 0o077).toBe(0)
    expect(modeOf(join(path, ".."))! & 0o077).toBe(0)
    expect(stored).toContain(path)
    const log = readFileSync(path, "utf8")
    expect(log).toContain(EXCERPT_FAILURE)
    expect(log).toContain(EXCERPT_ASSERT)
    expect(log).toContain("test/marker.test.ts:12")
    // No key of this test appears in the transcript, the next request, or any Jev request.
    for (const key of [FAKE_JEV_KEY, FAKE_KEY]) {
      expect(stored).not.toContain(key)
      expect(requestText(next)).not.toContain(key)
      for (const request of stack.jev.requests) expect(JSON.stringify(request.body)).not.toContain(key)
    }
  }, 180_000)

  test("sensitive failing output: enforce leaves it unchanged, keeps debug values, writes no log, sends no compression request", async () => {
    const raw = rawSensitiveOutput()
    expect(raw.length).toBeGreaterThan(5000)
    // The scenario is only meaningful when redaction would change this output.
    expect(redactText(raw)).not.toBe(raw)
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock, env: SECRET_ENV_VALUES })
    const result = await drivePrompt({ stack, prompt: "run the tests", steps: [shellStep(SENSITIVE_FAILING_COMMAND), { text: "I read the failure." }] })

    const tool = result.tools[0]
    expect(tool.state.status).toBe("completed")
    // The model-visible tool input names variables only.
    const commandText = JSON.stringify(tool.state.input)
    for (const secret of [SECRET_BEARER, SECRET_SK, SECRET_ENV]) expect(commandText).not.toContain(secret)

    // History and the next request keep the original output, including the debug values.
    const stored = toolOutput(tool)
    expect(stored.startsWith(raw)).toBe(true)
    const sent = toolMessagesOf(stack.gateway.agentRequests().at(-1)!).join("\n")
    expect(sent.startsWith(raw)).toBe(true)
    for (const line of DEBUG_LINES) {
      expect(stored).toContain(line)
      expect(sent).toContain(line)
    }
    expect(stored).not.toContain("Jev test-output summary")

    // No compression request, no log, no applied compression row.
    expect(stack.jev.requests.filter(isCompressionRequest)).toEqual([])
    expect(logFiles(stack)).toEqual([])
    expect(readTelemetry(stack.server).filter((row) => row.point === "testCompression" && row.applied === true)).toEqual([])
    // Whatever Jev did receive (the safety question about the command) holds variable names, never the values.
    for (const secret of [SECRET_BEARER, SECRET_SK, SECRET_ENV]) {
      for (const request of stack.jev.requests) expect(JSON.stringify(request.body)).not.toContain(secret)
      expect(filesContaining(join(stack.server.dirs.data, "td-opencode-plugin"), secret)).toEqual([])
    }
  }, 180_000)

  test("sensitive failing output in shadow mode: output unchanged, no log, nothing sent holds a secret value", async () => {
    const raw = rawSensitiveOutput()
    const stack = await start({
      permission: { shell: "allow" },
      jevMock: scopeAMock,
      env: SECRET_ENV_VALUES,
      points: { testCompression: { mode: "shadow" } },
    })
    const result = await drivePrompt({ stack, prompt: "run the tests", steps: [shellStep(SENSITIVE_FAILING_COMMAND), { text: "I read the failure." }] })
    expect(toolOutput(result.tools[0]).startsWith(raw)).toBe(true)
    expect(toolMessagesOf(stack.gateway.agentRequests().at(-1)!).join("\n").startsWith(raw)).toBe(true)
    expect(logFiles(stack)).toEqual([])
    // A shadow classification, when it runs, sends the redacted text only.
    for (const secret of [SECRET_BEARER, SECRET_SK, SECRET_ENV]) {
      for (const request of stack.jev.requests) expect(JSON.stringify(request.body)).not.toContain(secret)
      expect(filesContaining(join(stack.server.dirs.data, "td-opencode-plugin"), secret)).toEqual([])
    }
    expect(readTelemetry(stack.server).filter((row) => row.point === "testCompression" && row.applied === true)).toEqual([])
  }, 180_000)

  test("output that is not shorter is left unchanged", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "run", steps: [shellStep("printf 'FAIL a.test.ts\\n'; exit 1"), { text: "done" }] })
    expect(toolOutput(result.tools[0])).toContain("FAIL a.test.ts")
    expect(toolMessagesOf(stack.gateway.agentRequests().at(-1)!).join("\n")).toContain("FAIL a.test.ts")
  }, 180_000)

  test("a Jev failure leaves the clean output unchanged and writes no log", async () => {
    const stack = await start({
      permission: { shell: "allow" },
      jevMock: { behavior: (request) => (isSafetyRequest(request) ? { kind: "answer" } : { kind: "http", status: 529 }), answer: scopeAMock.answer },
    })
    const raw = rawCleanOutput()
    const result = await drivePrompt({ stack, prompt: "run", steps: [shellStep(CLEAN_FAILING_COMMAND), { text: "done" }] })
    expect(toolOutput(result.tools[0]).startsWith(raw)).toBe(true)
    expect(logFiles(stack)).toEqual([])
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 7. Shell environment
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev shell environment", () => {
  const ENV_COMMAND = `printf 'TYPESAFE=[%s] FUELIX=[%s]\\n' "\${TYPESAFE_API_KEY-unset}" "\${FUELIX_API_KEY-unset}"`

  test("the shell child sees neither TYPESAFE_API_KEY nor FUELIX_API_KEY", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "env", steps: [shellStep(ENV_COMMAND), { text: "done" }] })
    const out = toolOutput(result.tools[0])
    expect(out).toContain("TYPESAFE=[unset]")
    expect(out).toContain("FUELIX=[unset]")
    expect(out).not.toContain(FAKE_JEV_KEY)
    expect(out).not.toContain(FAKE_KEY)
  }, 180_000)

  test("scrubShellEnv: false leaves the variable in place (control)", async () => {
    const stack = await start({ permission: { shell: "allow" }, jev: { scrubShellEnv: false }, jevMock: scopeAMock })
    const result = await drivePrompt({ stack, prompt: "env", steps: [shellStep(ENV_COMMAND), { text: "done" }] })
    // The control proves the first test checks something real. The key is a fake value of this test only.
    expect(toolOutput(result.tools[0])).toContain(`TYPESAFE=[${FAKE_JEV_KEY}]`)
  }, 180_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 8. Shadow points
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev shadow points", () => {
  const FIRST_PROMPT = "Say hello in one word."
  const LATEST_PROMPT = "Now say goodbye in one word, jev-latest-marker."
  const OFF = { mode: "off" } as const
  const SHADOW = { mode: "shadow" } as const
  // The catalogue holds 3 skills (fixture, opencode, report). The skill point skips a catalogue of at most `maxSkills`, so 1 makes it select.
  const SKILL_SHADOW = { mode: "shadow", maxSkills: 1 } as const

  /** Two turns in one session, so the second prompt is the latest user request. */
  async function runTwoTurns(input: JevStackInput) {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock, fixtureSkills: true, ...input })
    const first = await drivePrompt({ stack, prompt: FIRST_PROMPT, steps: [{ text: "hello" }] })
    const second = await drivePrompt({ stack, prompt: LATEST_PROMPT, steps: [{ text: "goodbye" }], sessionID: first.sessionID })
    return { stack, first, second }
  }

  const agent = (stack: JevStack) => stack.gateway.agentRequests().map(normalizeRequest)
  const title = (stack: JevStack) => stack.gateway.titleRequests().map(normalizeRequest)
  const skillRequests = (stack: JevStack) => stack.jev.requests.filter(isSkillRequest)

  /** Telemetry rows of one point. The writer is asynchronous, so tests wait for them. */
  const rowsOf = (stack: JevStack, point: string) => readTelemetry(stack.server).filter((row) => row.point === point)
  const waitForRows = (stack: JevStack, point: string) =>
    waitFor(async () => (rowsOf(stack, point).length > 0 ? rowsOf(stack, point) : undefined), 15_000, `${point} telemetry`)

  /** Variant IDs that OpenCode lists for the agent model. The reasoning point needs a model that has variants. */
  async function agentModelVariants(stack: JevStack): Promise<string[]> {
    const response = await stack.server.api<{ data: { providerID: string; id: string; variants: { id: string }[] }[] }>("GET", "/api/model")
    const model = response.json.data.find((m) => m.providerID === AGENT_PROVIDER && m.id === AGENT_MODEL)
    return (model?.variants ?? []).map((variant) => variant.id)
  }

  async function baseline() {
    const run = await runTwoTurns({ jev: false })
    const out = { agent: agent(run.stack), title: title(run.stack), system: String(run.stack.gateway.agentRequests()[0]!.body.messages[0].content) }
    await run.stack.stop()
    stacks.splice(stacks.indexOf(run.stack), 1)
    return out
  }

  test("the fixture skill is advertised to the model with id, name, and description (baseline, Jev off)", async () => {
    const base = await baseline()
    const catalogue = base.system.slice(base.system.indexOf("<available_skills>"), base.system.indexOf("</available_skills>"))
    expect(catalogue).toContain(`<id>${FIXTURE_SKILL.id}</id>`)
    expect(catalogue).toContain(`<name>${FIXTURE_SKILL.name}</name>`)
    expect(catalogue).toContain(`<description>${FIXTURE_SKILL.description}</description>`)
  }, 180_000)

  test("skill shadow alone: skill questions carry the fixture skill and the latest user request; no request changes", async () => {
    const base = await baseline()
    const run = await runTwoTurns({ points: { safetyPreCheck: OFF, testCompression: OFF, skillPruning: SKILL_SHADOW, reasoningBudget: OFF } })
    const { stack } = run
    await waitFor(async () => (skillRequests(stack).some((r) => JSON.stringify(r.body).includes("jev-latest-marker")) ? true : undefined), 15_000, "a skill request with the latest prompt")

    // Every Jev request is a skill observation: the only enabled point is the skill point.
    expect(stack.jev.requests.length).toBeGreaterThanOrEqual(1)
    expect(skillRequests(stack).length).toBe(stack.jev.requests.length)
    // At most one observation per agent model request, and none for the title.
    expect(stack.jev.requests.length).toBeLessThanOrEqual(stack.gateway.agentRequests().length)
    // One question per advertised skill, with generated IDs s0, s1, ... in catalogue order.
    const advertised = (base.system.match(/<skill>/g) ?? []).length
    expect(advertised).toBeGreaterThan(1)
    for (const request of stack.jev.requests) {
      const text = JSON.stringify(request.body)
      expect(questionIds(request)).toEqual(Array.from({ length: advertised }, (_, index) => skillQuestionId(index)))
      expect(text).toContain(FIXTURE_SKILL.id)
      expect(text).toContain(FIXTURE_SKILL.description)
      expect(text).not.toContain("Reply with only the title")
      expect(text).not.toContain("name conversations")
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_JEV_KEY}`)
    }
    const rows = await waitForRows(stack, "skillPruning")
    expect(rows.every((row) => row.mode === "shadow" && row.applied === false)).toBe(true)
    const latest = skillRequests(stack).filter((r) => JSON.stringify(r.body).includes("jev-latest-marker"))
    expect(latest.length).toBeGreaterThanOrEqual(1)

    // Shadow means no mutation: every outgoing request equals the baseline with the same fixture skill.
    expect(agent(stack)).toEqual(base.agent)
    expect(title(stack)).toEqual(base.title)
    expect(run.second.text).toContain("goodbye")
  }, 240_000)

  test("reasoning shadow alone: observes the latest user request on a model with variants, never changes a request", async () => {
    const base = await baseline()
    const run = await runTwoTurns({ points: { safetyPreCheck: OFF, testCompression: OFF, skillPruning: OFF, reasoningBudget: SHADOW } })
    const { stack } = run
    // Prerequisite: the model has variants in OpenCode's own metadata. Without variants the point makes no upstream call.
    const variants = await agentModelVariants(stack)
    expect(variants.length).toBeGreaterThan(0)
    await waitFor(async () => (stack.jev.requests.some((r) => JSON.stringify(r.body).includes("jev-latest-marker")) ? true : undefined), 15_000, "a reasoning request with the latest prompt")
    expect(stack.jev.requests.length).toBeGreaterThanOrEqual(1)
    expect(stack.jev.requests.length).toBeLessThanOrEqual(stack.gateway.agentRequests().length)
    for (const request of stack.jev.requests) {
      const text = JSON.stringify(request.body)
      expect(questionIds(request)).toEqual([REASONING_QUESTION_ID])
      expect(text).not.toContain("Reply with only the title")
      expect(text).not.toContain("name conversations")
    }
    // The mock answers score 1: the point records the matching variant of the model and applies nothing.
    const rows = await waitForRows(stack, "reasoningBudget")
    expect(rows.every((row) => row.mode === "shadow" && row.applied === false)).toBe(true)
    expect(rows.some((row) => row.choice === "medium" && variants.includes("medium"))).toBe(true)
    expect(agent(stack)).toEqual(base.agent)
    expect(title(stack)).toEqual(base.title)
  }, 240_000)

  test("all four points on: each point makes its own observation or decision, and shadow points change nothing", async () => {
    const FOUR_COMMAND = `: jev-four-points-marker; ${CLEAN_FAILING_COMMAND}`
    // Same prompt and script with Jev off. Only the first model request is comparable (later ones carry compressed output).
    const off = await start({ jev: false, permission: { shell: "allow" }, fixtureSkills: true })
    await drivePrompt({ stack: off, prompt: LATEST_PROMPT, steps: [shellStep(FOUR_COMMAND), { text: "I read the failure." }] })
    const sameFirst = normalizeRequest(off.gateway.agentRequests()[0]!)
    await off.stop()
    stacks.splice(stacks.indexOf(off), 1)
    const run = await (async () => {
      const stack = await start({
        permission: { shell: "allow" },
        jevMock: scopeAMock,
        fixtureSkills: true,
        points: { safetyPreCheck: { mode: "enforce", failClosed: true, riskThreshold: 0.2 }, testCompression: { mode: "enforce" }, skillPruning: SKILL_SHADOW, reasoningBudget: SHADOW },
      })
      const result = await drivePrompt({ stack, prompt: LATEST_PROMPT, steps: [shellStep(FOUR_COMMAND), { text: "I read the failure." }] })
      return { stack, result }
    })()
    const { stack, result } = run
    await waitFor(
      async () => (skillRequests(stack).some((r) => JSON.stringify(r.body).includes("jev-latest-marker")) ? true : undefined),
      15_000,
      "a skill request with the latest prompt",
    )
    const all = stack.jev.requests
    const safety = all.filter(isSafetyRequest)
    const skills = all.filter(isSkillRequest)
    const compression = all.filter(isCompressionRequest)
    const reasoning = all.filter(isReasoningRequest)

    // One class per point. Each has its own evidence; none comes from the others.
    expect(safety.length).toBeGreaterThanOrEqual(1)
    expect(safety.every((r) => r.stateText.includes("jev-four-points-marker"))).toBe(true)
    expect(compression.length).toBeGreaterThanOrEqual(1)
    expect(skills.length).toBeGreaterThanOrEqual(1)
    expect(reasoning.length).toBeGreaterThanOrEqual(1)
    expect(safety.length + compression.length + skills.length + reasoning.length).toBe(all.length)
    // Each point also wrote its own telemetry row. The shadow points applied nothing; compression applied.
    const rows = {
      safetyPreCheck: await waitForRows(stack, "safetyPreCheck"),
      testCompression: await waitForRows(stack, "testCompression"),
      skillPruning: await waitForRows(stack, "skillPruning"),
      reasoningBudget: await waitForRows(stack, "reasoningBudget"),
    }
    expect(rows.skillPruning.every((row) => row.mode === "shadow" && row.applied === false)).toBe(true)
    expect(rows.reasoningBudget.every((row) => row.mode === "shadow" && row.applied === false)).toBe(true)
    expect(rows.testCompression.some((row) => row.mode === "enforce" && row.applied === true)).toBe(true)
    // Skill and reasoning observations are per model request, so at most one each per agent request.
    expect(skills.length).toBeLessThanOrEqual(stack.gateway.agentRequests().length)
    expect(reasoning.length).toBeLessThanOrEqual(stack.gateway.agentRequests().length)

    // The first agent request (before any tool ran) equals the same request with Jev off: the shadow points mutate nothing.
    expect(normalizeRequest(stack.gateway.agentRequests()[0]!)).toEqual(sameFirst)
    expect(result.text).toContain("I read the failure.")
  }, 300_000)

  test("all shadow and enforce points off make no Jev request", async () => {
    const { stack } = await runTwoTurns({ points: { safetyPreCheck: OFF, testCompression: OFF, skillPruning: OFF, reasoningBudget: OFF } })
    expect(stack.jev.requests).toEqual([])
  }, 240_000)

  test("a Jev failure in a shadow point does not fail the session or change requests", async () => {
    const base = await baseline()
    const run = await runTwoTurns({
      points: { safetyPreCheck: OFF, testCompression: OFF, skillPruning: SKILL_SHADOW, reasoningBudget: SHADOW },
      jevMock: { behavior: () => ({ kind: "http", status: 529 }) },
    })
    expect(run.second.text).toContain("goodbye")
    expect(agent(run.stack)).toEqual(base.agent)
    expect(title(run.stack)).toEqual(base.title)
  }, 240_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// 9. No credentials in exposed data
// ---------------------------------------------------------------------------------------------------------------------

describe("Jev credential exposure", () => {
  test("the TypeSafe key appears in no provider metadata, plugin list, log, telemetry, artifact, or model request", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    await drivePrompt({ stack, prompt: "run the tests", steps: [shellStep(CLEAN_FAILING_COMMAND), { text: "ok" }] })
    await drivePrompt({ stack, prompt: "check env", steps: [shellStep(`printf 'K=[%s]\\n' "\${TYPESAFE_API_KEY-unset}"`), { text: "ok" }] })

    const exposed = [
      JSON.stringify((await stack.server.api("GET", "/api/provider")).json),
      JSON.stringify((await stack.server.api("GET", "/api/model")).json),
      JSON.stringify((await stack.server.api("GET", "/api/plugin")).json),
      JSON.stringify((await stack.server.api("GET", "/api/info")).json),
      stack.server.logs(),
    ]
    for (const text of exposed) {
      expect(text).not.toContain(FAKE_JEV_KEY)
    }
    // The key reaches the mock TypeSafe only in the Authorization header.
    expect(stack.jev.requests.length).toBeGreaterThan(0)
    for (const request of stack.jev.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_JEV_KEY}`)
      expect(JSON.stringify(request.body)).not.toContain(FAKE_JEV_KEY)
    }
    // It never reaches the model gateway.
    for (const request of stack.gateway.mock.requests) {
      expect(JSON.stringify(request.body ?? null)).not.toContain(FAKE_JEV_KEY)
      expect(JSON.stringify(request.headers)).not.toContain(FAKE_JEV_KEY)
    }
    // Nothing the plugin or OpenCode wrote under the isolated root holds the key.
    expect(filesContaining(stack.server.dirs.root, FAKE_JEV_KEY)).toEqual([])
    expect(listFiles(stack.server.dirs.root).length).toBeGreaterThan(0)
  }, 240_000)

  test("telemetry is written under XDG data, is private, and holds no key or command output", async () => {
    const stack = await start({ permission: { shell: "allow" }, jevMock: scopeAMock })
    await drivePrompt({ stack, prompt: "run the tests", steps: [shellStep(CLEAN_FAILING_COMMAND), { text: "ok" }] })
    const path = telemetryPath(stack.server)
    await waitFor(async () => (existsSync(path) ? true : undefined), 10_000, "telemetry file")
    const entries = readTelemetry(stack.server)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((entry) => entry.unparsable)).toBe(false)
    const text = readFileSync(path, "utf8")
    for (const secret of [FAKE_JEV_KEY, FAKE_KEY, SECRET_BEARER, SECRET_SK, SECRET_ENV]) expect(text).not.toContain(secret)
    expect(text).not.toContain(EXCERPT_FAILURE)
    expect(modeOf(path) & 0o077).toBe(0)
  }, 180_000)

  test("telemetry: false writes no telemetry file", async () => {
    const stack = await start({ permission: { shell: "allow" }, jev: { telemetry: false }, jevMock: scopeAMock })
    await drivePrompt({ stack, prompt: "touch", steps: [shellStep("touch notelemetry-sentinel"), { text: "ok" }] })
    expect(existsSync(telemetryPath(stack.server))).toBe(false)
  }, 180_000)
})
