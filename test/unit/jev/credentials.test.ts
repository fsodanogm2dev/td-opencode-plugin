import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import type { ExecFn } from "../../../src/fuelix/credentials.ts"
import { KEYCHAIN_RETRY_MS, globalKeychainCache } from "../../../src/fuelix/credentials.ts"
import {
  createJevKeyProvider,
  resolveJevKey,
  TYPESAFE_ENV_NAME,
  TYPESAFE_INTEGRATION_ID,
  type ResolveJevKeyInput,
} from "../../../src/jev/credentials.ts"

const KEYCHAIN = "ts-test-keychain-not-real"
const STORE = "ts-test-store-not-real"
const ENV = "ts-test-env-not-real"

function integration(getKey: () => string | undefined, ids: string[] = []) {
  return {
    connection: {
      active: async (id: string) => {
        ids.push(id)
        return getKey() ? { id: "c1" } : undefined
      },
      resolve: async () => {
        const key = getKey()
        return key ? { type: "key", key } : undefined
      },
    },
  } as never
}

function exec(exitCode: number, stdout = ""): ExecFn & { calls: string[][] } {
  const calls: string[][] = []
  const fn: ExecFn = async (command) => {
    calls.push([...command])
    return { exitCode, stdout }
  }
  return Object.assign(fn, { calls })
}

const base = (overrides: Partial<ResolveJevKeyInput> = {}): ResolveJevKeyInput => ({
  keychainService: "typesafe-api-key",
  platform: "darwin",
  exec: exec(44),
  env: {},
  integration: integration(() => undefined),
  log: createMemoryLogger(),
  keychainCache: new Map(),
  ...overrides,
})

describe("resolveJevKey order", () => {
  test("keychain wins and runs the typesafe service", async () => {
    const run = exec(0, `${KEYCHAIN}\n`)
    const key = await resolveJevKey(base({ exec: run, env: { [TYPESAFE_ENV_NAME]: ENV }, integration: integration(() => STORE) }))
    expect(key).toEqual({ key: KEYCHAIN, source: "keychain" })
    expect(run.calls).toEqual([["/usr/bin/security", "find-generic-password", "-s", "typesafe-api-key", "-w"]])
  })

  test("credential store second, with the typesafe-ai integration id", async () => {
    const ids: string[] = []
    const key = await resolveJevKey(base({ env: { [TYPESAFE_ENV_NAME]: ENV }, integration: integration(() => STORE, ids) }))
    expect(key).toEqual({ key: STORE, source: "credential-store" })
    expect(ids).toEqual([TYPESAFE_INTEGRATION_ID])
    expect(TYPESAFE_INTEGRATION_ID).toBe("typesafe-ai")
  })

  test("env last; FUELIX_API_KEY is not used", async () => {
    expect(await resolveJevKey(base({ env: { [TYPESAFE_ENV_NAME]: ` ${ENV} ` } }))).toEqual({ key: ENV, source: "env" })
    expect(await resolveJevKey(base({ env: { FUELIX_API_KEY: "sk-test-fuelix-not-real" } }))).toBeUndefined()
  })

  test("no key anywhere resolves to undefined", async () => {
    expect(await resolveJevKey(base())).toBeUndefined()
  })

  test("keychain is skipped off macOS or when disabled", async () => {
    const run = exec(0, KEYCHAIN)
    expect(await resolveJevKey(base({ exec: run, platform: "linux" }))).toBeUndefined()
    expect(await resolveJevKey(base({ exec: run, keychainService: false }))).toBeUndefined()
    expect(run.calls).toEqual([])
  })

  test("failures are swallowed and logged without secrets", async () => {
    const log = createMemoryLogger()
    const boom: ExecFn = async () => {
      throw new Error(`failed with ${STORE}`)
    }
    const failing = {
      connection: {
        active: async () => {
          throw new Error(`failed with ${STORE}`)
        },
      },
    } as never
    expect(await resolveJevKey(base({ exec: boom, integration: failing, log }))).toBeUndefined()
    expect(log.lines.join("\n")).not.toContain(STORE)
    expect(await resolveJevKey(base({ exec: exec(1), log }))).toBeUndefined()
  })

  test("uses the process-wide keychain memo by default and keeps a found key", async () => {
    const cache = globalKeychainCache()
    const service = "typesafe-test-memo-service"
    cache.delete(service)
    const run = exec(0, KEYCHAIN)
    const input = base({ exec: run, keychainService: service, keychainCache: undefined })
    await resolveJevKey(input)
    await resolveJevKey(input)
    expect(run.calls.length).toBe(1)
    cache.delete(service)
  })
})

describe("createJevKeyProvider", () => {
  test("a missing key is retried: /connect takes effect at runtime", async () => {
    let time = 0
    let stored: string | undefined
    const log = createMemoryLogger()
    const provider = createJevKeyProvider({ ...base({ integration: integration(() => stored), log }), now: () => time, ttlMs: 1000 })
    expect(await provider.resolve()).toBeUndefined()
    stored = STORE
    expect(await provider.resolve()).toBeUndefined() // still inside the ttl
    time += 1000
    expect(await provider.resolve()).toEqual({ key: STORE, source: "credential-store" })
    expect(provider.lastSource).toBe("credential-store")
  })

  test("logs one warning per outage, never the key", async () => {
    let time = 0
    const log = createMemoryLogger()
    const provider = createJevKeyProvider({ ...base({ log }), now: () => time, ttlMs: 10 })
    for (let index = 0; index < 4; index++) {
      await provider.resolve()
      time += 10
    }
    expect(log.lines.filter((line) => line.includes("warn")).length).toBe(1)
  })

  test("keychain misses retry no more than every five minutes", async () => {
    let time = 0
    const run = exec(44)
    const provider = createJevKeyProvider({ ...base({ exec: run }), now: () => time, ttlMs: 1 })
    await provider.resolve()
    time += KEYCHAIN_RETRY_MS - 10
    await provider.resolve()
    expect(run.calls.length).toBe(1)
    time += 10
    await provider.resolve()
    expect(run.calls.length).toBe(2)
  })

  test("concurrent calls share one resolution", async () => {
    const ids: string[] = []
    const provider = createJevKeyProvider(base({ integration: integration(() => STORE, ids) }))
    const results = await Promise.all([provider.resolve(), provider.resolve(), provider.resolve()])
    expect(results.every((value) => value?.key === STORE)).toBe(true)
    expect(ids.length).toBe(1)
  })
})

describe("keychain misrouting", () => {
  test("the default service is the TypeSafe one, never the FueliX one", async () => {
    const run = exec(0, `${KEYCHAIN}\n`)
    const key = await resolveJevKey(base({ exec: run }))
    expect(key?.source).toBe("keychain")
    expect(run.calls.flat()).toContain("typesafe-api-key")
    expect(run.calls.flat()).not.toContain("fuelix-api-key")
  })

  test("a reserved service is never read, in any spelling, even if it reaches the resolver", async () => {
    for (const service of ["fuelix-api-key", " Fuelix-API-Key "]) {
      const run = exec(0, "sk-test-fuelix-not-real")
      expect(await resolveJevKey(base({ exec: run, keychainService: service }))).toBeUndefined()
      expect(run.calls).toEqual([])
    }
  })
})

describe("hung key resolution", () => {
  const OLD = "ts-test-old-key-not-real"
  const NEW = "ts-test-new-key-not-real"

  function sequenced() {
    const releases: Array<(key: string | undefined) => void> = []
    let call = 0
    const integration = {
      connection: {
        active: async () => {
          call += 1
          if (call === 1) return await new Promise<{ id: string } | undefined>((resolve) => releases.push((key) => resolve(key ? { id: "old" } : undefined)))
          return { id: "new" }
        },
        resolve: async (connection: { id: string }) => ({ type: "key", key: connection.id === "old" ? OLD : NEW }),
      },
    } as never
    return { integration, releases, calls: () => call }
  }

  test("a hung resolution is dropped after the timeout, then a new lookup works", async () => {
    const { integration, releases, calls } = sequenced()
    const log = createMemoryLogger()
    const provider = createJevKeyProvider({ ...base({ integration, log }), resolutionTimeoutMs: 40 })
    const started = Date.now()
    expect(await provider.resolve()).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
    // Nothing was cached: the next call looks again at once, and finds the new key.
    expect(await provider.resolve()).toEqual({ key: NEW, source: "credential-store" })
    expect(calls()).toBe(2)
    expect(provider.lastSource).toBe("credential-store")
    // The old lookup finishes late. It must not replace the newer key or source.
    releases[0]?.("old")
    await Bun.sleep(20)
    expect(await provider.resolve()).toEqual({ key: NEW, source: "credential-store" })
    expect(provider.lastSource).toBe("credential-store")
    expect(calls()).toBe(2)
    // One constant timeout line, no key, and no "key not found" warning.
    const warnings = log.lines.filter((line) => line.includes("warn"))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("timed out")
    expect(warnings.join("\n")).not.toContain(OLD)
    expect(warnings.join("\n")).not.toContain(NEW)
  })

  test("callers share the pending lookup until it times out; the in-flight slot then resets", async () => {
    const { integration, calls } = sequenced()
    const provider = createJevKeyProvider({ ...base({ integration }), resolutionTimeoutMs: 40 })
    const results = await Promise.all([provider.resolve(), provider.resolve(), provider.resolve()])
    expect(results).toEqual([undefined, undefined, undefined])
    expect(calls()).toBe(1)
    expect((await provider.resolve())?.key).toBe(NEW)
  })

  test("a lookup that finishes in time is cached and a timeout is logged once per outage", async () => {
    let time = 0
    const log = createMemoryLogger()
    const hanging = { connection: { active: () => new Promise(() => undefined), resolve: async () => undefined } } as never
    const provider = createJevKeyProvider({ ...base({ integration: hanging, log }), now: () => time, resolutionTimeoutMs: 20, ttlMs: 10 })
    for (let index = 0; index < 3; index++) {
      expect(await provider.resolve()).toBeUndefined()
      time += 10
    }
    expect(log.lines.filter((line) => line.includes("timed out")).length).toBe(1)
    expect(log.lines.some((line) => line.includes("not found"))).toBe(false)
  })
})
