import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadCatalog } from "../../../src/fuelix/catalog.ts"
import { BatchClientError } from "../../../src/fuelix/batch/client.ts"
import {
  BATCH_TOOL_NAMES,
  MAX_TOOL_OUTPUT_CHARS,
  defaultBatchArtifactRoot,
  setupBatchTools,
  type BatchToolService,
  type BatchToolsInput,
} from "../../../src/fuelix/batch/tools.ts"
import { setupFuelix } from "../../../src/fuelix/index.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import type { FuelixOptions } from "../../../src/options.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const CATALOG_URL = new URL("../../fixtures/fuelix/catalog.json", import.meta.url)

interface Call {
  readonly method: string
  readonly args: unknown[]
}

function mockService(overrides: Partial<Record<keyof BatchToolService, (...args: any[]) => Promise<unknown>>> = {}) {
  const calls: Call[] = []
  const make =
    (method: keyof BatchToolService) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return overrides[method] ? overrides[method]!(...args) : { ok: true, method }
    }
  const service: BatchToolService = {
    submit: make("submit"),
    list: make("list"),
    inspect: make("inspect"),
    status: make("status"),
    cancel: make("cancel"),
    collect: make("collect"),
  }
  return { service, calls }
}

function toolsInput(log = createMemoryLogger(), extra: Partial<BatchToolsInput> = {}): BatchToolsInput {
  return {
    baseURL: "https://api.fuelix.test",
    log,
    resolveKeys: async () => ({ key: KEY, envKey: KEY }),
    env: {},
    ...extra,
  }
}

async function setupTools(service: BatchToolService, extra: Partial<BatchToolsInput> = {}) {
  const fake = createFakeCtx({ directory: "/work/project" })
  const log = createMemoryLogger()
  const registration = await setupBatchTools(fake.ctx, toolsInput(log, extra), { service })
  return { fake, log, registration }
}

const ctxFor = (sessionID: string, signal?: AbortSignal) => ({ sessionID, ...(signal ? { signal } : {}) })

describe("setupBatchTools", () => {
  test("registers the six tools with plain JSON schemas and grounded descriptions", async () => {
    const { service } = mockService()
    const { fake } = await setupTools(service)
    expect([...fake.tools.keys()].sort()).toEqual([...BATCH_TOOL_NAMES].sort())
    for (const tool of fake.tools.values()) {
      expect(tool.input.type).toBe("object")
      expect(tool.input.additionalProperties).toBe(false)
      expect(Array.isArray(tool.input.required)).toBe(true)
      expect(tool.description).toContain("session that submitted")
      expect(tool.description.length).toBeLessThan(1200)
    }
    expect(fake.tools.get("fuelix_batch_submit")!.input.required).toEqual(["input_path"])
    expect(fake.tools.get("fuelix_batch_submit")!.input.properties.allow_duplicate).toMatchObject({ type: "boolean" })
    expect(fake.tools.get("fuelix_batch_submit")!.input.properties.allow_duplicate.description).toContain("explicitly asks")
    expect(Object.keys(fake.tools.get("fuelix_batch_list")!.input.properties)).toEqual(["limit", "after"])
    expect(Object.keys(fake.tools.get("fuelix_batch_inspect")!.input.properties).sort()).toEqual(["after", "batch_id", "limit"])
    for (const name of ["status", "cancel", "collect"]) {
      const tool = fake.tools.get(`fuelix_batch_${name}`)!
      expect(tool.input.required).toEqual(["batch_id"])
      expect(Object.keys(tool.input.properties)).toEqual(["batch_id"])
    }
    expect(fake.tools.get("fuelix_batch_submit")!.description).toContain("never retried automatically")
    expect(fake.tools.get("fuelix_batch_submit")!.description).toContain("no extra confirmation")
    expect(fake.tools.get("fuelix_batch_submit")!.description).toContain("another paid batch")
    expect(fake.tools.get("fuelix_batch_cancel")!.description).toContain("not guaranteed")
    expect(fake.tools.get("fuelix_batch_status")!.description).toContain("on demand")
    expect(fake.tools.get("fuelix_batch_collect")!.description).toContain("on demand")
  })

  test("forwards the originating session and the abort signal exactly", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    const controller = new AbortController()
    await fake.runTool("fuelix_batch_submit", { input_path: "requests.json" }, ctxFor("ses_A", controller.signal))
    await fake.runTool("fuelix_batch_list", { limit: 5, after: "cur" }, ctxFor("ses_B"))
    await fake.runTool("fuelix_batch_inspect", { batch_id: "job1", limit: 2 }, ctxFor("ses_A"))
    await fake.runTool("fuelix_batch_status", { batch_id: "msgbatch_1" }, ctxFor("ses_A", controller.signal))
    await fake.runTool("fuelix_batch_cancel", { batch_id: "job1" }, ctxFor("ses_C", controller.signal))
    await fake.runTool("fuelix_batch_collect", { batch_id: "job1" }, ctxFor("ses_A", controller.signal))

    expect(calls.map((call) => call.method)).toEqual(["submit", "list", "inspect", "status", "cancel", "collect"])
    expect(calls[0]!.args).toEqual(["ses_A", "requests.json", controller.signal])
    expect(calls[1]!.args).toEqual(["ses_B", { limit: 5, after: "cur" }])
    expect(calls[2]!.args).toEqual(["ses_A", "job1", { limit: 2 }])
    expect(calls[3]!.args).toEqual(["ses_A", "msgbatch_1", controller.signal])
    expect(calls[4]!.args).toEqual(["ses_C", "job1", controller.signal])
    expect(calls[5]!.args).toEqual(["ses_A", "job1", controller.signal])
  })

  test("model-supplied session fields cannot override the originating session", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    await fake.runTool(
      "fuelix_batch_status",
      { batch_id: "job1", sessionID: "ses_VICTIM", session_id: "ses_VICTIM", session: "ses_VICTIM" },
      ctxFor("ses_ORIGIN"),
    )
    await fake.runTool("fuelix_batch_list", { sessionID: "ses_VICTIM" }, ctxFor("ses_ORIGIN"))
    expect(calls[0]!.args[0]).toBe("ses_ORIGIN")
    expect(calls[1]!.args).toEqual(["ses_ORIGIN", {}])
    expect(JSON.stringify(calls)).not.toContain("VICTIM")
  })

  test("only an explicit true duplicate override adds service options and cannot change the session", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    const controller = new AbortController()
    await fake.runTool("fuelix_batch_submit", { input_path: "r.json", allow_duplicate: false }, ctxFor("ses_A", controller.signal))
    await fake.runTool(
      "fuelix_batch_submit",
      { input_path: "r.json", allow_duplicate: true, sessionID: "ses_VICTIM" },
      ctxFor("ses_B", controller.signal),
    )
    await fake.runTool("fuelix_batch_submit", { input_path: "r.json" }, ctxFor("ses_C", controller.signal))
    expect(calls.map((call) => call.args)).toEqual([
      ["ses_A", "r.json", controller.signal],
      ["ses_B", "r.json", controller.signal, { allowDuplicate: true }],
      ["ses_C", "r.json", controller.signal],
    ])
  })

  test("nonboolean duplicate overrides are rejected before the service or credentials are accessed", async () => {
    const { service, calls } = mockService()
    let resolutions = 0
    const { fake } = await setupTools(service, { resolveKeys: async () => {
      resolutions++
      return { key: KEY }
    } })
    for (const allow_duplicate of [null, 0, 1, "true", "false", {}, []]) {
      await expect(fake.runTool("fuelix_batch_submit", { input_path: "r.json", allow_duplicate }, ctxFor("ses_A")))
        .rejects.toThrow("allow_duplicate must be a boolean")
    }
    expect(calls).toEqual([])
    expect(resolutions).toBe(0)
  })

  test("a missing session is rejected without calling the service", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    await expect(fake.runTool("fuelix_batch_list", {}, { sessionID: "" })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test("relative input paths are forwarded unchanged for the service to resolve against the project directory", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    await fake.runTool("fuelix_batch_submit", { input_path: "sub/dir/requests.json" }, ctxFor("ses_A"))
    expect(calls[0]!.args[1]).toBe("sub/dir/requests.json")
  })

  test("invalid input is rejected before the service runs", async () => {
    const { service, calls } = mockService()
    const { fake } = await setupTools(service)
    const bad: [string, unknown][] = [
      ["fuelix_batch_submit", {}],
      ["fuelix_batch_submit", { input_path: "" }],
      ["fuelix_batch_submit", { input_path: 5 }],
      ["fuelix_batch_submit", { input_path: "a\0b" }],
      ["fuelix_batch_status", {}],
      ["fuelix_batch_status", { batch_id: "x".repeat(257) }],
      ["fuelix_batch_cancel", { batch_id: { $ne: 1 } }],
      ["fuelix_batch_list", { limit: 0 }],
      ["fuelix_batch_list", { limit: 101 }],
      ["fuelix_batch_list", { limit: 1.5 }],
      ["fuelix_batch_list", { limit: "5" }],
      ["fuelix_batch_list", { after: 3 }],
      ["fuelix_batch_inspect", { batch_id: "j", limit: -1 }],
      ["fuelix_batch_collect", undefined],
    ]
    for (const [name, input] of bad) {
      await expect(fake.runTool(name, input, ctxFor("ses_A"))).rejects.toThrow(/Invalid input/)
    }
    expect(calls).toEqual([])
  })

  test("returns JSON text and paths only, never file content blocks", async () => {
    const summary = { jobID: "job1", counts: { processing: 1 }, artifacts: { requests: "/data/job1/requests.json" } }
    const { service } = mockService({ submit: async () => summary })
    const { fake } = await setupTools(service)
    const result = await fake.runTool("fuelix_batch_submit", { input_path: "r.json" }, ctxFor("ses_A"))
    expect(typeof result.content).toBe("string")
    expect(JSON.parse(result.content)).toEqual(summary)
    expect(result.metadata).toEqual({ tool: "fuelix_batch_submit" })
    expect(result.output).toBeUndefined()
  })

  test("an oversized summary is replaced by a short notice", async () => {
    const { service } = mockService({ list: async () => ({ blob: "x".repeat(MAX_TOOL_OUTPUT_CHARS) }) })
    const { fake } = await setupTools(service)
    const result = await fake.runTool("fuelix_batch_list", {}, ctxFor("ses_A"))
    expect(result.content.length).toBeLessThan(500)
    expect(JSON.parse(result.content).truncated).toBe(true)
  })

  test("client errors keep their fixed message; other errors become generic and hide secrets and bodies", async () => {
    const remoteBody = '{"error":"leaked remote body with sk-test-not-a-real-key"}'
    const { service } = mockService({
      status: async () => {
        throw new BatchClientError("unauthorized", { status: 401 })
      },
      cancel: async () => {
        throw new Error(`HTTP 500 ${remoteBody} /Users/someone/secret/path`)
      },
      submit: async () => {
        throw new BatchClientError("network", { ambiguous: true, batchID: `untrusted-${KEY}` })
      },
    })
    const { fake, log } = await setupTools(service)

    const status = await fake.runTool("fuelix_batch_status", { batch_id: "j" }, ctxFor("s")).catch((e: Error) => e)
    expect((status as Error).message).toBe("FueliX batch request failed (unauthorized, HTTP 401)")

    const cancel = (await fake.runTool("fuelix_batch_cancel", { batch_id: "j" }, ctxFor("s")).catch((e: Error) => e)) as Error
    expect(cancel.message).toContain("fuelix_batch_cancel failed")
    expect(cancel.message).not.toContain("leaked")
    expect(cancel.message).not.toContain(KEY)
    expect(cancel.message).not.toContain("/Users")
    expect((cancel as { cause?: unknown }).cause).toBeUndefined()

    const submit = (await fake.runTool("fuelix_batch_submit", { input_path: "r.json" }, ctxFor("s")).catch((e: Error) => e)) as Error
    expect(submit.message).toContain("may be billed")
    expect(submit.message).toContain("not retried")
    expect(submit.message).not.toContain("untrusted")
    expect(submit.message).not.toContain(KEY)

    const logged = log.lines.join("\n")
    expect(logged).not.toContain(KEY)
    expect(logged).not.toContain("leaked")
    expect(logged).not.toContain("/Users")
  })

  test("a trusted error message that contains an active key is redacted", async () => {
    class BatchServiceError extends Error {
      override name = "BatchServiceError"
    }
    const { service } = mockService({
      collect: async () => {
        throw new BatchServiceError(`Cannot copy ${KEY} into artifacts`)
      },
    })
    const { fake } = await setupTools(service)
    const error = (await fake.runTool("fuelix_batch_collect", { batch_id: "j" }, ctxFor("s")).catch((e: Error) => e)) as Error
    expect(error.message).toContain("[redacted]")
    expect(error.message).not.toContain(KEY)
  })

  test("ambiguous service errors keep safe recovery handles without displaying the client batchID field", async () => {
    class BatchServiceError extends Error {
      override name = "BatchServiceError"
      readonly ambiguous = true
      readonly batchID = `untrusted-${KEY}`
    }
    const { service } = mockService({
      submit: async () => {
        throw new BatchServiceError("Submission outcome is unknown. Local job: job_safe_1.")
      },
    })
    const { fake, log } = await setupTools(service)
    const error = (await fake.runTool("fuelix_batch_submit", { input_path: "r.json" }, ctxFor("s")).catch((e: Error) => e)) as Error
    expect(error.message).toContain("job_safe_1")
    expect(error.message).toContain("may be billed")
    expect(error.message).toContain("check fuelix_batch_list")
    expect(error.message).not.toContain("untrusted")
    expect(error.message).not.toContain(KEY)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("short credential candidates are redacted in trusted errors and log names", async () => {
    const key = "xy"
    const { service } = mockService({
      status: async () => {
        const error = new Error(`Credential ${key}`)
        error.name = "BatchServiceError"
        throw error
      },
      cancel: async () => {
        const error = new Error("hidden details")
        error.name = `Error-${key}`
        Object.assign(error, { code: key })
        throw error
      },
    })
    const { fake, log } = await setupTools(service, { resolveKeys: async () => ({ key }) })
    const error = (await fake.runTool("fuelix_batch_status", { batch_id: "j" }, ctxFor("s")).catch((e: Error) => e)) as Error
    expect(error.message).toBe("Credential [redacted]")
    await expect(fake.runTool("fuelix_batch_cancel", { batch_id: "j" }, ctxFor("s"))).rejects.toThrow("failed")
    expect(log.lines.join("\n")).not.toContain(key)
  })

  test("credential history is private to a plugin instance and survives a failed refresh", async () => {
    const key = "unit-test-instance-private-key"
    let fail = false
    const { service } = mockService({
      status: async () => {
        const error = new Error(`Credential ${key}`)
        error.name = "BatchServiceError"
        throw error
      },
    })
    const first = await setupTools(service, { resolveKeys: async () => {
      if (fail) throw new Error("credential store unavailable")
      return { key }
    } })
    const invoke = (fake: typeof first.fake) => fake.runTool("fuelix_batch_status", { batch_id: "j" }, ctxFor("s")).catch((e: Error) => e)
    expect((await invoke(first.fake) as Error).message).toContain("[redacted]")
    fail = true
    expect((await invoke(first.fake) as Error).message).not.toContain(key)
    const other = await setupTools(service, { resolveKeys: async () => ({ key: "sk-test-other-instance" }) })
    // Only this fake trusted message mentions the first instance's key; no shared history redacts it.
    expect((await invoke(other.fake) as Error).message).toContain(key)
    expect(JSON.stringify([...first.fake.storage.values(), ...other.fake.storage.values()])).not.toContain(key)
  })

  test("an aborted call reports cancellation", async () => {
    const controller = new AbortController()
    const { service } = mockService({
      status: async () => {
        controller.abort()
        throw new Error("The operation was aborted with details sk-test-not-a-real-key")
      },
    })
    const { fake } = await setupTools(service)
    const error = (await fake.runTool("fuelix_batch_status", { batch_id: "j" }, ctxFor("s", controller.signal)).catch((e: Error) => e)) as Error
    expect(error.message).toBe("fuelix_batch_status was cancelled.")
  })

  test("disposing the registration removes the tools", async () => {
    const { service } = mockService()
    const { fake, registration } = await setupTools(service)
    expect(fake.tools.size).toBe(6)
    await registration.dispose()
    expect(fake.tools.size).toBe(0)
    expect(fake.toolRegistrations.every((entry) => entry.disposed)).toBe(true)
  })

  test("registering the tools writes nothing to storage or the file system", async () => {
    const dir = await mkdtemp(join(tmpdir(), "td-batch-tools-"))
    try {
      const root = join(dir, "artifacts")
      const fake = createFakeCtx({ directory: "/work/project" })
      await setupBatchTools(fake.ctx, toolsInput(), { artifactRoot: root, service: mockService().service })
      expect(await readdir(dir)).toEqual([])
      expect(fake.state.storageWrites).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("defaultBatchArtifactRoot", () => {
  test("uses an absolute XDG_DATA_HOME, hashed per directory, outside the repository", () => {
    const a = defaultBatchArtifactRoot("/work/a", { XDG_DATA_HOME: "/xdg/data" }, () => "/home/u")
    const b = defaultBatchArtifactRoot("/work/b", { XDG_DATA_HOME: "/xdg/data" }, () => "/home/u")
    expect(a.startsWith("/xdg/data/td-opencode-plugin/batches/")).toBe(true)
    expect(a).not.toBe(b)
    expect(a).toBe(defaultBatchArtifactRoot("/work/a", { XDG_DATA_HOME: "/xdg/data" }, () => "/home/u"))
    expect(a).toMatch(/\/batches\/[0-9a-f]{32}$/)
    expect(a).not.toContain("/work/a")
  })

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset, empty or relative", () => {
    for (const env of [{}, { XDG_DATA_HOME: "" }, { XDG_DATA_HOME: "relative/dir" }]) {
      expect(defaultBatchArtifactRoot("/work/a", env, () => "/home/u").startsWith("/home/u/.local/share/td-opencode-plugin/batches/")).toBe(true)
    }
  })
})

describe("setupFuelix batch integration", () => {
  const options: FuelixOptions = {
    baseURL: "https://api.fuelix.test",
    keychainService: "fuelix-api-key",
    refreshMinutes: 0,
    includeNonChatModels: false,
    discoveryTimeoutMs: 1000,
    scrubShellEnv: true,
  }

  const deps = (extra: Record<string, unknown> = {}) => ({
    loadCatalog: () => loadCatalog(CATALOG_URL),
    exec: async () => ({ exitCode: 44, stdout: "" }),
    env: { FUELIX_API_KEY: KEY },
    platform: "darwin",
    keychainCache: new Map(),
    staleConfigHolder: {},
    staleConfigDelaysMs: [0],
    fetch: async () => {
      throw new Error("unexpected fetch")
    },
    ...extra,
  })

  test("registers the batch tools and disposes them with the plugin", async () => {
    const fake = createFakeCtx()
    const { service, calls } = mockService()
    const cleanup = await setupFuelix(fake.ctx, options, createMemoryLogger(), deps({ batch: { service } }))
    expect([...fake.tools.keys()].sort()).toEqual([...BATCH_TOOL_NAMES].sort())
    await fake.runTool("fuelix_batch_list", {}, ctxFor("ses_A"))
    expect(calls).toHaveLength(1)
    expect([...fake.commands.keys()]).toEqual(["fuelix-batch"])
    await cleanup()
    expect(fake.tools.size).toBe(0)
    expect(fake.commands.size).toBe(0)
  })

  test("a batch registration failure leaves the providers and auth hooks working", async () => {
    const fake = createFakeCtx({ failToolTransform: true })
    const log = createMemoryLogger()
    const cleanup = await setupFuelix(fake.ctx, options, log, deps({ batch: { service: mockService().service } }))
    fake.runProviderTransforms()
    expect(fake.tools.size).toBe(0)
    expect(log.lines.some((line) => line.includes("could not register the FueliX batch tools"))).toBe(true)
    expect(fake.providers.get("fuelix-openai")).toBeDefined()
    expect(fake.hooks.length).toBeGreaterThan(0)
    expect(log.lines.join("\n")).not.toContain(KEY)
    await cleanup()
  })
})

describe("default service path", () => {
  const BATCH_ID = "msgbatch_unit_1"
  const MODEL = "claude-haiku-4-5"
  const RATES = { source: "Unit test rate sheet 2026-11", currency: "USD" as const, models: { [MODEL]: { input: 1, output: 5 } } }
  const options: FuelixOptions = {
    baseURL: "https://api.fuelix.ai",
    keychainService: "fuelix-api-key",
    refreshMinutes: 0,
    includeNonChatModels: false,
    discoveryTimeoutMs: 1000,
    scrubShellEnv: true,
    batchRates: RATES,
  }

  const resultLine = (id: string, text: string) =>
    JSON.stringify({
      custom_id: id,
      result: {
        type: "succeeded",
        message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200 } },
      },
    })

  /** Fake gateway: batch endpoints plus `/models` for background discovery. `onResults` can change the credentials. */
  function gateway(env: Record<string, string | undefined>, hooks: { results?: () => string } = {}) {
    const authorization: string[] = []
    const bodies: string[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: MODEL }] })
      authorization.push(String((init?.headers as Record<string, string>).authorization))
      const json = (value: unknown) => Response.json(value)
      const batch = (status: "in_progress" | "ended") => ({
        id: BATCH_ID,
        type: "message_batch",
        processing_status: status,
        request_counts: { processing: status === "ended" ? 0 : 2, succeeded: status === "ended" ? 2 : 0, errored: 0, canceled: 0, expired: 0 },
        created_at: "2026-11-05T10:00:00Z",
        ended_at: status === "ended" ? "2026-11-05T10:05:00Z" : null,
        results_url: status === "ended" ? `https://api.fuelix.ai/v1/messages/batches/${BATCH_ID}/results` : null,
      })
      if (init?.method === "POST" && url.pathname === "/v1/messages/batches") {
        bodies.push(String(init.body))
        return json(batch("in_progress"))
      }
      if (url.pathname.endsWith("/results")) {
        return new Response(hooks.results ? hooks.results() : `${resultLine("a", "one")}\n${resultLine("b", "two")}\n`)
      }
      if (url.pathname === `/v1/messages/batches/${BATCH_ID}`) return json(batch("ended"))
      return new Response("not found", { status: 404 })
    }
    void env
    return { fetch, authorization, bodies }
  }

  async function fixture(extra: { storage?: Record<string, unknown>; env?: Record<string, string | undefined> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "td-batch-default-"))
    const project = join(dir, "project")
    await mkdir(project)
    const requests = [
      { custom_id: "a", params: { model: `fuelix-anthropic/${MODEL}`, max_tokens: 10, messages: [{ role: "user", content: "PROMPT-ONE" }] } },
      { custom_id: "b", params: { model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "PROMPT-TWO" }] } },
    ]
    await writeFile(join(project, "requests.json"), JSON.stringify(requests))
    const env: Record<string, string | undefined> = extra.env ?? { FUELIX_API_KEY: KEY }
    const start = async (storage?: Record<string, unknown>, gw = gateway(env)) => {
      const fake = createFakeCtx({ directory: project, ...(storage ? { storage } : {}) })
      const log = createMemoryLogger()
      const cleanup = await setupFuelix(fake.ctx, options, log, {
        loadCatalog: () => loadCatalog(CATALOG_URL),
        exec: async () => ({ exitCode: 44, stdout: "" }),
        env,
        platform: "darwin",
        keychainCache: new Map(),
        staleConfigHolder: {},
        staleConfigDelaysMs: [0],
        fetch: gw.fetch,
        batch: { artifactRoot: join(dir, "artifacts") },
      })
      return { fake, log, cleanup, gw }
    }
    return { dir, project, env, start, artifactRoot: join(dir, "artifacts") }
  }

  const call = async (fake: ReturnType<typeof createFakeCtx>, name: string, input: unknown, session = "ses_A") =>
    JSON.parse((await fake.runTool(name, input, ctxFor(session))).content)

  test("credential resolution fails closed before any key has been seen", async () => {
    const f = await fixture()
    try {
      const fake = createFakeCtx({ directory: f.project })
      let fetches = 0
      const registration = await setupBatchTools(fake.ctx, toolsInput(createMemoryLogger(), {
        resolveKeys: async () => {
          throw new Error("credential store unavailable")
        },
        fetch: async () => {
          fetches++
          throw new Error("unexpected fetch")
        },
      }), { artifactRoot: f.artifactRoot })
      await expect(fake.runTool("fuelix_batch_submit", { input_path: "requests.json" }, ctxFor("ses_A")))
        .rejects.toThrow("Active credentials could not be checked")
      expect(fetches).toBe(0)
      expect(fake.state.storageWrites).toBe(0)
      expect(await readdir(f.dir)).toEqual(["project"])
      await registration.dispose()
    } finally {
      await rm(f.dir, { recursive: true, force: true })
    }
  })

  test("collection keeps known credentials when resolution fails after downloading", async () => {
    for (const content of ["clean", "raw-key", "unicode-key"]) {
      const f = await fixture()
      try {
        let failResolution = false
        const escapedKey = [...KEY].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
        const gw = gateway(f.env, { results: () => {
          failResolution = true
          const text = content === "clean" ? "one" : KEY
          const line = resultLine("a", text)
          return `${content === "unicode-key" ? line.replace(KEY, escapedKey) : line}\n${resultLine("b", "two")}\n`
        } })
        const fake = createFakeCtx({ directory: f.project })
        const log = createMemoryLogger()
        const registration = await setupBatchTools(fake.ctx, toolsInput(log, {
          baseURL: "https://api.fuelix.ai",
          fetch: gw.fetch,
          resolveKeys: async () => {
            if (failResolution) throw new Error("credential store unavailable")
            return { key: KEY }
          },
        }), { artifactRoot: f.artifactRoot })
        const submitted = await call(fake, "fuelix_batch_submit", { input_path: "requests.json" })
        await call(fake, "fuelix_batch_status", { batch_id: submitted.jobID })
        if (content === "clean") {
          const collected = await call(fake, "fuelix_batch_collect", { batch_id: submitted.jobID })
          expect(collected.collection.state).toBe("collected")
        } else {
          const error = (await fake.runTool("fuelix_batch_collect", { batch_id: submitted.jobID }, ctxFor("ses_A"))
            .catch((e: Error) => e)) as Error
          expect(error.message).toContain("active API key material")
          expect(error.message).not.toContain(KEY)
          expect(await readdir(join(f.artifactRoot, submitted.jobID))).not.toContain("results.jsonl")
        }
        expect(JSON.stringify([...fake.storage.values()])).not.toContain(KEY)
        expect(log.lines.join("\n")).not.toContain(KEY)
        await registration.dispose()
      } finally {
        await rm(f.dir, { recursive: true, force: true })
      }
    }
  })

  test("an estimate from configured rates is persisted and visible after submit, collect, and a restart", async () => {
    const f = await fixture()
    try {
      const first = await f.start()
      const submitted = await call(first.fake, "fuelix_batch_submit", { input_path: "requests.json" })
      expect(submitted.batchID).toBe(BATCH_ID)
      expect(submitted.cost.kind).toBe("unavailable")
      expect(first.gw.authorization.every((value) => value === `Bearer ${KEY}`)).toBe(true)
      expect(first.gw.bodies[0]).toContain(`"model":"${MODEL}"`)
      expect(first.gw.bodies[0]).not.toContain("fuelix-anthropic/")

      const status = await call(first.fake, "fuelix_batch_status", { batch_id: BATCH_ID })
      expect(status.remote.status).toBe("ended")
      const collected = await call(first.fake, "fuelix_batch_collect", { batch_id: submitted.jobID })
      expect(collected.collection.state).toBe("collected")
      const expected = { kind: "estimate", source: RATES.source, currency: "USD", amount: 0.004, succeeded: 2 }
      expect(collected.cost).toMatchObject(expected)
      expect(collected.collection.artifacts.results.startsWith(f.artifactRoot)).toBe(true)
      expect(collected.collection.artifacts.successes.startsWith(f.artifactRoot)).toBe(true)
      expect(JSON.stringify(collected)).not.toContain("PROMPT-ONE")
      expect(JSON.stringify(collected)).not.toContain('"text":"one"')
      expect(await readFile(collected.collection.artifacts.successes, "utf8")).toContain('"text":"one"')

      for (const view of [
        (await call(first.fake, "fuelix_batch_list", {})).jobs[0],
        (await call(first.fake, "fuelix_batch_inspect", { batch_id: BATCH_ID })).job,
        await call(first.fake, "fuelix_batch_status", { batch_id: submitted.jobID }),
      ]) {
        expect(view.cost).toMatchObject(expected)
      }
      expect(await call(first.fake, "fuelix_batch_list", {}, "ses_OTHER")).toMatchObject({ jobs: [] })
      await first.cleanup()

      // A new plugin instance with the same storage and artifact root, as after a restart.
      const second = await f.start(Object.fromEntries(first.fake.storage))
      const listed = (await call(second.fake, "fuelix_batch_list", {})).jobs[0]
      expect(listed.jobID).toBe(submitted.jobID)
      expect(listed.cost).toMatchObject(expected)
      expect(listed.collection.state).toBe("collected")
      await second.cleanup()
      expect(first.log.lines.join("\n")).not.toContain(KEY)
    } finally {
      await rm(f.dir, { recursive: true, force: true })
    }
  })

  test("a key that was used for a download and then rotated is still rejected in the results", async () => {
    const INTERMEDIATE = "sk-test-intermediate-key"
    const CURRENT = "sk-test-rotated-current-key"
    const f = await fixture()
    try {
      const gw = gateway(f.env, {
        results: () => {
          // The gateway echoes the key of this call, and the key rotates before the service checks the content.
          f.env.FUELIX_API_KEY = CURRENT
          return `${resultLine("a", `echo ${INTERMEDIATE}`)}\n${resultLine("b", "two")}\n`
        },
      })
      const run = await f.start(undefined, gw)
      const submitted = await call(run.fake, "fuelix_batch_submit", { input_path: "requests.json" })
      await call(run.fake, "fuelix_batch_status", { batch_id: BATCH_ID })
      f.env.FUELIX_API_KEY = INTERMEDIATE // rotated key used by the results download
      const error = (await run.fake.runTool("fuelix_batch_collect", { batch_id: submitted.jobID }, ctxFor("ses_A")).catch((e: Error) => e)) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain("active API key material")
      expect(error.message).not.toContain(INTERMEDIATE)
      expect(run.gw.authorization.at(-1)).toBe(`Bearer ${INTERMEDIATE}`)

      const written: string[] = []
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) await walk(path)
          else written.push(await readFile(path, "utf8"))
        }
      }
      await walk(f.artifactRoot)
      expect(written.length).toBeGreaterThan(0)
      for (const text of written) {
        expect(text).not.toContain(INTERMEDIATE)
        expect(text).not.toContain(CURRENT)
      }
      expect(JSON.stringify([...run.fake.storage.values()])).not.toContain(INTERMEDIATE)
      expect(run.log.lines.join("\n")).not.toContain(INTERMEDIATE)
      await run.cleanup()
    } finally {
      await rm(f.dir, { recursive: true, force: true })
    }
  })
})
