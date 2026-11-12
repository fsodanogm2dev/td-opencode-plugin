/**
 * Guards and Jev together.
 *
 * Order rule: the guards register first (Guards, then FueliX, then Jev). A guard denial is then already set when Jev
 * sees a permission request, so a command that a guard denies never goes to TypeSafe. Jev only raises `allow` to `ask`.
 *
 * Part 1 checks the setup order and the failure isolation of `createPlugin` with fake setup steps. Part 2 runs the real
 * source plugin on an isolated OpenCode server with a mock TypeSafe on loopback. Fake keys only. The fake `git` and
 * `npm` programs only append a line to a marker file. No real commit, test run, TypeSafe request, or paid model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPlugin, PLUGIN_ID, type PluginSteps } from "../../src/index.ts"
import { SAFETY_QUESTION_ID } from "../../src/jev/questions.ts"
import { FAKE_JEV_KEY, createSession, drivePrompt, startJevStack, type JevRecordedRequest, type JevStack } from "./jev-helpers.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Part 1. Order and failure isolation
// ---------------------------------------------------------------------------------------------------------------------

describe("createPlugin: order and isolation", () => {
  const SECRET_TEXT = "typesafe-secret-body-must-not-be-logged"

  function rig(failing: ReadonlyArray<"guards" | "fuelix" | "jev"> = []) {
    const calls: string[] = []
    const step = (name: "guards" | "fuelix" | "jev") => async () => {
      calls.push(`setup ${name}`)
      if (failing.includes(name)) throw new Error(SECRET_TEXT)
      return async () => void calls.push(`cleanup ${name}`)
    }
    const steps: PluginSteps = {
      setupGuards: step("guards") as unknown as PluginSteps["setupGuards"],
      setupFuelix: step("fuelix") as unknown as PluginSteps["setupFuelix"],
      setupJev: step("jev") as unknown as PluginSteps["setupJev"],
      statusReport: () => (async () => undefined) as ReturnType<PluginSteps["statusReport"]>,
    }
    return { calls, plugin: createPlugin(steps) }
  }

  async function run(plugin: ReturnType<typeof createPlugin>) {
    const lines: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
    try {
      const cleanup = await plugin.setup({ options: {} } as never)
      await (cleanup as unknown as () => Promise<void>)()
    } finally {
      console.error = original
    }
    return lines
  }

  test("keeps the plugin ID", () => {
    expect(PLUGIN_ID).toBe("td-opencode-plugin")
    expect(rig().plugin.id).toBe("td-opencode-plugin")
  })

  test("sets up Guards, then FueliX, then Jev, and cleans up in reverse (guards last)", async () => {
    const { calls, plugin } = rig()
    await run(plugin)
    expect(calls).toEqual(["setup guards", "setup fuelix", "setup jev", "cleanup jev", "cleanup fuelix", "cleanup guards"])
  })

  test("a guard failure is logged as NOT enforced without the error body, and FueliX and Jev still run", async () => {
    const { calls, plugin } = rig(["guards"])
    const lines = await run(plugin)
    expect(calls).toEqual(["setup guards", "setup fuelix", "setup jev", "cleanup jev", "cleanup fuelix"])
    expect(lines.some((line) => line.includes("error") && line.includes("guards are NOT enforced"))).toBe(true)
    expect(lines.join("\n")).not.toContain(SECRET_TEXT)
  })

  test("a Jev failure logs a fixed message with no TypeSafe data, and the guards and FueliX stay", async () => {
    const { calls, plugin } = rig(["jev"])
    const lines = await run(plugin)
    expect(calls).toEqual(["setup guards", "setup fuelix", "setup jev", "cleanup fuelix", "cleanup guards"])
    expect(lines.some((line) => line.includes("Jev setup failed"))).toBe(true)
    expect(lines.join("\n")).not.toContain(SECRET_TEXT)
  })

  test("a FueliX failure does not stop the guards or Jev", async () => {
    const { calls, plugin } = rig(["fuelix"])
    const lines = await run(plugin)
    expect(calls).toEqual(["setup guards", "setup fuelix", "setup jev", "cleanup jev", "cleanup guards"])
    expect(lines.some((line) => line.includes("FueliX setup failed"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Part 2. Real source plugin on an isolated server
// ---------------------------------------------------------------------------------------------------------------------

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

const isSafetyRequest = (request: JevRecordedRequest): boolean => Object.keys(request.body?.questions ?? {}).includes(SAFETY_QUESTION_ID)

/** TypeSafe rates every command as 0.9 risky. The safety threshold is 0.2. */
const riskyMock = {
  answer: ({ name }: { name: string }): unknown => (name === SAFETY_QUESTION_ID ? { type: "noul", noul: 0.9 } : { type: "noul", noul: 0.01 }),
}

const shellStep = (command: string) => ({ tool: { name: "shell", args: { command, timeout: 20_000 } } }) as const

interface Rig {
  stack: JevStack
  marker: string
  binDir: string
  guardsDir: string
  revision: number
  runs(program: string): number
  guard(sessionID: string): void
  stop(): Promise<void>
}

async function startRig(permission: "allow" | "ask"): Promise<Rig> {
  // Outside $HOME: the system temporary directory.
  const marker = mkdtempSync(join(tmpdir(), "td-jev-guards-marker-"))
  const binDir = mkdtempSync(join(tmpdir(), "td-jev-guards-bin-"))
  for (const program of ["git", "npm"]) {
    const path = join(binDir, program)
    writeFileSync(path, `#!/bin/sh\nprintf "x\\n" >> "$GUARD_MARKER_DIR/${program}-runs.log"\n`)
    chmodSync(path, 0o755)
  }
  const stack = await startJevStack({
    permission: { shell: permission },
    jevMock: riskyMock,
    env: { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, GUARD_MARKER_DIR: marker, TD_LIVE: "0" },
  })
  const guardsDir = join(stack.server.dirs.home, ".td-opencode-plugin", "guards")
  const rig: Rig = {
    stack,
    marker,
    binDir,
    guardsDir,
    revision: 0,
    runs: (program) => {
      const path = join(marker, `${program}-runs.log`)
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0
    },
    // Writes the store as the extension service does: atomically, with a new revision.
    guard(sessionID) {
      rig.revision++
      mkdirSync(guardsDir, { recursive: true })
      const temporary = join(guardsDir, `.store-${rig.revision}.tmp`)
      const activation = { id: `act-${rig.revision}`, guardId: COMMIT_GUARD.id, sessionId: sessionID, scope: "session", createdAt: new Date().toISOString(), expiresAt: null }
      writeFileSync(temporary, JSON.stringify({ schema: "td-guards/1", revision: rig.revision, guards: [COMMIT_GUARD], activations: [activation] }))
      renameSync(temporary, join(guardsDir, "store.json"))
    },
    async stop() {
      await stack.stop()
      rmSync(marker, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    },
  }
  return rig
}

describe("guards before Jev, shell permission rule allow", () => {
  let rig: Rig
  beforeAll(async () => {
    rig = await startRig("allow")
  }, 180_000)
  afterAll(async () => {
    await rig?.stop()
  })

  test("a guarded git commit is denied with the guard message: no TypeSafe request, no prompt, no run", async () => {
    const sessionID = await createSession(rig.stack)
    rig.guard(sessionID)
    const before = rig.stack.jev.requests.length
    const result = await drivePrompt({ stack: rig.stack, sessionID, prompt: "commit", steps: [shellStep("git commit -m guarded-sentinel"), { text: "done" }] })

    expect(rig.runs("git")).toBe(0)
    expect(result.permissions).toEqual([])
    expect(rig.stack.feed.events.filter((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID)).toHaveLength(0)
    expect(JSON.stringify(result.messages)).toContain(COMMIT_GUARD.message)
    // Jev saw nothing: no request at all, and in particular none that carries the command.
    expect(rig.stack.jev.requests.length).toBe(before)
    expect(rig.stack.jev.requests.some((request) => request.stateText.includes("guarded-sentinel") || request.stateText.includes("git commit"))).toBe(false)
    expect(rig.stack.server.logs()).not.toContain("NOT enforced")
  }, 180_000)

  test("an unguarded session is not blocked by the guard, and Jev turns allow into ask: one TypeSafe request", async () => {
    const sessionID = await createSession(rig.stack)
    const before = rig.stack.jev.requests.filter(isSafetyRequest).length
    const result = await drivePrompt({ stack: rig.stack, sessionID, prompt: "test", steps: [shellStep("npm test"), { text: "done" }], decide: () => "reject" })

    expect(result.permissions.length).toBe(1)
    expect(result.permissions[0]!.action).toBe("shell")
    expect(result.decisions).toEqual(["reject"])
    expect(rig.runs("npm")).toBe(0) // Rejected: the fake npm never ran.
    const requests = rig.stack.jev.requests.filter(isSafetyRequest).slice(before)
    expect(requests.length).toBe(1)
    expect(requests[0]!.stateText).toContain("npm test")
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${FAKE_JEV_KEY}`)
    expect(JSON.stringify(result.messages)).not.toContain(COMMIT_GUARD.message)
  }, 180_000)
})

describe("guards before Jev, shell permission rule ask", () => {
  let rig: Rig
  beforeAll(async () => {
    rig = await startRig("ask")
  }, 180_000)
  afterAll(async () => {
    await rig?.stop()
  })

  test("a guarded git commit that arrives as ask is denied without a prompt and without a TypeSafe request", async () => {
    const sessionID = await createSession(rig.stack)
    rig.guard(sessionID)
    const result = await drivePrompt({ stack: rig.stack, sessionID, prompt: "commit", steps: [shellStep("git commit -m guarded-ask-sentinel"), { text: "done" }] })

    expect(rig.runs("git")).toBe(0)
    expect(result.permissions).toEqual([])
    expect(rig.stack.feed.events.filter((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID)).toHaveLength(0)
    expect(JSON.stringify(result.messages)).toContain(COMMIT_GUARD.message)
    expect(rig.stack.jev.requests).toEqual([])
  }, 180_000)
})
