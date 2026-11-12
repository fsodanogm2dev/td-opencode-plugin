import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createApp } from "../../service/app.ts"
import { backendSchema } from "../../service/backend-port.ts"
import { nodeRuntime } from "../../service/ports.ts"
import { goodDraft } from "./support/harness.ts"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const worker = join(import.meta.dir, "support", "worker.ts")
let root = ""
afterEach(() => root && rmSync(root, { recursive: true, force: true }))

function fresh(): string {
  root = mkdtempSync(join(tmpdir(), "td-guards-xproc-"))
  return root
}

function spawn(...args: string[]) {
  return Bun.spawn([process.execPath, worker, ...args], { stdout: "pipe", stderr: "pipe" })
}

function liveApp() {
  return createApp({ runtime: nodeRuntime(), schema: backendSchema, root, token: "t", bridge: null, lockTimeoutMs: 10_000 })
}

const headers = { authorization: "Bearer t" }
// The same draft the worker sends.
const workerDraft = { ...goodDraft, message: "Blocked by a guard.", label: "crash" }
const store = () => JSON.parse(readFileSync(join(root, "guards", "store.json"), "utf8"))

describe("cross-process", () => {
  test("separate service processes lose no guard under concurrent mutations", async () => {
    fresh()
    const workers = ["a", "b", "c", "d"].map((prefix) => spawn("create", root, prefix, "15"))
    const outputs = await Promise.all(
      workers.map(async (w) => {
        const code = await w.exited
        return { code, out: await new Response(w.stdout).text(), err: await new Response(w.stderr).text() }
      }),
    )
    for (const o of outputs) {
      expect(o.err).toBe("")
      expect(o.code).toBe(0)
      expect(JSON.parse(o.out)).toEqual({ ok: 15 })
    }
    const doc = store()
    expect(doc.guards).toHaveLength(60)
    expect(doc.revision).toBe(60)
    expect(new Set(doc.guards.map((g: any) => g.label)).size).toBe(60)
    expect(new Set(doc.guards.map((g: any) => g.id)).size).toBe(60)
    expect(readdirSync(join(root, "guards")).sort()).toEqual(["store.json"])
  }, 60_000)

  test("a process killed before the rename leaves the store intact and the retry succeeds once", async () => {
    fresh()
    const first = await liveApp().handle({ method: "POST", url: "/guards", headers, body: JSON.stringify({ opId: "op-before-seed", draft: goodDraft }) })
    expect(first.status).toBe(200)
    const before = readFileSync(join(root, "guards", "store.json"), "utf8")

    const child = spawn("crash-before-rename", root, "op-crash-before")
    expect(await child.exited).not.toBe(0)
    expect(child.signalCode).toBe("SIGKILL")
    expect(readFileSync(join(root, "guards", "store.json"), "utf8")).toBe(before)
    // The dead writer left its lock and temp file behind.
    const left = readdirSync(join(root, "guards"))
    expect(left).toContain("store.lock")
    expect(left.some((n) => n.startsWith("store.json.tmp-"))).toBe(true)

    const body = JSON.stringify({ opId: "op-crash-before", draft: workerDraft })
    const retry = await liveApp().handle({ method: "POST", url: "/guards", headers, body })
    expect(retry.status).toBe(200)
    expect((retry.body as any).data.replayed).toBeUndefined()
    expect(readdirSync(join(root, "guards")).sort()).toEqual(["store.json"])
    const again = await liveApp().handle({ method: "POST", url: "/guards", headers, body })
    expect((again.body as any).data.replayed).toBe(true)
    expect(store().guards.map((g: any) => g.label)).toEqual([goodDraft.label, "crash"])
  }, 30_000)

  test("a process killed after the rename committed: the retry replays instead of duplicating", async () => {
    fresh()
    const child = spawn("crash-after-rename", root, "op-crash-after")
    await child.exited
    expect(child.signalCode).toBe("SIGKILL")
    expect(store().guards).toHaveLength(1)
    const retry = await liveApp().handle({
      method: "POST",
      url: "/guards",
      headers,
      body: JSON.stringify({ opId: "op-crash-after", draft: workerDraft }),
    })
    expect(retry.status).toBe(200)
    expect((retry.body as any).data.replayed).toBe(true)
    expect(store().guards).toHaveLength(1)
    expect(readdirSync(join(root, "guards")).sort()).toEqual(["store.json"])
  }, 30_000)

  test("a killed lock holder is reclaimed; a live holder blocks with LOCK_TIMEOUT", async () => {
    fresh()
    mkdirSync(join(root, "guards"), { recursive: true })
    const holder = spawn("hold-lock", root)
    const reader = holder.stdout.getReader()
    await reader.read()
    expect(existsSync(join(root, "guards", "store.lock"))).toBe(true)

    const impatient = createApp({ runtime: nodeRuntime(), schema: backendSchema, root, token: "t", bridge: null, lockTimeoutMs: 300 })
    const blocked = await impatient.handle({ method: "POST", url: "/guards", headers, body: JSON.stringify({ opId: "op-blocked-01", draft: goodDraft }) })
    expect(blocked.status).toBe(503)
    expect((blocked.body as any).error.code).toBe("LOCK_TIMEOUT")
    expect(existsSync(join(root, "guards", "store.json"))).toBe(false)

    holder.kill("SIGKILL")
    await holder.exited
    const done = await liveApp().handle({ method: "POST", url: "/guards", headers, body: JSON.stringify({ opId: "op-blocked-01", draft: goodDraft }) })
    expect(done.status).toBe(200)
    expect(store().guards).toHaveLength(1)
  }, 30_000)
})
