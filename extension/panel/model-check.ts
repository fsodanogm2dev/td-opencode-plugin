/**
 * Asks this extension's local service for one model check: `POST /model-check` with body `{}`.
 * The service passes the request to the running plugin, which uses its own FueliX key.
 * The panel sends no key, no prompt, and no model input. It never retries on its own.
 */
import type { GuestRequest, GuestRequestResult } from "@openchamber/sdk"

import type { CheckRequestAnswer, CheckRequester, ManualCheckFailure } from "./controller.ts"

export type CheckTransport = { serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult> }

export const MODEL_CHECK_REQUEST: GuestRequest = { method: "POST", path: "/model-check", body: "{}" }

/** Host error codes after which the service may still have passed the check on. */
const UNCLEAR_CODES = new Set(["REQUEST_FAILED", "HOST_TIMEOUT", "HOST_UNAVAILABLE", "SERVICE_FAILED"])

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hostCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN"

const fail = (failure: ManualCheckFailure): CheckRequestAnswer => ({ ok: false, failure })

/** Reads one service answer: 202 `{ ok: true, data: { requestId, requestedAt } }`, or the usual error envelope. */
export const readCheckAnswer = (result: GuestRequestResult): CheckRequestAnswer => {
  const success = result.status >= 200 && result.status < 300
  let body: unknown
  try {
    body = JSON.parse(result.body)
  } catch {
    return success
      ? fail({ kind: "unclear", code: "BAD_ANSWER", message: "" })
      : fail({ kind: "rejected", code: `HTTP_${result.status}`, message: "" })
  }
  if (isRecord(body) && body.ok === false && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : `HTTP_${result.status}`
    const message = typeof body.error.message === "string" ? body.error.message : ""
    // MODEL_CHECK_REQUEST_FAILED is definite: the service did not pass the check on.
    const unclear = result.status >= 500 && result.status !== 503 && code !== "MODEL_CHECK_REQUEST_FAILED"
    return fail({ kind: unclear ? "unclear" : "rejected", code, message })
  }
  if (!success) return fail({ kind: "rejected", code: `HTTP_${result.status}`, message: "" })
  const data = isRecord(body) && body.ok === true && isRecord(body.data) ? body.data : null
  if (
    isRecord(data) &&
    typeof data.requestId === "string" &&
    REQUEST_ID.test(data.requestId) &&
    typeof data.requestedAt === "string" &&
    !Number.isNaN(Date.parse(data.requestedAt))
  ) {
    return { ok: true, requestId: data.requestId, requestedAt: data.requestedAt }
  }
  return fail({ kind: "unclear", code: "BAD_ANSWER", message: "" })
}

export const createCheckRequester =
  (transport: CheckTransport): CheckRequester =>
  async () => {
    let result: GuestRequestResult
    try {
      result = await transport.serviceRequest(MODEL_CHECK_REQUEST)
    } catch (error) {
      const code = hostCode(error)
      return fail({ kind: UNCLEAR_CODES.has(code) ? "unclear" : "host", code, message: "" })
    }
    return readCheckAnswer(result)
  }
