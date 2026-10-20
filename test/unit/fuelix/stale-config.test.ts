import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { secretFields, warnStaleFuelixConfig } from "../../../src/fuelix/stale-config.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const LEAK = "sk-test-leaked-key-value"

describe("secretFields", () => {
  test("names credential fields without values", () => {
    expect(secretFields({ settings: { apiKey: LEAK, baseURL: "x" }, headers: { Authorization: `Bearer ${LEAK}`, "X-Api-Key": LEAK, accept: "a" } })).toEqual([
      "settings.apiKey",
      "headers.Authorization",
      "headers.X-Api-Key",
    ])
    expect(secretFields({ settings: { authToken: LEAK } })).toEqual(["settings.authToken"])
    expect(secretFields({ settings: { baseURL: "x" }, headers: { accept: "a" } })).toEqual([])
    expect(secretFields(undefined)).toEqual([])
  })
})

describe("warnStaleFuelixConfig", () => {
  const configured = {
    "fuelix-anthropic": { settings: { apiKey: LEAK }, headers: { Authorization: `Bearer ${LEAK}` } },
    fuelix: { settings: { authToken: LEAK } },
    "fuelix-openai": { settings: { baseURL: "https://x" } },
  }

  test("warns once, names provider and field, and never the value", async () => {
    const fake = createFakeCtx({ configured })
    const log = createMemoryLogger()
    const holder: Record<symbol, unknown> = {}
    await warnStaleFuelixConfig(fake.ctx, log, { holder, delaysMs: [0] })
    await warnStaleFuelixConfig(fake.ctx, log, { holder, delaysMs: [0] })
    const warnings = log.lines.filter((line) => line.includes("warn"))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("fuelix-anthropic settings.apiKey")
    expect(warnings[0]).toContain("fuelix-anthropic headers.Authorization")
    expect(warnings[0]).toContain("fuelix settings.authToken")
    expect(warnings[0]).not.toContain("fuelix-openai settings")
    expect(log.lines.join("\n")).not.toContain(LEAK)
    expect(fake.gets).toEqual(["fuelix-openai", "fuelix-anthropic", "fuelix", ])
  })

  test("a clean configuration does not warn and does not set the flag", async () => {
    const fake = createFakeCtx({ configured: { fuelix: { settings: { baseURL: "https://x" } } } })
    const log = createMemoryLogger()
    const holder: Record<symbol, unknown> = {}
    await warnStaleFuelixConfig(fake.ctx, log, { holder, delaysMs: [0] })
    expect(log.lines.filter((line) => line.includes("warn"))).toEqual([])
    expect(Object.getOwnPropertySymbols(holder)).toEqual([])
  })

  test("retries until the overlay appears", async () => {
    let calls = 0
    const ctx = {
      provider: {
        get: async () => ({ data: ++calls > 3 ? { settings: { apiKey: LEAK } } : { settings: {} } }),
      },
    } as never
    const log = createMemoryLogger()
    await warnStaleFuelixConfig(ctx, log, { holder: {}, delaysMs: [0, 0] })
    expect(log.lines.filter((line) => line.includes("hold a credential")).length).toBe(1)
    expect(calls).toBe(6)
  })

  test("read failures and hung reads do not throw", async () => {
    const log = createMemoryLogger()
    const ctx = {
      provider: { get: () => new Promise(() => {}) },
    } as never
    await warnStaleFuelixConfig(ctx, log, { holder: {}, timeoutMs: 10, delaysMs: [0] })
    expect(log.lines.filter((line) => line.includes("warn"))).toEqual([])
  })
})
