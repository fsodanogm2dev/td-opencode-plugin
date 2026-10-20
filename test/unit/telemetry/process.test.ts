import { describe, expect, test } from "bun:test"
import { defaultRun } from "../../../src/telemetry/process.ts"
import { delay } from "../../../src/telemetry/index.ts"
import { createFakeTimers, sleep } from "./helpers.ts"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("defaultRun", () => {
  test("runs a command and reports its output", async () => {
    const result = await defaultRun("/bin/sh", ["-c", "echo hi"], { timeoutMs: 5000 })
    expect(result).toMatchObject({ code: 0, stdout: "hi\n", timedOut: false })
  })

  test("a missing executable reports an error and does not throw", async () => {
    const result = await defaultRun("/nonexistent/binary", [], { timeoutMs: 5000 })
    expect(result.code).toBeNull()
    expect(result.error).toBeDefined()
  })

  test("a detached run kills the whole process group on timeout", async () => {
    // The shell starts a background sleep and prints its PID, then waits.
    const result = await defaultRun("/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { timeoutMs: 400, detached: true })
    expect(result.timedOut).toBe(true)
    const grandchild = Number(result.stdout.trim())
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true)
    try {
      await sleep(200)
      expect(alive(grandchild)).toBe(false)
    } finally {
      try {
        process.kill(grandchild, "SIGKILL")
      } catch {
        // Already dead.
      }
    }
  })
})

describe("delay", () => {
  function trackedSignal() {
    const controller = new AbortController()
    let listeners = 0
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((type: string, listener: any, options?: any) => {
      listeners += 1
      add(type, listener, options)
    }) as never
    controller.signal.removeEventListener = ((type: string, listener: any, options?: any) => {
      listeners -= 1
      remove(type, listener, options)
    }) as never
    return { controller, listeners: () => listeners }
  }

  test("removes its abort listener when the timer fires", async () => {
    const timers = createFakeTimers()
    const { controller, listeners } = trackedSignal()
    const done = delay(1000, timers, controller.signal)
    expect(listeners()).toBe(1)
    timers.fire(0)
    await done
    expect(listeners()).toBe(0)
    expect(timers.active()).toEqual([])
  })

  test("clears its timer when the signal aborts", async () => {
    const timers = createFakeTimers()
    const { controller } = trackedSignal()
    const done = delay(1000, timers, controller.signal)
    controller.abort()
    await done
    expect(timers.active()).toEqual([])
  })

  test("a repeated delay on one signal does not accumulate listeners", async () => {
    const timers = createFakeTimers()
    const { controller, listeners } = trackedSignal()
    for (let index = 0; index < 50; index++) {
      const done = delay(10, timers, controller.signal)
      timers.fire(0)
      await done
    }
    expect(listeners()).toBe(0)
  })

  test("resolves at once for a signal that is already aborted", async () => {
    const timers = createFakeTimers()
    const controller = new AbortController()
    controller.abort()
    await delay(1000, timers, controller.signal)
    expect(timers.active()).toEqual([])
  })
})
