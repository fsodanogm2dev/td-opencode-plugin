import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { defaultJevRoot, hashName, JevArtifactError, JevArtifacts, LOG_RETENTION_MS } from "../../../src/jev/artifacts.ts"

const bases: string[] = []
async function tempBase(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "jev-artifacts-"))
  bases.push(base)
  return base
}
afterEach(async () => {
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true })
})

const KEY = "ts-test-not-a-real-key"
const DAY = 24 * 60 * 60 * 1000

describe("defaultJevRoot", () => {
  test("uses an absolute XDG_DATA_HOME", () => {
    expect(defaultJevRoot({ XDG_DATA_HOME: "/data/xdg" }, "/home/u")).toBe("/data/xdg/td-opencode-plugin/jev")
  })
  test("falls back to the home directory for unset, relative, or empty values", () => {
    const expected = join("/home/u", ".local", "share", "td-opencode-plugin", "jev")
    for (const value of [undefined, "", "relative/path"]) expect(defaultJevRoot({ XDG_DATA_HOME: value }, "/home/u")).toBe(expected)
  })
  test("the real home directory works", () => {
    expect(defaultJevRoot({}, homedir()).endsWith(join("td-opencode-plugin", "jev"))).toBe(true)
  })
})

describe("root guard", () => {
  test.each(["", "relative/root", "/", "/tmp/a\0b"])("rejects %j", (root) => {
    expect(() => new JevArtifacts(root)).toThrow(JevArtifactError)
  })

  test("rejects a symlinked root", async () => {
    const base = await tempBase()
    const real = join(base, "real")
    await mkdir(real, { mode: 0o700 })
    const root = join(base, "link")
    await symlink(real, root)
    await expect(new JevArtifacts(root).writeLog("s", "c", "x")).rejects.toMatchObject({ code: "unsafe-path" })
    expect(await readdir(real)).toEqual([])
  })

  test("rejects a symlinked logs directory and does not write through it", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    await mkdir(root, { mode: 0o700 })
    const elsewhere = join(base, "elsewhere")
    await mkdir(elsewhere)
    await symlink(elsewhere, join(root, "logs"))
    await expect(new JevArtifacts(root).writeLog("s", "c", "x")).rejects.toMatchObject({ code: "unsafe-path" })
    expect(await readdir(elsewhere)).toEqual([])
  })

  test("rejects a symlinked session directory", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const artifacts = new JevArtifacts(root)
    const elsewhere = join(base, "elsewhere")
    await mkdir(elsewhere)
    await mkdir(join(root, "logs"), { recursive: true, mode: 0o700 })
    await symlink(elsewhere, join(root, "logs", hashName("sess")))
    await expect(artifacts.writeLog("sess", "call", "x")).rejects.toMatchObject({ code: "unsafe-path" })
    expect(await readdir(elsewhere)).toEqual([])
  })

  test("rejects a symlink at the log file path", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const artifacts = new JevArtifacts(root)
    await artifacts.writeLog("sess", "call", "first")
    const file = artifacts.logPath("sess", "call")
    const victim = join(base, "victim.txt")
    await writeFile(victim, "original")
    await rm(file)
    await symlink(victim, file)
    await expect(artifacts.writeLog("sess", "call", "second")).rejects.toMatchObject({ code: "unsafe-path" })
    expect(await readFile(victim, "utf8")).toBe("original")
  })
})

describe("writeLog", () => {
  test("stores a private, redacted artifact under hashed names", async () => {
    const base = await tempBase()
    const root = join(base, "xdg", "td-opencode-plugin", "jev")
    const artifacts = new JevArtifacts(root)
    const content = `FAIL test/a.test.ts\nAuthorization: Bearer abcdef0123456789\nkey=${KEY}\nexpected 1 to be 2\nDB_PASSWORD=hunter2`
    const file = await artifacts.writeLog("ses_ABC/raw id", "call_123", content, { secrets: [KEY] })
    expect(file).toBe(artifacts.logPath("ses_ABC/raw id", "call_123"))
    expect(file).toMatch(/logs\/[0-9a-f]{32}\/[0-9a-f]{32}\.log$/)
    expect(file).not.toContain("ses_ABC")
    expect(file).not.toContain("call_123")
    const text = await readFile(file, "utf8")
    for (const secret of ["abcdef0123456789", KEY, "hunter2"]) expect(text).not.toContain(secret)
    expect(text).toContain("FAIL test/a.test.ts")
    expect(text).toContain("expected 1 to be 2")
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, "logs"))).mode & 0o777).toBe(0o700)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })

  test("replaces a log of the same call atomically and leaves no temp files", async () => {
    const base = await tempBase()
    const artifacts = new JevArtifacts(join(base, "jev"))
    const file = await artifacts.writeLog("s", "c", "first")
    await artifacts.writeLog("s", "c", "second")
    expect(await readFile(file, "utf8")).toBe("second")
    expect(await readdir(join(file, ".."))).toEqual([file.split("/").at(-1) as string])
  })

  test("tightens a loose existing directory", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    await mkdir(root)
    await chmod(root, 0o755)
    await new JevArtifacts(root).writeLog("s", "c", "x")
    expect((await stat(root)).mode & 0o777).toBe(0o700)
  })

  test("refuses an output above the redaction limit and writes nothing", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const artifacts = new JevArtifacts(root)
    const big = `${KEY} ${"x".repeat(4 * 1024 * 1024)}`
    await expect(artifacts.writeLog("s", "c", big, { secrets: [KEY] })).rejects.toMatchObject({ code: "too-large" })
    await expect(stat(artifacts.logPath("s", "c"))).rejects.toThrow()
    // A text at the limit is stored, redacted.
    const file = await artifacts.writeLog("s", "c", `${KEY} ${"x".repeat(1000)}`, { secrets: [KEY] })
    expect((await readFile(file, "utf8")).includes(KEY)).toBe(false)
  })

  test("invalid IDs are rejected", async () => {
    const artifacts = new JevArtifacts(join(await tempBase(), "jev"))
    await expect(artifacts.writeLog("", "c", "x")).rejects.toMatchObject({ code: "invalid-name" })
    await expect(artifacts.writeLog("s", "a\0b", "x")).rejects.toMatchObject({ code: "invalid-name" })
  })

  test("error messages never contain content or keys", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    await mkdir(root, { mode: 0o700 })
    await writeFile(join(root, "logs"), "i am a file, not a directory")
    const error = await new JevArtifacts(root).writeLog("s", "c", `secret ${KEY}`, { secrets: [KEY] }).catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(JevArtifactError)
    expect(`${(error as Error).message}`).not.toContain(KEY)
  })
})

describe("cleanup", () => {
  test("deletes only old owned logs; keeps fresh logs and foreign files", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    let now = Date.now()
    const artifacts = new JevArtifacts(root, { now: () => now })
    const oldFile = await artifacts.writeLog("old-session", "old-call", "old")
    const freshFile = await artifacts.writeLog("new-session", "new-call", "new")
    const sibling = await artifacts.writeLog("old-session", "fresh-call", "fresh")
    const past = new Date(now - 8 * DAY)
    await utimes(oldFile, past, past)
    const foreign = join(root, "logs", hashName("old-session"), "notes.txt")
    await writeFile(foreign, "mine")
    await utimes(foreign, past, past)
    const stray = join(root, "telemetry.jsonl")
    await writeFile(stray, "rows")
    await utimes(stray, past, past)

    const result = await artifacts.cleanup()
    expect(result).toEqual({ deleted: 1, kept: 2 })
    await expect(stat(oldFile)).rejects.toThrow()
    expect(await readFile(freshFile, "utf8")).toBe("new")
    expect(await readFile(sibling, "utf8")).toBe("fresh")
    expect(await readFile(foreign, "utf8")).toBe("mine")
    expect(await readFile(stray, "utf8")).toBe("rows")

    // After the retention period, everything it owns is deleted and empty directories go away.
    now += LOG_RETENTION_MS + DAY
    const second = await artifacts.cleanup()
    expect(second.deleted).toBe(2)
    expect(await readdir(join(root, "logs"))).toEqual([hashName("old-session")])
  })

  test("removes old .tmp-<24 hex> remnants of interrupted writes, and only those", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const now = Date.now()
    const artifacts = new JevArtifacts(root, { now: () => now })
    const live = await artifacts.writeLog("s", "c", "x")
    const dir = join(live, "..")
    const past = new Date(now - 8 * DAY)
    const oldTemp = join(dir, `.tmp-${"ab".repeat(12)}`)
    const freshTemp = join(dir, `.tmp-${"cd".repeat(12)}`)
    const foreign = [".tmp-short", ".tmp-" + "zz".repeat(12), `.tmp-${"ab".repeat(12)}.bak`, "other.tmp"].map((name) => join(dir, name))
    for (const file of [oldTemp, freshTemp, ...foreign]) await writeFile(file, "t")
    for (const file of [oldTemp, ...foreign]) await utimes(file, past, past)
    const result = await artifacts.cleanup()
    expect(result.deleted).toBe(1)
    await expect(stat(oldTemp)).rejects.toThrow()
    expect(await readFile(freshTemp, "utf8")).toBe("t")
    for (const file of foreign) expect(await readFile(file, "utf8")).toBe("t")
    expect(await readFile(live, "utf8")).toBe("x")
  })

  test("a symlink or directory with a temp name is never followed or deleted", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const now = Date.now()
    const artifacts = new JevArtifacts(root, { now: () => now })
    const live = await artifacts.writeLog("s", "c", "x")
    const dir = join(live, "..")
    const victim = join(base, "victim.txt")
    await writeFile(victim, "keep")
    const past = new Date(now - 30 * DAY)
    await utimes(victim, past, past)
    await symlink(victim, join(dir, `.tmp-${"ab".repeat(12)}`))
    await mkdir(join(dir, `.tmp-${"cd".repeat(12)}`))
    expect((await artifacts.cleanup()).deleted).toBe(0)
    expect(await readFile(victim, "utf8")).toBe("keep")
    expect((await stat(join(dir, `.tmp-${"cd".repeat(12)}`))).isDirectory()).toBe(true)
  })

  test("removes an emptied session directory", async () => {
    const base = await tempBase()
    let now = Date.now()
    const artifacts = new JevArtifacts(join(base, "jev"), { now: () => now })
    await artifacts.writeLog("s", "c", "x")
    now += 8 * DAY
    expect((await artifacts.cleanup()).deleted).toBe(1)
    expect(await readdir(join(base, "jev", "logs"))).toEqual([])
  })

  test("never follows a symlinked file or session directory", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    let now = Date.now()
    const artifacts = new JevArtifacts(root, { now: () => now })
    const real = await artifacts.writeLog("s", "c", "x")
    const victimDir = join(base, "victim-dir")
    await mkdir(victimDir)
    const victimFile = join(victimDir, `${"a".repeat(32)}.log`)
    await writeFile(victimFile, "keep me")
    const past = new Date(now - 30 * DAY)
    await utimes(victimFile, past, past)
    // A symlinked file with a valid log name, and a symlinked session directory with a valid name.
    await symlink(victimFile, join(root, "logs", hashName("s"), `${"b".repeat(32)}.log`))
    await symlink(victimDir, join(root, "logs", "c".repeat(32)))
    await utimes(real, past, past)
    const result = await artifacts.cleanup()
    expect(result.deleted).toBe(1)
    expect(await readFile(victimFile, "utf8")).toBe("keep me")
    expect((await readdir(victimDir)).length).toBe(1)
  })

  test("a symlinked root is rejected before anything is listed or deleted", async () => {
    const base = await tempBase()
    // `elsewhere` looks like a Jev root with an old, well-named log inside.
    const elsewhere = join(base, "elsewhere")
    const sessionDir = join(elsewhere, "logs", hashName("s"))
    await mkdir(sessionDir, { recursive: true, mode: 0o700 })
    const target = join(sessionDir, `${"e".repeat(32)}.log`)
    await writeFile(target, "keep")
    const past = new Date(Date.now() - 30 * DAY)
    await utimes(target, past, past)
    const root = join(base, "jev-link")
    await symlink(elsewhere, root)
    expect(await new JevArtifacts(root).cleanup()).toEqual({ deleted: 0, kept: 0 })
    expect(await readFile(target, "utf8")).toBe("keep")
  })

  test("a root that others can write to is not traversed, and permissions are not changed", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const artifacts = new JevArtifacts(root)
    const file = await artifacts.writeLog("s", "c", "x")
    const past = new Date(Date.now() - 30 * DAY)
    await utimes(file, past, past)
    await chmod(root, 0o777)
    expect(await artifacts.cleanup()).toEqual({ deleted: 0, kept: 0 })
    expect((await stat(root)).mode & 0o777).toBe(0o777)
    expect(await readFile(file, "utf8")).toBe("x")
    await chmod(root, 0o700)
    expect((await artifacts.cleanup()).deleted).toBe(1)
  })

  test("a logs directory that others can write to is not traversed", async () => {
    const base = await tempBase()
    const root = join(base, "jev")
    const artifacts = new JevArtifacts(root)
    const file = await artifacts.writeLog("s", "c", "x")
    const past = new Date(Date.now() - 30 * DAY)
    await utimes(file, past, past)
    await chmod(join(root, "logs"), 0o770)
    expect(await artifacts.cleanup()).toEqual({ deleted: 0, kept: 0 })
    expect(await readFile(file, "utf8")).toBe("x")
  })

  test("a missing or symlinked logs directory is not traversed", async () => {
    const base = await tempBase()
    const missing = new JevArtifacts(join(base, "none"))
    expect(await missing.cleanup()).toEqual({ deleted: 0, kept: 0 })
    const root = join(base, "jev")
    await mkdir(root, { mode: 0o700 })
    const elsewhere = join(base, "elsewhere", hashName("s"))
    await mkdir(elsewhere, { recursive: true })
    const target = join(elsewhere, `${"d".repeat(32)}.log`)
    await writeFile(target, "keep")
    const past = new Date(Date.now() - 30 * DAY)
    await utimes(target, past, past)
    await symlink(join(base, "elsewhere"), join(root, "logs"))
    expect(await new JevArtifacts(root).cleanup()).toEqual({ deleted: 0, kept: 0 })
    expect(await readFile(target, "utf8")).toBe("keep")
  })
})
