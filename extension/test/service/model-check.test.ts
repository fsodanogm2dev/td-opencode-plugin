import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { parseManualCheckRequest } from "../../../src/fuelix/manual-check.ts"
import { createApp } from "../../service/app.ts"
import { backendSchema } from "../../service/backend-port.ts"
import { ApiError } from "../../service/contract.ts"
import { nodeFs } from "../../service/ports.ts"
import { FakeBridge, TOKEN, call, makeApp, makeEnv, type Env } from "./support/harness.ts"

let env: Env
afterEach(() => env?.cleanup())

const requestsDir = () => join(env.root, "requests")
const requestFile = () => join(requestsDir(), "model-check.json")

describe("POST /model-check", () => {
  test("writes the request file and answers 202 with the same ID and time", async () => {
    env = makeEnv()
    const response = await call(makeApp(env), "POST", "/model-check")
    expect(response.status).toBe(202)
    expect(response.body.ok).toBe(true)
    const { requestId, requestedAt } = response.body.data
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(requestedAt).toBe("2026-11-12T10:00:00.000Z")
    expect(Object.keys(response.body.data).sort()).toEqual(["requestId", "requestedAt"])
    const text = readFileSync(requestFile(), "utf8")
    expect(JSON.parse(text)).toEqual({ version: 1, requestId, requestedAt })
    expect(Object.keys(JSON.parse(text))).toEqual(["version", "requestId", "requestedAt"])
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024)
    // The plugin parser accepts exactly what the service writes.
    expect(parseManualCheckRequest(text)).toEqual({ requestId, requestedAt })
  })

  test("the file has mode 0600, the directory 0700, and no temporary file stays", async () => {
    env = makeEnv()
    await call(makeApp(env), "POST", "/model-check")
    expect(statSync(requestFile()).mode & 0o777).toBe(0o600)
    expect(statSync(requestsDir()).mode & 0o777).toBe(0o700)
    expect(readdirSync(requestsDir())).toEqual(["model-check.json"])
  })

  test("a second request replaces the file with a new ID", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const first = await call(app, "POST", "/model-check")
    env.clock.advance(5000)
    const second = await call(app, "POST", "/model-check", {})
    expect(second.status).toBe(202)
    expect(second.body.data.requestId).not.toBe(first.body.data.requestId)
    expect(JSON.parse(readFileSync(requestFile(), "utf8"))).toMatchObject({
      requestId: second.body.data.requestId,
      requestedAt: "2026-11-12T10:00:05.000Z",
    })
    expect(readdirSync(requestsDir())).toEqual(["model-check.json"])
  })

  test("accepts an empty body, a blank body, and {}", async () => {
    env = makeEnv()
    const app = makeApp(env)
    expect((await call(app, "POST", "/model-check")).status).toBe(202)
    expect((await call(app, "POST", "/model-check", "")).status).toBe(202)
    expect((await call(app, "POST", "/model-check", "  \n")).status).toBe(202)
    expect((await call(app, "POST", "/model-check", {})).status).toBe(202)
  })

  test("rejects other keys, non-objects, bad JSON, and a large body, and writes nothing", async () => {
    env = makeEnv()
    const app = makeApp(env)
    const invalid = await call(app, "POST", "/model-check", { extra: 1 })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/model-check", [])).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/model-check", "null")).body.error.code).toBe("INVALID_REQUEST")
    expect((await call(app, "POST", "/model-check", "{")).body.error.code).toBe("INVALID_JSON")
    const large = await call(app, "POST", "/model-check", JSON.stringify({ pad: "x".repeat(70 * 1024) }))
    expect(large.status).toBe(413)
    expect(existsSync(requestsDir())).toBe(false)
  })

  test("rejects other methods", async () => {
    env = makeEnv()
    const app = makeApp(env)
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await call(app, method, "/model-check")
      expect(response.status).toBe(405)
      expect(response.body.error.code).toBe("METHOD_NOT_ALLOWED")
    }
    expect(existsSync(requestsDir())).toBe(false)
  })

  test("needs the bearer token", async () => {
    env = makeEnv()
    const app = makeApp(env)
    expect((await call(app, "POST", "/model-check", undefined, {})).status).toBe(401)
    expect((await call(app, "POST", "/model-check", undefined, { authorization: "Bearer wrong" })).status).toBe(401)
    expect(existsSync(requestsDir())).toBe(false)
  })

  test("a write failure answers MODEL_CHECK_REQUEST_FAILED with status 500 and leaves no temporary file", async () => {
    env = makeEnv()
    const logged: string[] = []
    const app = createApp({
      runtime: env.runtime({
        fs: {
          ...nodeFs,
          async rename() {
            throw Object.assign(new Error(`EACCES ${env.root} ${TOKEN}`), { code: "EACCES" })
          },
        },
      }),
      schema: backendSchema,
      root: env.root,
      token: TOKEN,
      bridge: new FakeBridge(),
      log: (code) => logged.push(code),
    })
    const response = await call(app, "POST", "/model-check")
    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      ok: false,
      error: { code: "MODEL_CHECK_REQUEST_FAILED", message: new ApiError("MODEL_CHECK_REQUEST_FAILED").message },
    })
    expect(JSON.stringify(response.body)).not.toContain(env.root)
    expect(logged).toEqual(["MODEL_CHECK_REQUEST_FAILED"])
    expect(existsSync(requestFile())).toBe(false)
    expect(readdirSync(requestsDir())).toEqual([])
  })

  test("a failure to create the directory answers MODEL_CHECK_REQUEST_FAILED", async () => {
    env = makeEnv()
    const app = makeApp(env, {
      runtime: env.runtime({
        fs: {
          ...nodeFs,
          async mkdirp() {
            throw Object.assign(new Error("EROFS"), { code: "EROFS" })
          },
        },
      }),
    })
    const response = await call(app, "POST", "/model-check")
    expect(response.status).toBe(500)
    expect(response.body.error.code).toBe("MODEL_CHECK_REQUEST_FAILED")
  })

  test("ApiError maps the new code to status 500", () => {
    const error = new ApiError("MODEL_CHECK_REQUEST_FAILED")
    expect(error.status).toBe(500)
    expect(error.message).toBe("The model check request could not be written.")
  })
})
