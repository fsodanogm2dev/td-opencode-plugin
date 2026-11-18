import { describe, expect, test } from "bun:test"

import { createController, type CheckRequestAnswer, type ManualCheckState, type PanelState } from "../panel/controller.ts"
import type { LastCheck } from "../panel/report.ts"
import { json, NOW, OTHER_PROJECT, PROJECT, scenarios, withReport } from "./support/fixtures.ts"

type Pending = { path: string; resolve: (content: string) => void; reject: (error: unknown) => void }

const setup = () => {
  const pending: Pending[] = []
  const states: PanelState[] = []
  const controller = createController({
    reader: {
      readFile: (path) =>
        new Promise((resolve, reject) => {
          pending.push({ path, resolve: (content) => resolve({ content }), reject })
        }),
    },
    reportPath: async (directory) => `path:${directory}`,
    onChange: (state) => states.push(state),
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { controller, pending, states, flush }
}

const hostError = (code: string) => Object.assign(new Error(code), { code })

describe("controller", () => {
  test("reads the current location's report", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    expect(pending[0]?.path).toBe(`path:${PROJECT}`)
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(controller.state().kind).toBe("report")
  })

  test("discards a slower answer for a location the user left", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    controller.setDirectory(OTHER_PROJECT)
    await flush()
    pending[1]!.resolve(json(withReport({}, OTHER_PROJECT)))
    await flush()
    pending[0]!.resolve(json(scenarios.added))
    await flush()
    const state = controller.state()
    expect(state.kind === "report" && state.directory).toBe(OTHER_PROJECT)
  })

  test("a repeated snapshot for the same location does not read again", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    controller.setDirectory(PROJECT)
    await flush()
    expect(pending).toHaveLength(1)
  })

  test("NOT_FOUND means no report", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.reject(hostError("NOT_FOUND"))
    await flush()
    expect(controller.state().kind).toBe("missing")
  })

  test("missing permission is an error state", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.reject(hostError("NOT_GRANTED"))
    await flush()
    const state = controller.state()
    expect(state.kind === "error" && state.code).toBe("NOT_GRANTED")
  })

  test("a report that names another location is not shown", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(withReport({}, OTHER_PROJECT)))
    await flush()
    const state = controller.state()
    expect(state.kind === "invalid" && state.problem).toBe("other-location")
  })

  test("a failed reload keeps the copy on screen and says so", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    controller.reload()
    expect(controller.state().kind === "report" && (controller.state() as { reloading: boolean }).reloading).toBe(true)
    await flush()
    pending[1]!.reject(hostError("HOST_TIMEOUT"))
    await flush()
    const state = controller.state()
    expect(state.kind).toBe("report")
    expect(state.kind === "report" && state.reloadError).toBe("HOST_TIMEOUT")
    expect(state.kind === "report" && state.reloading).toBe(false)
  })

  test("a quiet poll with the same content does not repaint", async () => {
    const { controller, pending, states, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    const before = states.length
    controller.reload({ quiet: true })
    await flush()
    pending[1]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(states.length).toBe(before)
  })

  test("checkNow does nothing without a checker", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    expect(controller.canCheck()).toBe(false)
    controller.checkNow()
    await flush()
    expect(controller.check().kind).toBe("idle")
    expect(pending).toHaveLength(1)
  })

  test("nothing changes after dispose", async () => {
    const { controller, pending, states, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    controller.dispose()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(states.at(-1)?.kind).toBe("loading")
    controller.setDirectory(OTHER_PROJECT)
    await flush()
    expect(pending).toHaveLength(1)
  })
})

type RequestCall = { resolve: (answer: CheckRequestAnswer) => void; reject: (error: unknown) => void }

const REQUEST_ID = "AAAAAAAAAAAAAAAAAAAAAA"
const OTHER_ID = "BBBBBBBBBBBBBBBBBBBBBB"

/** Manual timers and clock: `advance` runs due timers in order. */
const fakeTime = () => {
  let now = NOW
  let next = 1
  const due = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => now,
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++
        due.set(id, { at: now + ms, run })
        return id
      },
      clearTimeout: (handle: unknown) => {
        due.delete(handle as number)
      },
    },
    pending: () => due.size,
    advance: (ms: number) => {
      now += ms
      for (const [id, timer] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue
        due.delete(id)
        timer.run()
      }
    },
  }
}

const setupCheck = () => {
  const pending: Pending[] = []
  const calls: RequestCall[] = []
  const checks: ManualCheckState[] = []
  const time = fakeTime()
  const controller = createController({
    reader: {
      readFile: (path) =>
        new Promise((resolve, reject) => {
          pending.push({ path, resolve: (content) => resolve({ content }), reject })
        }),
    },
    reportPath: async (directory) => `path:${directory}`,
    onChange: () => {},
    requestCheck: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
    onCheckChange: (check) => checks.push(check),
    checkPollMs: 1_500,
    checkTimeoutMs: 45_000,
    now: time.now,
    timers: time.timers,
  })
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
  }
  const open = async () => {
    controller.setDirectory(PROJECT)
    await flush()
    pending.at(-1)!.resolve(json(scenarios.unchanged))
    await flush()
  }
  const accept = async (requestId = REQUEST_ID) => {
    calls.at(-1)!.resolve({ ok: true, requestId, requestedAt: new Date(time.now()).toISOString() })
    await flush()
  }
  return { controller, pending, calls, checks, time, flush, open, accept }
}

/** `checking: true` means the named request is running and the other lastCheck fields are the previous result. */
const reportFor = (requestId: string | null, outcome: LastCheck["outcome"], patch: Partial<LastCheck> = {}, checking = false) =>
  json(withReport({ checking, lastCheck: { outcome, trigger: "manual", requestId, ...patch } }))

describe("manual model check", () => {
  test("never runs on its own: not on open, not on a reload, not on a poll", async () => {
    const { controller, calls, time, flush, open } = setupCheck()
    await open()
    controller.reload()
    controller.reload({ quiet: true })
    time.advance(60_000)
    await flush()
    expect(calls).toHaveLength(0)
    expect(controller.check().kind).toBe("idle")
  })

  test("one click sends one request; a double click and clicks in flight send nothing more", async () => {
    const { controller, calls, checks, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    controller.checkNow()
    await flush()
    expect(calls).toHaveLength(1)
    await accept()
    controller.checkNow()
    await flush()
    expect(calls).toHaveLength(1)
    expect(checks.map((c) => c.kind)).toEqual(["requested", "requested"])
    const check = controller.check()
    expect(check.kind === "requested" && check.requestId).toBe(REQUEST_ID)
  })

  test("polls the saved report: running, then done for the matching request", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    expect(pending).toHaveLength(1)
    time.advance(1_500)
    await flush()
    expect(pending).toHaveLength(2)
    // The previous result is "unchanged"; it must not count as this check's answer.
    pending[1]!.resolve(reportFor(REQUEST_ID, "unchanged", {}, true))
    await flush()
    expect(controller.check().kind).toBe("running")
    time.advance(1_500)
    await flush()
    pending[2]!.resolve(reportFor(REQUEST_ID, "failed", { reason: "FueliX returned HTTP 503" }))
    await flush()
    const check = controller.check()
    expect(check.kind).toBe("done")
    expect(check.kind === "done" && check.check.reason).toBe("FueliX returned HTTP 503")
    // Polling stops after the result.
    time.advance(10_000)
    await flush()
    expect(pending).toHaveLength(3)
    expect(time.pending()).toBe(0)
  })

  test("ignores reports for another request", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    time.advance(1_500)
    await flush()
    pending[1]!.resolve(reportFor(OTHER_ID, "updated"))
    await flush()
    time.advance(1_500)
    await flush()
    pending[2]!.resolve(reportFor(null, "unchanged", { trigger: "automatic" }))
    await flush()
    expect(controller.check().kind).toBe("requested")
    // The newer report still shows: last known models and history stay current.
    const state = controller.state()
    expect(state.kind === "report" && state.report.lastCheck?.trigger).toBe("automatic")
  })

  test("times out after 45 s without a matching report", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    for (let i = 0; i < 30; i++) {
      time.advance(1_500)
      await flush()
      pending.at(-1)!.resolve(json(scenarios.unchanged))
      await flush()
    }
    const check = controller.check()
    expect(check.kind).toBe("timeout")
    expect(check.kind === "timeout" && check.requestId).toBe(REQUEST_ID)
    expect(time.pending()).toBe(0)
    expect(controller.state().kind).toBe("report")
  })

  test("an old report without the new fields never matches, and is still read", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    time.advance(1_500)
    await flush()
    pending[1]!.resolve(json(scenarios.added))
    await flush()
    expect(controller.check().kind).toBe("requested")
    const state = controller.state()
    expect(state.kind === "report" && state.report.lastCheck?.requestId).toBeUndefined()
  })

  test("a request error is a failure with its code; no polling starts", async () => {
    const { controller, pending, calls, time, flush, open } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    calls[0]!.resolve({ ok: false, failure: { kind: "rejected", code: "MODEL_CHECK_REQUEST_FAILED", message: "Fixed text." } })
    await flush()
    const check = controller.check()
    expect(check.kind === "failed" && check.failure.code).toBe("MODEL_CHECK_REQUEST_FAILED")
    expect(check.kind === "failed" && check.at).toBe(new Date(NOW).toISOString())
    time.advance(5_000)
    await flush()
    expect(pending).toHaveLength(1)
    // The user can try again.
    controller.checkNow()
    expect(calls).toHaveLength(2)
  })

  test("a thrown request is an unclear failure, not a success", async () => {
    const { controller, calls, flush, open } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    calls[0]!.reject(hostError("HOST_TIMEOUT"))
    await flush()
    const check = controller.check()
    expect(check.kind === "failed" && check.failure).toEqual({ kind: "unclear", code: "HOST_TIMEOUT", message: "" })
  })

  test("a failed read while polling keeps the report and adds no banner", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    time.advance(1_500)
    await flush()
    pending[1]!.reject(hostError("HOST_TIMEOUT"))
    await flush()
    const state = controller.state()
    expect(state.kind === "report" && state.reloadError).toBe(null)
    expect(controller.check().kind).toBe("requested")
  })

  test("switching location cancels the check and its polling", async () => {
    const { controller, pending, time, flush, open, accept } = setupCheck()
    await open()
    controller.checkNow()
    await flush()
    await accept()
    controller.setDirectory(OTHER_PROJECT)
    expect(controller.check().kind).toBe("idle")
    expect(time.pending()).toBe(0)
    await flush()
    expect(pending).toHaveLength(2)
  })

  test("no check before OpenChamber gives a location", async () => {
    const { controller, calls } = setupCheck()
    expect(controller.canCheck()).toBe(false)
    controller.checkNow()
    expect(calls).toHaveLength(0)
  })
})
