import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseGuardStoreText } from "../../../src/guards/schema.ts"
import { RESET_CONFIRMATION } from "../../service/app.ts"
import { nodeFs, type FsPort } from "../../service/ports.ts"
import { FakeBridge, call, createGuard, enable, goodDraft, makeApp, makeEnv, opId, type Env } from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

const guardsDir = () => join(env.root, "guards")
const storeFile = () => join(guardsDir(), "store.json")
const backups = () => readdirSync(guardsDir()).filter((n) => n.startsWith("store.corrupt-"))
const EPOCH_SECONDS = Math.floor(Date.parse("2026-11-12T10:00:00.000Z") / 1000)

function corrupt(text: string) {
  mkdirSync(guardsDir(), { recursive: true })
  writeFileSync(storeFile(), text, { mode: 0o644 })
}

const recover = (app: ReturnType<typeof makeApp>, body: unknown = { opId: opId(), confirmation: RESET_CONFIRMATION }) =>
  call(app, "POST", "/store/recover", body)

describe("corrupt store", () => {
  test("every read and write fails with STORE_CORRUPT and changes nothing until recovery is confirmed", async () => {
    env = makeEnv()
    const bridge = new FakeBridge().add("ses_root")
    const app = makeApp(env, { bridge })
    const guard = (await createGuard(app)).body.data.guard
    const activation = (await enable(app, guard.id, "ses_root")).body.data.activation
    const broken = '{"schema":"td-guards/1","revision":"x"'
    writeFileSync(storeFile(), broken)

    const results = [
      await call(app, "GET", "/state"),
      await createGuard(app),
      await enable(app, guard.id, "ses_root", "request"),
      await call(app, "DELETE", `/activations/${activation.id}`, { opId: opId() }),
      await call(app, "DELETE", `/guards/${guard.id}`, { opId: opId() }),
    ]
    for (const r of results) {
      expect(r.status).toBe(503)
      expect(r.body.error.code).toBe("STORE_CORRUPT")
    }
    expect(readFileSync(storeFile(), "utf8")).toBe(broken)
    expect(backups()).toEqual([])
  })

  test("a missing or wrong confirmation is refused and touches nothing", async () => {
    env = makeEnv()
    corrupt("not json")
    const app = makeApp(env)
    for (const body of [
      { opId: opId() },
      { opId: opId(), confirmation: "yes" },
      { opId: opId(), confirmation: "Reset-Global-Guards" },
      { opId: opId(), confirmation: true },
    ]) {
      const r = await recover(app, body)
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe("CONFIRMATION_REQUIRED")
      expect(r.body.error.message).toContain("all projects")
    }
    expect((await recover(app, { opId: opId(), confirmation: RESET_CONFIRMATION, extra: 1 })).body.error.code).toBe("INVALID_REQUEST")
    expect((await recover(app, { confirmation: RESET_CONFIRMATION })).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "GET", "/store/recover")).status).toBe(405)
    expect(readFileSync(storeFile(), "utf8")).toBe("not json")
    expect(backups()).toEqual([])
  })

  test("recovery keeps the exact bytes as a private backup and writes a valid empty store", async () => {
    env = makeEnv()
    const raw = '{"schema":"td-guards/1","revision":41,"guards":[{"id":"SECRET-LOOKING-VALUE"'
    corrupt(raw)
    const app = makeApp(env)
    const id = opId()
    const r = await recover(app, { opId: id, confirmation: RESET_CONFIRMATION })
    expect(r.status).toBe(200)
    expect(Object.keys(r.body.data).sort()).toEqual(["backup", "recovered", "revision"])
    expect(r.body.data.recovered).toBe(true)
    expect(r.body.data.backup).toMatch(/^store\.corrupt-20261112T100000Z-[0-9a-z]+\.json$/)
    // Raw revision 41 is known, but the epoch counter is higher, so the new revision is the larger one.
    expect(r.body.data.revision).toBe(EPOCH_SECONDS)

    const backupPath = join(guardsDir(), r.body.data.backup)
    expect(readFileSync(backupPath, "utf8")).toBe(raw)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600)
    const parsed = parseGuardStoreText(readFileSync(storeFile(), "utf8"))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.guards).toEqual([])
      expect(parsed.value.activations).toEqual([])
      expect(parsed.value.revision).toBe(EPOCH_SECONDS)
    }
    expect(readFileSync(storeFile(), "utf8")).not.toContain("SECRET-LOOKING-VALUE")
    expect(readdirSync(guardsDir()).sort()).toEqual([r.body.data.backup, "store.json"].sort())

    const view = await call(app, "GET", "/state")
    expect(view.status).toBe(200)
    expect(view.body.data).toMatchObject({ revision: EPOCH_SECONDS, guards: [], activations: [] })
    // Ordinary writes work again and continue from the new revision.
    expect((await createGuard(app)).body.data.revision).toBe(EPOCH_SECONDS + 1)
  })

  test("a raw revision above the epoch counter is kept monotonic", async () => {
    env = makeEnv()
    corrupt(`{"schema":"td-guards/1","revision":${EPOCH_SECONDS + 5_000},"guards":"broken"}`)
    const r = await recover(makeApp(env))
    expect(r.body.data.revision).toBe(EPOCH_SECONDS + 5_001)
  })

  test("an invalid revision value falls back to the epoch counter", async () => {
    env = makeEnv()
    for (const text of ['{"revision":-1}', '{"revision":1.5}', '{"revision":"9"}', "[]", ""]) {
      corrupt(text)
      const r = await recover(makeApp(env))
      expect(r.status).toBe(200)
      expect(r.body.data.revision).toBe(EPOCH_SECONDS)
    }
  })

  test("a retry with the same opId replays once and never adds a second backup", async () => {
    env = makeEnv()
    corrupt("garbage")
    const app = makeApp(env)
    const body = { opId: "op-recover-0001", confirmation: RESET_CONFIRMATION }
    const first = await recover(app, body)
    const again = await recover(makeApp(env), body)
    expect(again.status).toBe(200)
    expect(again.body.data).toMatchObject({ recovered: true, backup: first.body.data.backup, replayed: true })
    expect(again.body.data.revision).toBe(first.body.data.revision)
    expect(backups()).toHaveLength(1)
    // After more writes the retry still answers from the stored outcome, with the current revision.
    await createGuard(app)
    const later = await recover(app, body)
    expect(later.body.data).toMatchObject({ backup: first.body.data.backup, replayed: true, revision: EPOCH_SECONDS + 1 })
    expect(backups()).toHaveLength(1)
  })

  test("the same opId for a different operation is a conflict", async () => {
    env = makeEnv()
    corrupt("garbage")
    const app = makeApp(env)
    await recover(app, { opId: "op-recover-0002", confirmation: RESET_CONFIRMATION })
    const other = await call(app, "POST", "/guards", { opId: "op-recover-0002", draft: goodDraft })
    expect(other.status).toBe(409)
    expect(other.body.error.code).toBe("OP_ID_REUSED")
  })

  test("a readable store is never reset: a new opId gets RECOVERY_NOT_NEEDED", async () => {
    env = makeEnv()
    const app = makeApp(env)
    await createGuard(app)
    const before = readFileSync(storeFile(), "utf8")
    const r = await recover(app)
    expect(r.status).toBe(409)
    expect(r.body.error).toEqual({ code: "RECOVERY_NOT_NEEDED", message: "The guard store is readable, so nothing was reset." })
    expect(readFileSync(storeFile(), "utf8")).toBe(before)
    expect(backups()).toEqual([])
  })

  test("a missing store is an empty store, not corruption", async () => {
    env = makeEnv()
    const r = await recover(makeApp(env))
    expect(r.body.error.code).toBe("RECOVERY_NOT_NEEDED")
    expect(existsSync(storeFile())).toBe(false)
    expect(backups()).toEqual([])
  })

  test("a failed reset write leaves the original file and no backup or temp file", async () => {
    env = makeEnv()
    const raw = "corrupt-original"
    corrupt(raw)
    for (const failing of ["rename", "link"] as const) {
      const fs: FsPort = {
        ...nodeFs,
        async rename(from, to) {
          if (failing === "rename" && to.endsWith("store.json")) throw new Error("disk full")
          return nodeFs.rename(from, to)
        },
        async link(from, to) {
          if (failing === "link" && to.includes("store.corrupt-")) throw new Error("no links")
          return nodeFs.link(from, to)
        },
      }
      const app = makeApp(env, { runtime: env.runtime({ fs }) })
      const r = await recover(app)
      expect(r.status).toBe(503)
      expect(r.body.error.code).toBe("STORE_UNAVAILABLE")
      expect(readFileSync(storeFile(), "utf8")).toBe(raw)
      expect(readdirSync(guardsDir())).toEqual(["store.json"])
    }
    // A later attempt with a working file system succeeds.
    expect((await recover(makeApp(env))).status).toBe(200)
  })

  test("an unreadable store file can be reset, and its bytes are preserved", async () => {
    env = makeEnv()
    corrupt("unreadable-bytes")
    const fs: FsPort = {
      ...nodeFs,
      async readText(path) {
        if (path.endsWith("store.json")) throw Object.assign(new Error("denied"), { code: "EACCES" })
        return nodeFs.readText(path)
      },
    }
    const r = await recover(makeApp(env, { runtime: env.runtime({ fs }) }))
    expect(r.status).toBe(200)
    expect(r.body.data.revision).toBe(EPOCH_SECONDS)
    expect(readFileSync(join(guardsDir(), r.body.data.backup), "utf8")).toBe("unreadable-bytes")
    expect(parseGuardStoreText(readFileSync(storeFile(), "utf8")).ok).toBe(true)
  })

  test("two services racing: the same opId yields one reset, another opId yields RECOVERY_NOT_NEEDED", async () => {
    env = makeEnv()
    corrupt("garbage")
    const a = makeApp(env)
    const b = makeApp(env)
    const same = await Promise.all([recover(a, { opId: "op-race-same-1", confirmation: RESET_CONFIRMATION }), recover(b, { opId: "op-race-same-1", confirmation: RESET_CONFIRMATION })])
    expect(same.map((r) => r.status)).toEqual([200, 200])
    expect(same.filter((r) => r.body.data.replayed).length).toBe(1)
    expect(backups()).toHaveLength(1)

    env.cleanup()
    env = makeEnv()
    corrupt("garbage")
    const x = makeApp(env)
    const y = makeApp(env)
    const different = await Promise.all([recover(x, { opId: "op-race-diff-1", confirmation: RESET_CONFIRMATION }), recover(y, { opId: "op-race-diff-2", confirmation: RESET_CONFIRMATION })])
    expect(different.map((r) => r.status).sort()).toEqual([200, 409])
    expect(backups()).toHaveLength(1)
  })

  test("the lock is the same as for ordinary mutations: a held lock blocks recovery with LOCK_TIMEOUT", async () => {
    env = makeEnv()
    corrupt("garbage")
    env.procs.alive.add(9001)
    env.procs.tokens.set(9001, "start-9001")
    writeFileSync(join(guardsDir(), "store.lock"), JSON.stringify({ pid: 9001, token: "live", startToken: "start-9001", acquiredAt: "x" }))
    const r = await recover(makeApp(env, { lockTimeoutMs: 200 }))
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe("LOCK_TIMEOUT")
    expect(readFileSync(storeFile(), "utf8")).toBe("garbage")
    expect(backups()).toEqual([])
  })
})
