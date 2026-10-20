import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { resolveKeys, type ExecFn } from "../../../src/fuelix/credentials.ts"

const KEYCHAIN = "sk-test-keychain-not-real"
const STORE = "sk-test-store-not-real"
const ENV = "sk-test-env-not-real"

function integration(key: string | undefined, type = "key") {
  return {
    connection: {
      active: async () => (key ? { id: "c1" } : undefined),
      resolve: async () => (key ? { type, key } : undefined),
    },
  } as never
}

function exec(exitCode: number, stdout = ""): ExecFn & { calls: { command: readonly string[]; timeoutMs: number }[] } {
  const calls: { command: readonly string[]; timeoutMs: number }[] = []
  const fn = (async (command: readonly string[], options: { timeoutMs: number }) => {
    calls.push({ command, timeoutMs: options.timeoutMs })
    return { exitCode, stdout }
  }) as ExecFn & { calls: typeof calls }
  fn.calls = calls
  return fn
}

describe("resolveKeys", () => {
  test("keychain wins and runs the expected command", async () => {
    const run = exec(0, `${KEYCHAIN}\n`)
    const log = createMemoryLogger()
    const keys = await resolveKeys({
      keychainService: "fuelix-api-key",
      platform: "darwin",
      exec: run,
      env: { FUELIX_API_KEY: ENV },
      integration: integration(STORE),
      log,
    })
    expect(keys).toEqual({ keychainKey: KEYCHAIN, credentialStoreKey: STORE, envKey: ENV, key: KEYCHAIN, source: "keychain" })
    expect(run.calls).toEqual([
      { command: ["/usr/bin/security", "find-generic-password", "-s", "fuelix-api-key", "-w"], timeoutMs: 3000 },
    ])
  })

  test("exit 44 is silent and falls to the credential store", async () => {
    const log = createMemoryLogger()
    const keys = await resolveKeys({
      keychainService: "fuelix-api-key",
      platform: "darwin",
      exec: exec(44),
      env: { FUELIX_API_KEY: ENV },
      integration: integration(STORE),
      log,
    })
    expect(keys.source).toBe("credential-store")
    expect(keys.key).toBe(STORE)
    expect(log.lines).toEqual([])
  })

  test("falls to env when the store has no key", async () => {
    const keys = await resolveKeys({
      keychainService: "fuelix-api-key",
      platform: "darwin",
      exec: exec(44),
      env: { FUELIX_API_KEY: ENV },
      integration: integration(undefined),
      log: createMemoryLogger(),
    })
    expect(keys).toEqual({ envKey: ENV, key: ENV, source: "env" })
  })

  test("ignores non-key credential values", async () => {
    const keys = await resolveKeys({
      keychainService: false,
      platform: "darwin",
      exec: exec(0, KEYCHAIN),
      env: {},
      integration: integration(STORE, "oauth"),
      log: createMemoryLogger(),
    })
    expect(keys).toEqual({})
  })

  test("skips the keychain off macOS or when disabled", async () => {
    for (const [platform, service] of [["linux", "fuelix-api-key"], ["darwin", false]] as const) {
      const run = exec(0, KEYCHAIN)
      const keys = await resolveKeys({ keychainService: service, platform, exec: run, env: {}, integration: integration(undefined), log: createMemoryLogger() })
      expect(run.calls).toEqual([])
      expect(keys.key).toBeUndefined()
    }
  })

  test("other keychain failures log at debug level without output or key", async () => {
    const log = createMemoryLogger()
    const keys = await resolveKeys({
      keychainService: "fuelix-api-key",
      platform: "darwin",
      exec: exec(1, KEYCHAIN),
      env: {},
      integration: integration(undefined),
      log,
    })
    expect(keys.key).toBeUndefined()
    expect(log.lines.length).toBe(1)
    expect(log.lines[0]).toContain("debug")
    expect(log.lines.join("\n")).not.toContain(KEYCHAIN)
  })

  test("a throwing exec does not throw and does not log the key", async () => {
    const log = createMemoryLogger()
    const keys = await resolveKeys({
      keychainService: "fuelix-api-key",
      platform: "darwin",
      exec: async () => {
        throw new Error("command timed out")
      },
      env: { FUELIX_API_KEY: ENV },
      integration: integration(STORE),
      log,
    })
    expect(keys.source).toBe("credential-store")
    expect(log.lines.join("\n")).not.toContain(STORE)
    expect(log.lines.join("\n")).not.toContain(ENV)
  })
})
