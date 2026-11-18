import { describe, expect, test } from "bun:test"

import { createCheckRequester, readCheckAnswer } from "../panel/model-check.ts"

const ID = "AbCdEfGhIjKlMnOpQrStUv"
const AT = "2026-11-12T15:00:00.000Z"
const hostError = (code: string) => Object.assign(new Error(code), { code })

describe("POST /model-check", () => {
  test("sends one POST with an empty JSON body and reads the 202 envelope", async () => {
    const calls: unknown[] = []
    const request = createCheckRequester({
      serviceRequest: async (call) => {
        calls.push(call)
        return { status: 202, body: JSON.stringify({ ok: true, data: { requestId: ID, requestedAt: AT } }) }
      },
    })
    expect(await request()).toEqual({ ok: true, requestId: ID, requestedAt: AT })
    expect(calls).toEqual([{ method: "POST", path: "/model-check", body: "{}" }])
  })

  test("MODEL_CHECK_REQUEST_FAILED (500) is a definite failure with the service text", () => {
    const answer = readCheckAnswer({
      status: 500,
      body: JSON.stringify({ ok: false, error: { code: "MODEL_CHECK_REQUEST_FAILED", message: "Fixed text." } }),
    })
    expect(answer).toEqual({ ok: false, failure: { kind: "rejected", code: "MODEL_CHECK_REQUEST_FAILED", message: "Fixed text." } })
  })

  test("other error envelopes keep their code", () => {
    const unauthorized = readCheckAnswer({ status: 401, body: JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "" } }) })
    expect(unauthorized.ok === false && unauthorized.failure).toMatchObject({ kind: "rejected", code: "UNAUTHORIZED" })
    const internal = readCheckAnswer({ status: 500, body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "" } }) })
    expect(internal.ok === false && internal.failure.kind).toBe("unclear")
  })

  test("a 2xx without a valid requestId is not a success", () => {
    for (const body of [
      JSON.stringify({ ok: true, data: { requestId: "<bad id>", requestedAt: AT } }),
      JSON.stringify({ requestId: ID, requestedAt: AT }),
      "not json",
    ]) {
      const answer = readCheckAnswer({ status: 202, body })
      expect(answer.ok === false && answer.failure).toMatchObject({ kind: "unclear", code: "BAD_ANSWER" })
    }
  })

  test("host errors: refusals are host failures, lost answers are unclear", async () => {
    const answer = async (code: string) =>
      createCheckRequester({
        serviceRequest: async () => {
          throw hostError(code)
        },
      })()
    expect(await answer("NO_SERVICE")).toEqual({ ok: false, failure: { kind: "host", code: "NO_SERVICE", message: "" } })
    expect(await answer("HOST_TIMEOUT")).toEqual({ ok: false, failure: { kind: "unclear", code: "HOST_TIMEOUT", message: "" } })
  })
})
