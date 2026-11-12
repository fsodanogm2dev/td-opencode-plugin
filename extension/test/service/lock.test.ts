import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { acquireLock, releaseLock, withLock } from "../../service/lock.ts"
import { ApiError } from "../../service/contract.ts"
import { call, goodDraft, makeApp, makeEnv, opId, type Env } from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

function lockPath(): string {
  return join(env.root, "store.lock")
}

function owner(file: string): { pid: number; token: string } {
  return JSON.parse(readFileSync(file, "utf8"))
}

function plantLock(pid: number, token: string, startToken: string | null = `start-${pid}`) {
  writeFileSync(lockPath(), JSON.stringify({ pid, token, startToken, acquiredAt: "2026-11-12T09:00:00.000Z" }))
}

describe("lock", () => {
  test("acquires, records the owner, and releases", async () => {
    env = makeEnv()
    const runtime = env.runtime()
    const lock = await acquireLock({ runtime, path: lockPath() })
    expect(owner(lockPath()).pid).toBe(4242)
    expect(readdirSync(env.root).filter((n) => n.includes(".new-"))).toEqual([])
    await releaseLock(runtime, lockPath(), lock)
    expect(existsSync(lockPath())).toBe(false)
  })

  test("a live owner is never stolen and the waiter fails with LOCK_TIMEOUT", async () => {
    env = makeEnv()
    env.procs.alive.add(9001)
    plantLock(9001, "live-owner")
    const error = await acquireLock({ runtime: env.runtime(), path: lockPath(), timeoutMs: 300 }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe("LOCK_TIMEOUT")
    expect(error.status).toBe(503)
    expect(owner(lockPath()).token).toBe("live-owner")
  })

  test("a lock file without an owner record is never reclaimed or replaced", async () => {
    env = makeEnv()
    writeFileSync(lockPath(), "")
    const error = await acquireLock({ runtime: env.runtime(), path: lockPath(), timeoutMs: 200 }).catch((e) => e)
    expect(error.code).toBe("LOCK_TIMEOUT")
    expect(existsSync(lockPath())).toBe(true)
  })

  test("an unreadable owner record is treated as incomplete, not dead", async () => {
    env = makeEnv()
    writeFileSync(lockPath(), "{ not json")
    const error = await acquireLock({ runtime: env.runtime(), path: lockPath(), timeoutMs: 200 }).catch((e) => e)
    expect(error.code).toBe("LOCK_TIMEOUT")
  })

  test("a dead owner is reclaimed", async () => {
    env = makeEnv()
    plantLock(7777, "dead-owner")
    const lock = await acquireLock({ runtime: env.runtime(), path: lockPath() })
    expect(owner(lockPath()).token).toBe(lock.owner.token)
    expect(readdirSync(env.root).filter((n) => n.includes(".dead-") || n.endsWith(".reclaim"))).toEqual([])
  })

  test("a reused pid with another start time counts as dead", async () => {
    env = makeEnv()
    env.procs.alive.add(5555)
    env.procs.tokens.set(5555, "start-of-the-new-process")
    plantLock(5555, "old-owner", "start-of-the-old-process")
    const lock = await acquireLock({ runtime: env.runtime(), path: lockPath() })
    expect(owner(lockPath()).token).toBe(lock.owner.token)
  })

  test("same pid and same start time stays alive", async () => {
    env = makeEnv()
    env.procs.alive.add(5555)
    env.procs.tokens.set(5555, "same")
    plantLock(5555, "owner", "same")
    const error = await acquireLock({ runtime: env.runtime(), path: lockPath(), timeoutMs: 100 }).catch((e) => e)
    expect(error.code).toBe("LOCK_TIMEOUT")
  })

  test("reclaim does not remove a lock that a new owner took while the old one was judged dead", async () => {
    env = makeEnv()
    plantLock(7777, "dead-owner")
    const runtime = env.runtime()
    let swapped = false
    const original = env.procs.isAlive.bind(env.procs)
    // This waiter judges the old owner dead. Before its reclaim step, another process reclaimed and took the lock.
    env.procs.isAlive = (pid: number) => {
      if (pid === 7777 && !swapped) {
        swapped = true
        renameSync(lockPath(), join(env.root, "gone"))
        plantLock(8888, "new-live-owner")
        env.procs.alive.add(8888)
        env.procs.tokens.set(8888, "start-8888")
        return false
      }
      return original(pid)
    }
    const error = await acquireLock({ runtime, path: lockPath(), timeoutMs: 100 }).catch((e) => e)
    expect(swapped).toBe(true)
    expect(error.code).toBe("LOCK_TIMEOUT")
    expect(owner(lockPath()).token).toBe("new-live-owner")
  })

  test("a dead reclaimer's guard is cleared and the lock is then reclaimed", async () => {
    env = makeEnv()
    plantLock(7777, "dead-owner")
    const guard = `${lockPath()}.reclaim`
    writeFileSync(guard, JSON.stringify({ pid: 6666, token: "dead-reclaimer", startToken: null, acquiredAt: "x" }))
    const lock = await acquireLock({ runtime: env.runtime(), path: lockPath() })
    expect(owner(lockPath()).token).toBe(lock.owner.token)
    expect(existsSync(guard)).toBe(false)
  })

  test("assertHeld fails with LOCK_LOST when the owner changed", async () => {
    env = makeEnv()
    const lock = await acquireLock({ runtime: env.runtime(), path: lockPath() })
    writeFileSync(lockPath(), JSON.stringify({ pid: 1, token: "other", startToken: null, acquiredAt: "x" }))
    const error = await lock.assertHeld().catch((e) => e)
    expect(error.code).toBe("LOCK_LOST")
  })

  test("release leaves a lock that another owner holds", async () => {
    env = makeEnv()
    const runtime = env.runtime()
    const lock = await acquireLock({ runtime, path: lockPath() })
    writeFileSync(lockPath(), JSON.stringify({ pid: 1, token: "other", startToken: null, acquiredAt: "x" }))
    await releaseLock(runtime, lockPath(), lock)
    expect(owner(lockPath()).token).toBe("other")
  })

  test("withLock releases when the callback throws", async () => {
    env = makeEnv()
    await withLock({ runtime: env.runtime(), path: lockPath() }, async () => {
      throw new Error("boom")
    }).catch(() => undefined)
    expect(existsSync(lockPath())).toBe(false)
  })

  test("two contenders in one process take the lock one after the other", async () => {
    env = makeEnv()
    const runtime = env.runtime({ sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    let inside = 0
    let max = 0
    const run = () =>
      withLock({ runtime, path: lockPath(), timeoutMs: 5000 }, async () => {
        inside++
        max = Math.max(max, inside)
        await new Promise((r) => setTimeout(r, 10))
        inside--
      })
    await Promise.all([run(), run(), run(), run()])
    expect(max).toBe(1)
  })

  test("a dead main owner with a live reclaimer times out within the deadline and steals nothing", async () => {
    env = makeEnv()
    env.procs.alive.add(9001)
    plantLock(7777, "dead-owner")
    const guard = `${lockPath()}.reclaim`
    writeFileSync(guard, JSON.stringify({ pid: 9001, token: "live-reclaimer", startToken: "start-9001", acquiredAt: "x" }))
    env.procs.tokens.set(9001, "start-9001")
    const mainBefore = readFileSync(lockPath(), "utf8")
    // A runaway loop fails the test instead of hanging it.
    let steps = 0
    const base = env.runtime()
    const runtime = {
      ...base,
      fs: {
        ...base.fs,
        async link(from: string, to: string) {
          if (++steps > 1000) throw new Error("lock loop did not stop")
          return base.fs.link(from, to)
        },
      },
    }
    const started = env.clock.now()
    const error = await acquireLock({ runtime, path: lockPath(), timeoutMs: 2000, pollMs: 15 }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.code).toBe("LOCK_TIMEOUT")
    expect(error.status).toBe(503)
    expect(env.clock.now() - started).toBeLessThanOrEqual(2000 + 15)
    // Two link attempts per 15 ms poll (main lock and reclaim guard).
    expect(steps).toBeLessThanOrEqual(2 * Math.ceil(2000 / 15) + 4)
    expect(readFileSync(lockPath(), "utf8")).toBe(mainBefore)
    expect(owner(guard).token).toBe("live-reclaimer")
    expect(readdirSync(env.root).sort()).toEqual(["store.lock", "store.lock.reclaim"])
  })

  test("the same state through a mutation answers 503 LOCK_TIMEOUT and writes no store", async () => {
    env = makeEnv()
    env.procs.alive.add(9001)
    env.procs.tokens.set(9001, "start-9001")
    const guardsDir = join(env.root, "guards")
    mkdirSync(guardsDir, { recursive: true })
    writeFileSync(join(guardsDir, "store.lock"), JSON.stringify({ pid: 7777, token: "dead-owner", startToken: null, acquiredAt: "x" }))
    writeFileSync(join(guardsDir, "store.lock.reclaim"), JSON.stringify({ pid: 9001, token: "live-reclaimer", startToken: "start-9001", acquiredAt: "x" }))
    const app = makeApp(env, { lockTimeoutMs: 2000 })
    const response = await call(app, "POST", "/guards", { opId: opId(), draft: goodDraft })
    expect(response.status).toBe(503)
    expect(response.body.error.code).toBe("LOCK_TIMEOUT")
    expect(readdirSync(guardsDir).sort()).toEqual(["store.lock", "store.lock.reclaim"])
  })
})
