import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseGuardStoreText } from "../../../src/guards/schema.ts"
import { RESET_CONFIRMATION } from "../../service/app.ts"
import { nodeFs, type FsPort } from "../../service/ports.ts"
import { call, goodDraft, makeApp, makeEnv, type Env } from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

const guardsDir = () => join(env.root, "guards")
const storeFile = () => join(guardsDir(), "store.json")
const stored = () => JSON.parse(readFileSync(storeFile(), "utf8"))
const backups = () => readdirSync(guardsDir()).filter((n) => n.startsWith("store.corrupt-"))

/** A file system whose directory sync fails: it runs after the rename has already happened. */
const failingSync: FsPort = {
  ...nodeFs,
  async syncDir() {
    throw new Error("sync failed")
  },
}

const MESSAGE = "The change may already be applied. Reload the guard data or retry the same request."

describe("failure after the rename", () => {
  test("a create answers OUTCOME_UNKNOWN, the new state exists, and the same opId replays once", async () => {
    env = makeEnv()
    const broken = makeApp(env, { runtime: env.runtime({ fs: failingSync }) })
    const body = { opId: "op-commit-0001", draft: goodDraft }
    const r = await call(broken, "POST", "/guards", body)
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ ok: false, error: { code: "OUTCOME_UNKNOWN", message: MESSAGE } })
    // The change is on disk and its operation id is recorded.
    expect(stored().guards).toHaveLength(1)
    expect(stored().revision).toBe(1)
    expect(stored().operations.map((o: any) => o.opId)).toEqual(["op-commit-0001"])
    expect(readdirSync(guardsDir()).sort()).toEqual(["store.json"])

    const retry = await call(makeApp(env), "POST", "/guards", body)
    expect(retry.status).toBe(200)
    expect(retry.body.data.replayed).toBe(true)
    expect(retry.body.data.guard.id).toBe(stored().guards[0].id)
    expect(stored().guards).toHaveLength(1)
    expect(stored().revision).toBe(1)
  })

  test("a failure before the rename is still STORE_UNAVAILABLE and leaves the old file", async () => {
    env = makeEnv()
    const first = makeApp(env)
    await call(first, "POST", "/guards", { opId: "op-commit-0002", draft: goodDraft })
    const before = readFileSync(storeFile(), "utf8")
    const fs: FsPort = {
      ...nodeFs,
      async rename(from, to) {
        if (to.endsWith("store.json")) throw new Error("disk full")
        return nodeFs.rename(from, to)
      },
    }
    const r = await call(makeApp(env, { runtime: env.runtime({ fs }) }), "POST", "/guards", { opId: "op-commit-0003", draft: goodDraft })
    expect(r.status).toBe(503)
    expect(r.body.error.code).toBe("STORE_UNAVAILABLE")
    expect(readFileSync(storeFile(), "utf8")).toBe(before)
    expect(readdirSync(guardsDir()).sort()).toEqual(["store.json"])
  })

  test("a reset answers OUTCOME_UNKNOWN, the reset is in place with one backup, and the same opId replays", async () => {
    env = makeEnv()
    mkdirSync(guardsDir(), { recursive: true })
    const raw = "corrupt-original"
    writeFileSync(storeFile(), raw)
    const body = { opId: "op-commit-reset1", confirmation: RESET_CONFIRMATION }
    const r = await call(makeApp(env, { runtime: env.runtime({ fs: failingSync }) }), "POST", "/store/recover", body)
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ ok: false, error: { code: "OUTCOME_UNKNOWN", message: MESSAGE } })

    // The store is already the valid empty one, the backup holds the old bytes, and the opId is recorded.
    const parsed = parseGuardStoreText(readFileSync(storeFile(), "utf8"))
    expect(parsed.ok).toBe(true)
    expect(stored().operations.map((o: any) => o.opId)).toEqual(["op-commit-reset1"])
    expect(backups()).toHaveLength(1)
    expect(readFileSync(join(guardsDir(), backups()[0]!), "utf8")).toBe(raw)

    const retry = await call(makeApp(env), "POST", "/store/recover", body)
    expect(retry.status).toBe(200)
    expect(retry.body.data).toMatchObject({ recovered: true, backup: backups()[0], replayed: true })
    expect(backups()).toHaveLength(1)
    // A new opId on the now-valid store resets nothing.
    const other = await call(makeApp(env), "POST", "/store/recover", { opId: "op-commit-reset2", confirmation: RESET_CONFIRMATION })
    expect(other.body.error.code).toBe("RECOVERY_NOT_NEEDED")
  })

  test("a failure before the reset rename keeps the old file and no backup", async () => {
    env = makeEnv()
    mkdirSync(guardsDir(), { recursive: true })
    writeFileSync(storeFile(), "corrupt-original")
    const fs: FsPort = {
      ...nodeFs,
      async rename(from, to) {
        if (to.endsWith("store.json")) throw new Error("disk full")
        return nodeFs.rename(from, to)
      },
    }
    const r = await call(makeApp(env, { runtime: env.runtime({ fs }) }), "POST", "/store/recover", { opId: "op-commit-reset3", confirmation: RESET_CONFIRMATION })
    expect(r.body.error.code).toBe("STORE_UNAVAILABLE")
    expect(readFileSync(storeFile(), "utf8")).toBe("corrupt-original")
    expect(existsSync(guardsDir()) && backups()).toEqual([])
  })
})
