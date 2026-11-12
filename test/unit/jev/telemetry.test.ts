import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, chmod, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMemoryLogger } from "../../../src/log.ts"
import { hashName } from "../../../src/jev/artifacts.ts"
import { activeTelemetryWriters, createJevTelemetry, sanitizeTelemetryEvent, TELEMETRY_CHOICES, TELEMETRY_FILE, TELEMETRY_MAX_PENDING, TELEMETRY_MAX_ROW_BYTES } from "../../../src/jev/telemetry.ts"

const dirs: string[] = []
async function tempRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "jev-telemetry-"))
  dirs.push(base)
  return join(base, "td-opencode-plugin", "jev")
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)

describe("sanitizeTelemetryEvent", () => {
  test("keeps only allowlisted, valid fields", () => {
    const row = sanitizeTelemetryEvent(
      {
        point: "safetyPreCheck",
        mode: "enforce",
        sessionID: "ses_raw_id_123",
        model: "jev-1.14.0",
        probability: 0.83,
        choice: "assertion",
        score: 2.5,
        threshold: 0.2,
        applied: true,
        latencyMs: 329.4,
        cached: false,
        errorCode: "overloaded",
        status: 529,
        inputChars: 100,
        outputChars: 20,
        estimatedTokens: 25,
        estimatedSavedTokens: -3,
        skillSetChanged: true,
        // Everything below must be dropped.
        command: "rm -rf /",
        prompt: "secret prompt",
        apiKey: "sk-test-not-a-real-key",
        output: "test output",
      },
      NOW,
    )
    expect(row).toEqual({
      time: "2026-11-12T12:00:00.000Z",
      point: "safetyPreCheck",
      mode: "enforce",
      session: hashName("ses_raw_id_123"),
      model: "jev-1.14.0",
      probability: 0.83,
      choice: "assertion",
      score: 2.5,
      threshold: 0.2,
      applied: true,
      latencyMs: 329,
      cached: false,
      errorCode: "overloaded",
      status: 529,
      inputChars: 100,
      outputChars: 20,
      estimatedTokens: 25,
      estimatedSavedTokens: -3,
      skillSetChanged: true,
    })
    const text = JSON.stringify(row)
    for (const leaked of ["rm -rf", "secret prompt", "sk-test", "test output", "ses_raw_id_123"]) expect(text).not.toContain(leaked)
  })

  test("drops invalid values and free text in labeled fields", () => {
    const row = sanitizeTelemetryEvent(
      {
        point: "testCompression",
        mode: "shadow",
        model: "rm -rf / and more text",
        choice: "has spaces and a long free text value",
        probability: 3,
        score: Number.NaN,
        latencyMs: -1,
        errorCode: "sk-test-not-a-real-key",
        status: 42,
        applied: "yes",
        inputChars: Infinity,
      },
      NOW,
    )
    expect(row).toEqual({ time: "2026-11-12T12:00:00.000Z", point: "testCompression", mode: "shadow" })
  })

  test("model accepts only jev names and choice only the fixed set; key-like strings never pass", () => {
    const fakeKeys = ["sk-test-not-a-real-key", "ak-test-not-a-real-key", "ts-test-not-a-real-key", "Bearer abcdef0123456789", "ghp_" + "a".repeat(36), "AKIA" + "IOSFODNN7EXAMPLE", "jev-sk-test-not-a-real-key", "jev-" + "ghp_" + "a".repeat(36), "jev-", "gpt-4", "claude-sonnet-5-5", "jev-1.14.0-r2", "jev-1.14.0-evil", "jev-nightly", "jev-1", "jev-1.14.0.1"]
    for (const value of fakeKeys) {
      const row = sanitizeTelemetryEvent({ point: "safetyPreCheck", mode: "shadow", model: value, choice: value }, NOW)
      expect(row).toEqual({ time: "2026-11-12T12:00:00.000Z", point: "safetyPreCheck", mode: "shadow" })
    }
    for (const model of ["jev-1.14.0", "jev-1.13.0", "jev-1.14", "jev-latest", "jev-preview"]) {
      expect(sanitizeTelemetryEvent({ point: "safetyPreCheck", mode: "shadow", model }, NOW)?.model).toBe(model)
    }
    for (const choice of ["assertion", "syntax", "environment", "timeout", "low", "medium", "high", "max"]) {
      expect(sanitizeTelemetryEvent({ point: "testCompression", mode: "shadow", choice }, NOW)?.choice).toBe(choice)
    }
    expect(TELEMETRY_CHOICES).toContain("assertion")
  })

  test("skillHash accepts exactly 32 lowercase hex characters and nothing else", () => {
    const good = hashName("my-skill-id")
    expect(good).toMatch(/^[0-9a-f]{32}$/)
    expect(sanitizeTelemetryEvent({ point: "skillPruning", mode: "shadow", skillHash: good }, NOW)?.skillHash).toBe(good)
    const plaintext = [
      "sk-test-not-a-real-key",
      "ts-test-not-a-real-key",
      "my-skill-id",
      "Bearer abcdef0123456789",
      "ghp_" + "a".repeat(36),
      "a".repeat(31),
      "a".repeat(33),
      "A".repeat(32),
      "g".repeat(32),
      `${good}\n`,
      ` ${good}`,
      `${good}${good}`,
      `${good.slice(0, 31)}-`,
      "",
      42,
      null,
      ["a".repeat(32)],
      { toString: () => good },
    ]
    for (const value of plaintext) {
      const row = sanitizeTelemetryEvent({ point: "skillPruning", mode: "shadow", skillHash: value }, NOW)
      expect(row).toEqual({ time: "2026-11-12T12:00:00.000Z", point: "skillPruning", mode: "shadow" })
    }
  })

  test("a skill ID in choice is still dropped, while skillHash carries its hash", () => {
    const row = sanitizeTelemetryEvent({ point: "skillPruning", mode: "shadow", choice: "my-skill-id", skillHash: hashName("my-skill-id") }, NOW)
    expect(row?.choice).toBeUndefined()
    expect(row?.skillHash).toBe(hashName("my-skill-id"))
    expect(JSON.stringify(row)).not.toContain("my-skill-id")
  })

  test("rejects an unknown point, an unknown mode, and non-objects", () => {
    expect(sanitizeTelemetryEvent({ point: "categoryRouting", mode: "shadow" }, NOW)).toBeUndefined()
    expect(sanitizeTelemetryEvent({ point: "safetyPreCheck", mode: "off-ish" }, NOW)).toBeUndefined()
    expect(sanitizeTelemetryEvent(null, NOW)).toBeUndefined()
    expect(sanitizeTelemetryEvent("x", NOW)).toBeUndefined()
  })
})

describe("writer", () => {
  test("writes private rows without command text or keys", async () => {
    const root = await tempRoot()
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW })
    telemetry.record({ point: "safetyPreCheck", mode: "enforce", sessionID: "ses_1", probability: 0.9, applied: true, command: "rm -rf ~ sk-test-not-a-real-key" } as never)
    telemetry.record({ point: "testCompression", mode: "shadow", choice: "syntax" })
    await telemetry.flush()
    const file = join(root, TELEMETRY_FILE)
    const text = await readFile(file, "utf8")
    const rows = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(rows.length).toBe(2)
    expect(rows[0]?.point).toBe("safetyPreCheck")
    expect(text).not.toContain("rm -rf")
    expect(text).not.toContain("sk-test")
    expect(text).not.toContain("ses_1")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })

  test("disabled telemetry creates nothing", async () => {
    const root = await tempRoot()
    const telemetry = createJevTelemetry({ root, enabled: false })
    telemetry.record({ point: "safetyPreCheck", mode: "enforce" })
    await telemetry.flush()
    await expect(stat(root)).rejects.toThrow()
  })

  test("concurrent records produce whole lines", async () => {
    const root = await tempRoot()
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW })
    for (let index = 0; index < 200; index++) telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: index })
    await telemetry.flush()
    const lines = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n")
    expect(lines.length).toBe(200)
    lines.forEach((line, index) => expect((JSON.parse(line) as { inputChars: number }).inputChars).toBe(index))
  })

  test("two handles for one root share one writer and keep order", async () => {
    const root = await tempRoot()
    const a = createJevTelemetry({ root, enabled: true, now: () => NOW })
    const b = createJevTelemetry({ root, enabled: true, now: () => NOW })
    for (let index = 0; index < 20; index++) (index % 2 ? a : b).record({ point: "safetyPreCheck", mode: "shadow", inputChars: index })
    await Promise.all([a.flush(), b.flush()])
    const lines = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n")
    expect(lines.map((line) => (JSON.parse(line) as { inputChars: number }).inputChars)).toEqual(Array.from({ length: 20 }, (_, index) => index))
  })

  test("the last disposed handle removes the writer; a shared handle never closes another's writer", async () => {
    const before = activeTelemetryWriters()
    const root = await tempRoot()
    const a = createJevTelemetry({ root, enabled: true, now: () => NOW })
    const b = createJevTelemetry({ root, enabled: true, now: () => NOW })
    expect(activeTelemetryWriters()).toBe(before + 1)
    a.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 1 })
    await a.dispose()
    expect(activeTelemetryWriters()).toBe(before + 1)
    b.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 2 })
    await b.flush()
    await a.dispose() // a second dispose of the same handle changes nothing
    expect(activeTelemetryWriters()).toBe(before + 1)
    await b.dispose()
    expect(activeTelemetryWriters()).toBe(before)
    const rows = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { inputChars: number }).inputChars)
    expect(rows).toEqual([1, 2])
    // A new handle for the same root works after the writer was removed.
    const c = createJevTelemetry({ root, enabled: true, now: () => NOW })
    c.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 3 })
    await c.dispose()
    expect(activeTelemetryWriters()).toBe(before)
    expect((await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n").length).toBe(3)
  })

  test("a write failure is logged through a live handle, never through a disposed one", async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    await symlink(join(root, "nowhere"), join(root, TELEMETRY_FILE))
    const first = createMemoryLogger()
    const second = createMemoryLogger()
    const a = createJevTelemetry({ root, enabled: true, log: first, now: () => NOW })
    const b = createJevTelemetry({ root, enabled: true, log: second, now: () => NOW })
    await a.dispose()
    b.record({ point: "safetyPreCheck", mode: "shadow" })
    await b.flush()
    expect(first.lines).toEqual([])
    expect(second.lines.some((line) => line.includes("telemetry write failed"))).toBe(true)
    await b.dispose()
  })

  test("many roots do not leave writers behind once disposed", async () => {
    const before = activeTelemetryWriters()
    for (let index = 0; index < 25; index++) {
      const handle = createJevTelemetry({ root: await tempRoot(), enabled: true, now: () => NOW })
      handle.record({ point: "safetyPreCheck", mode: "shadow" })
      await handle.dispose()
    }
    expect(activeTelemetryWriters()).toBe(before)
  })

  test("1000 records keep the queue bounded and use one drain task", async () => {
    const root = await tempRoot()
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW })
    // Record from one tick: the queue cap must hold, and extra rows are dropped instead of chained.
    for (let index = 0; index < 1000; index++) telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: index })
    await telemetry.flush()
    const lines = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n")
    expect(lines.length).toBeLessThanOrEqual(TELEMETRY_MAX_PENDING + 1)
    expect(lines.length).toBeGreaterThanOrEqual(TELEMETRY_MAX_PENDING)
    // Rows stay in order and whole.
    const values = lines.map((line) => (JSON.parse(line) as { inputChars: number }).inputChars)
    expect(values).toEqual([...values].sort((x, y) => x - y))
    // The writer accepts new rows after it drained.
    telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 5000 })
    await telemetry.dispose()
    const after = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n")
    expect(after.length).toBe(lines.length + 1)
  })

  test("a disposed handle ignores events", async () => {
    const root = await tempRoot()
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW })
    telemetry.record({ point: "safetyPreCheck", mode: "shadow" })
    await telemetry.dispose()
    telemetry.record({ point: "safetyPreCheck", mode: "shadow" })
    await telemetry.flush()
    expect((await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n").length).toBe(1)
  })

  test("rotates at the limit; total stays within two files", async () => {
    const root = await tempRoot()
    const limit = 2048
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW, maxFileBytes: limit })
    for (let index = 0; index < 400; index++) telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: index, model: "jev-1.14.0" })
    await telemetry.flush()
    const names = (await readdir(root)).sort()
    expect(names).toEqual([TELEMETRY_FILE, `${TELEMETRY_FILE}.1`])
    let total = 0
    for (const name of names) {
      const size = (await stat(join(root, name))).size
      expect(size).toBeLessThanOrEqual(limit)
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600)
      total += size
    }
    expect(total).toBeLessThanOrEqual(2 * limit)
    // The newest row is in the current file, and every kept line is whole JSON.
    const current = (await readFile(join(root, TELEMETRY_FILE), "utf8")).trim().split("\n")
    for (const line of current) JSON.parse(line)
    expect((JSON.parse(current.at(-1) as string) as { inputChars: number }).inputChars).toBe(399)
  })

  test("a row is bounded", () => {
    const row = sanitizeTelemetryEvent({ point: "safetyPreCheck", mode: "enforce", sessionID: "x".repeat(100_000), model: "m".repeat(64) }, NOW)
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(TELEMETRY_MAX_ROW_BYTES)
  })

  test("never follows a symlink at the telemetry path", async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const victim = join(root, "..", "victim.txt")
    await writeFile(victim, "original")
    await symlink(victim, join(root, TELEMETRY_FILE))
    const log = createMemoryLogger()
    const telemetry = createJevTelemetry({ root, enabled: true, log, now: () => NOW })
    telemetry.record({ point: "safetyPreCheck", mode: "enforce" })
    await telemetry.flush()
    expect(await readFile(victim, "utf8")).toBe("original")
    expect(log.lines.some((line) => line.includes("telemetry write failed"))).toBe(true)
  })

  test("a rotated .1 symlink is replaced, not followed", async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true, mode: 0o700 })
    const victim = join(root, "..", "victim2.txt")
    await writeFile(victim, "original")
    await writeFile(join(root, TELEMETRY_FILE), "x".repeat(2000), { mode: 0o600 })
    await symlink(victim, join(root, `${TELEMETRY_FILE}.1`))
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW, maxFileBytes: 2048 })
    telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 1, model: "jev-1.14.0" })
    telemetry.record({ point: "safetyPreCheck", mode: "shadow", inputChars: 2, model: "jev-1.14.0" })
    await telemetry.flush()
    expect(await readFile(victim, "utf8")).toBe("original")
    expect((await readFile(join(root, `${TELEMETRY_FILE}.1`), "utf8")).startsWith("xxxx")).toBe(true)
  })

  test("a loose file mode is tightened and a loose directory too", async () => {
    const root = await tempRoot()
    await mkdir(root, { recursive: true })
    await chmod(root, 0o755)
    await writeFile(join(root, TELEMETRY_FILE), "", { mode: 0o644 })
    await chmod(join(root, TELEMETRY_FILE), 0o644)
    const telemetry = createJevTelemetry({ root, enabled: true, now: () => NOW })
    telemetry.record({ point: "safetyPreCheck", mode: "shadow" })
    await telemetry.flush()
    expect((await stat(join(root, TELEMETRY_FILE))).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })
})
