import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import {
  globalKeychainCache,
  KEYCHAIN_RETRY_MS,
  resolveKeys as resolveKeysWithCache,
  type ExecFn,
  type ResolveKeysInput,
} from "../../../src/fuelix/credentials.ts"

// Each test gets its own Keychain memo unless it passes one.
const resolveKeys = (input: Omit<ResolveKeysInput, "keychainCache"> & Partial<ResolveKeysInput>) =>
  resolveKeysWithCache({ keychainCache: new Map(), ...input })

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

describe("Keychain memo", () => {
  const base = (run: ExecFn, cache: Map<string, never>, now: () => number, store?: string) => ({
    keychainService: "fuelix-api-key" as const,
    platform: "darwin",
    exec: run,
    env: {},
    integration: integration(store),
    log: createMemoryLogger(),
    keychainCache: cache as never,
    now,
  })

  test("a found key is read once", async () => {
    const run = exec(0, KEYCHAIN)
    const cache = new Map<string, never>()
    let clock = 0
    for (let i = 0; i < 3; i++) {
      const keys = await resolveKeysWithCache(base(run, cache, () => (clock += KEYCHAIN_RETRY_MS * 10)))
      expect(keys.keychainKey).toBe(KEYCHAIN)
    }
    expect(run.calls.length).toBe(1)
  })

  test("concurrent reads share one command", async () => {
    const run = exec(0, KEYCHAIN)
    const cache = new Map<string, never>()
    await Promise.all([1, 2, 3].map(() => resolveKeysWithCache(base(run, cache, () => 0))))
    expect(run.calls.length).toBe(1)
  })

  test("a miss retries at most once every 5 minutes", async () => {
    const run = exec(44)
    const cache = new Map<string, never>()
    let clock = 1000
    await resolveKeysWithCache(base(run, cache, () => clock))
    clock += KEYCHAIN_RETRY_MS - 1
    await resolveKeysWithCache(base(run, cache, () => clock))
    expect(run.calls.length).toBe(1)
    clock += 1
    await resolveKeysWithCache(base(run, cache, () => clock))
    expect(run.calls.length).toBe(2)
    await resolveKeysWithCache(base(run, cache, () => clock))
    expect(run.calls.length).toBe(2)
  })

  test("a timeout counts as a miss and retries later", async () => {
    let calls = 0
    const run: ExecFn = async () => {
      calls++
      if (calls === 1) throw new Error("command timed out")
      return { exitCode: 0, stdout: KEYCHAIN }
    }
    const cache = new Map<string, never>()
    let clock = 0
    expect((await resolveKeysWithCache(base(run, cache, () => clock))).keychainKey).toBeUndefined()
    clock += KEYCHAIN_RETRY_MS
    expect((await resolveKeysWithCache(base(run, cache, () => clock))).keychainKey).toBe(KEYCHAIN)
  })

  test("the credential store is read on every call", async () => {
    let reads = 0
    const store = {
      connection: {
        active: async () => ({ id: "c" }),
        resolve: async () => ({ type: "key", key: `${STORE}-${++reads}` }),
      },
    } as never
    const run = exec(44)
    const cache = new Map<string, never>()
    const input = { ...base(run, cache, () => 0), integration: store }
    expect((await resolveKeysWithCache(input)).credentialStoreKey).toBe(`${STORE}-1`)
    expect((await resolveKeysWithCache(input)).credentialStoreKey).toBe(`${STORE}-2`)
  })

  test("the default memo is process-wide", () => {
    expect(globalKeychainCache()).toBe(globalKeychainCache())
  })
})
