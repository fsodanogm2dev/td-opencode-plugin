import { describe, expect, test } from "bun:test"
import type { GuestRequest } from "@openchamber/sdk"

import { createGuardService, newOpId } from "../../panel/guards/service.ts"

const OP = "11111111-1111-4111-8111-111111111111"

const transport = (answer: { status: number; body: string } | Error) => {
  const calls: GuestRequest[] = []
  return {
    calls,
    service: createGuardService({
      serviceRequest: async (request) => {
        calls.push(request)
        if (answer instanceof Error) throw answer
        return answer
      },
    }),
  }
}

const hostError = (code: string) => Object.assign(new Error(code), { code })
const okBody = (data: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, data }) })

describe("guard service client", () => {
  test("operation IDs are UUID v4", () => {
    expect(newOpId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(newOpId()).not.toBe(newOpId())
  })

  test("state sends session and directory as query", async () => {
    const { calls, service } = transport(okBody({ revision: 2, guards: [], activations: [], runtime: null, lifecycle: [] }))
    const result = await service.state({ sessionId: "ses_1", directory: "/work/p" })
    expect(calls[0]).toEqual({ method: "GET", path: "/state", query: { sessionId: "ses_1", directory: "/work/p" } })
    expect(result).toEqual({ ok: true, data: { revision: 2, guards: [], activations: [], runtime: null, lifecycle: [], lifecycles: [] } })
  })

  test("mutations send the route contract with one opId", async () => {
    const { calls, service } = transport(okBody({ revision: 5 }))
    await service.activate(OP, { guardId: "g_1", sessionId: "ses_1", scope: "session" })
    await service.release(OP, "a/1")
    await service.deleteGuard(OP, "g_1")
    expect(calls[0]).toEqual({ method: "POST", path: "/activations", body: JSON.stringify({ opId: OP, guardId: "g_1", sessionId: "ses_1", scope: "session" }) })
    expect(JSON.parse(calls[0]!.body!)).not.toHaveProperty("expiresInMinutes")
    expect(calls[1]).toEqual({ method: "DELETE", path: "/activations/a%2F1", query: { opId: OP }, body: JSON.stringify({ opId: OP }) })
    expect(calls[2]).toEqual({ method: "DELETE", path: "/guards/g_1", query: { opId: OP }, body: JSON.stringify({ opId: OP }) })
  })

  test("state reads the service's runtime status and verified session", async () => {
    const { service } = transport(
      okBody({
        revision: 1,
        guards: [],
        activations: [],
        runtime: null,
        runtimeStatus: "stale",
        lifecycle: [],
        effective: { sessionId: "ses_c", rootSessionId: "ses_r", activationIds: ["a_1"] },
        bridge: "ok",
      }),
    )
    const result = await service.state({ sessionId: "ses_c", directory: null })
    expect(result).toMatchObject({
      ok: true,
      data: { runtimeStatus: "stale", bridge: "ok", effective: { sessionId: "ses_c", rootSessionId: "ses_r", activationIds: ["a_1"] } },
    })
  })

  test("lifecycle views are checked; invalid ones are dropped, never read as ended", async () => {
    const good = { activationId: "a_1", phase: "ended", releasable: true, conflict: false, trust: "ok", reason: "request-completed", instance: "i" }
    const { service } = transport(
      okBody({
        revision: 1,
        guards: [],
        activations: [],
        runtime: null,
        lifecycle: [],
        lifecycles: [
          good,
          { ...good, activationId: "a_2", phase: "bound", releasable: true },
          { ...good, activationId: "a_3", trust: "history-gap" },
          { ...good, activationId: "a_4", phase: "done" },
          "junk",
        ],
        lifecycleHistory: { truncated: true, malformedLines: 2, partialTail: false },
      }),
    )
    const result = await service.state({ sessionId: null, directory: null })
    if (!result.ok) throw new Error("expected ok")
    expect(result.data.lifecycles as unknown[]).toEqual([good])
    expect(result.data.lifecycleHistory).toEqual({ truncated: true, malformedLines: 2, partialTail: false })
  })

  test("store recovery sends the exact confirmation and returns the backup name", async () => {
    const { calls, service } = transport(okBody({ revision: 1, recovered: true, backup: "guards.corrupt.json" }))
    const result = await service.recoverStore(OP)
    expect(calls[0]).toEqual({ method: "POST", path: "/store/recover", body: JSON.stringify({ opId: OP, confirmation: "reset-global-guards" }) })
    expect(result).toEqual({ ok: true, data: { revision: 1, data: { revision: 1, recovered: true, backup: "guards.corrupt.json" } } })
  })

  test("409 and 503 are refusals with the service code", async () => {
    for (const [status, code] of [
      [409, "GUARD_NOT_FOUND"],
      [503, "LOCK_TIMEOUT"],
      [400, "INVALID_DRAFT"],
    ] as const) {
      const { service } = transport({ status, body: JSON.stringify({ ok: false, error: { code, message: "Refused." } }) })
      expect(await service.deleteGuard(OP, "g_1")).toEqual({ ok: false, failure: { kind: "rejected", status, code, message: "Refused." } })
    }
  })

  test("a lost answer is unclear, so the panel can retry with the same opId", async () => {
    const { service } = transport(hostError("REQUEST_FAILED"))
    expect(await service.release(OP, "a_1")).toMatchObject({ ok: false, failure: { kind: "unclear", code: "REQUEST_FAILED" } })
    const timeout = transport(hostError("HOST_TIMEOUT"))
    expect(await timeout.service.release(OP, "a_1")).toMatchObject({ ok: false, failure: { kind: "unclear" } })
  })

  test("OUTCOME_UNKNOWN is unclear, so the same opId is retried; other 503 codes stay refusals", async () => {
    const unknown = transport({ status: 503, body: JSON.stringify({ ok: false, error: { code: "OUTCOME_UNKNOWN", message: "The change may already be applied." } }) })
    expect(await unknown.service.release(OP, "a_1")).toEqual({
      ok: false,
      failure: { kind: "unclear", code: "OUTCOME_UNKNOWN", message: "The change may already be applied." },
    })
    expect(await unknown.service.recoverStore(OP)).toMatchObject({ ok: false, failure: { kind: "unclear", code: "OUTCOME_UNKNOWN" } })
    const refused = transport({ status: 503, body: JSON.stringify({ ok: false, error: { code: "STORE_UNAVAILABLE", message: "x" } }) })
    expect(await refused.service.release(OP, "a_1")).toMatchObject({ ok: false, failure: { kind: "rejected", status: 503 } })
  })

  test("host refusals are not unclear", async () => {
    const { service } = transport(hostError("NOT_GRANTED"))
    expect(await service.state({ sessionId: null, directory: null })).toMatchObject({ ok: false, failure: { kind: "host", code: "NOT_GRANTED" } })
  })

  test("an unreadable 2xx answer to a change is unclear", async () => {
    const { service } = transport({ status: 200, body: "<html>" })
    expect(await service.release(OP, "a_1")).toMatchObject({ ok: false, failure: { kind: "unclear" } })
  })
})
