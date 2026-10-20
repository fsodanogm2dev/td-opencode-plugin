import { describe, expect, test } from "bun:test"
import { applyAuth } from "../../../src/fuelix/auth.ts"

describe("applyAuth", () => {
  test("moves x-api-key to a Bearer header", () => {
    const headers = new Headers({ "x-api-key": "sk-test-not-a-real-key" })
    expect(applyAuth(headers, {})).toBe(true)
    expect(headers.get("authorization")).toBe("Bearer sk-test-not-a-real-key")
    expect(headers.has("x-api-key")).toBe(false)
  })

  test("override wins over the existing key", () => {
    const headers = new Headers({ authorization: "Bearer sk-test-existing", "x-api-key": "sk-test-other" })
    applyAuth(headers, { override: "sk-test-override", fallback: "sk-test-fallback" })
    expect(headers.get("authorization")).toBe("Bearer sk-test-override")
    expect(headers.has("x-api-key")).toBe(false)
  })

  test("existing Bearer token beats the fallback", () => {
    const headers = new Headers({ authorization: "Bearer sk-test-existing" })
    applyAuth(headers, { fallback: "sk-test-fallback" })
    expect(headers.get("authorization")).toBe("Bearer sk-test-existing")
  })

  test("existing x-api-key beats the fallback", () => {
    const headers = new Headers({ "x-api-key": "sk-test-existing" })
    applyAuth(headers, { fallback: "sk-test-fallback" })
    expect(headers.get("authorization")).toBe("Bearer sk-test-existing")
  })

  test("fallback applies when the request has no key", () => {
    const headers = new Headers()
    expect(applyAuth(headers, { fallback: "sk-test-fallback" })).toBe(true)
    expect(headers.get("authorization")).toBe("Bearer sk-test-fallback")
  })

  test("changes nothing without a key", () => {
    const headers = new Headers({ accept: "application/json" })
    expect(applyAuth(headers, {})).toBe(false)
    expect(headers.has("authorization")).toBe(false)
    expect(headers.get("accept")).toBe("application/json")
  })
})
