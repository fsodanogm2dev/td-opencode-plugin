import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BATCH_COMMAND_CUSTOM_ID,
  BATCH_COMMAND_MAX_TOKENS,
  BATCH_COMMAND_MODEL,
  BATCH_COMMAND_NAME,
  BATCH_COMMAND_SOURCE,
} from "../../../src/fuelix/batch/command.ts"
import { BatchServiceError } from "../../../src/fuelix/batch/service.ts"
import { BATCH_TOOL_NAMES, setupBatchTools, type BatchToolService, type BatchToolsInput } from "../../../src/fuelix/batch/tools.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const KEY = "sk-test-not-a-real-key"
const SESSION = "ses_cmd"

function mockService(submitRequests?: (...args: any[]) => Promise<unknown>) {
  const submits: unknown[][] = []
  const unexpected = async () => {
    throw new Error("unexpected call")
  }
  const service: BatchToolService = {
    submit: unexpected,
    list: unexpected,
    inspect: unexpected,
    status: unexpected,
    cancel: unexpected,
    collect: unexpected,
    submitRequests: (async (...args: unknown[]) => {
      submits.push(args)
      return submitRequests ? submitRequests(...args) : { jobID: "job-1", batchID: "msgbatch_1", submission: "submitted" }
    }) as BatchToolService["submitRequests"],
  }
  return { service, submits }
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

async function setup(service: BatchToolService, fakeOptions: Parameters<typeof createFakeCtx>[0] = {}) {
  const fake = createFakeCtx({ directory: "/work/project", ...fakeOptions })
  const log = createMemoryLogger()
  const registration = await setupBatchTools(fake.ctx, toolsInput(log), { service })
  return { fake, log, registration }
}

const run = (fake: ReturnType<typeof createFakeCtx>, text: unknown, extra: Record<string, unknown> = {}) =>
  fake.runCommand(BATCH_COMMAND_NAME, { sessionID: SESSION, prompt: { text, ...extra } })

describe("/fuelix-batch registration", () => {
  test("registers next to the six tools and disposes with them", async () => {
    const { service } = mockService()
    const { fake, registration } = await setup(service)
    expect([...fake.tools.keys()].sort()).toEqual([...BATCH_TOOL_NAMES].sort())
    expect([...fake.commands.keys()]).toEqual(["fuelix-batch"])
    expect(fake.commands.get("fuelix-batch")!.description).toContain(BATCH_COMMAND_MODEL)
    await registration.dispose()
    expect(fake.tools.size).toBe(0)
    expect(fake.commands.size).toBe(0)
    expect(fake.commandRegistrations.every((entry) => entry.disposed)).toBe(true)
  })

  test("a command registration failure with a key in the error name logs no key", async () => {
    const { service } = mockService()
    const fake = createFakeCtx({ directory: "/work/project" })
    ;(fake.ctx as any).command.transform = async () => {
      throw Object.assign(new Error(`boom ${KEY}`), { name: `Weird${KEY}` })
    }
    const log = createMemoryLogger()
    await setupBatchTools(fake.ctx, toolsInput(log), { service })
    expect(log.lines.some((line) => line.includes("could not register the FueliX batch command"))).toBe(true)
    expect(log.lines.join("\n")).not.toContain(KEY)
    expect(fake.tools.size).toBe(6)
  })

  test("registering writes nothing and sends nothing", async () => {
    const { service, submits } = mockService()
    const { fake } = await setup(service)
    expect(submits).toHaveLength(0)
    expect(fake.synthetics).toHaveLength(0)
    expect(fake.state.storageWrites).toBe(0)
  })

  test("a command registration failure is logged and leaves the tools working", async () => {
    const { service } = mockService()
    const { fake, log, registration } = await setup(service, { failCommandTransform: true })
    expect(fake.tools.size).toBe(6)
    expect(fake.commands.size).toBe(0)
    expect(log.lines.some((line) => line.includes("could not register the FueliX batch command"))).toBe(true)
    expect(log.lines.join("\n")).not.toContain("command transform failed")
    await registration.dispose()
    expect(fake.tools.size).toBe(0)
  })
})

describe("/fuelix-batch execution", () => {
  test("submits one request with the exact prompt, default model, and token cap, and reports a safe summary", async () => {
    const { service, submits } = mockService()
    const { fake } = await setup(service)
    const prompt = "  Summarize \"this\"\n\tkeep spacing  "
    await run(fake, prompt)
    expect(submits).toHaveLength(1)
    const [sessionID, requests, source] = submits[0]!
    expect(sessionID).toBe(SESSION)
    expect(source).toBe(BATCH_COMMAND_SOURCE)
    expect(source).toBe("inline:/fuelix-batch")
    expect(requests).toEqual([
      { custom_id: "prompt", params: { model: "claude-haiku-5-5-anthropic", max_tokens: 4096, messages: [{ role: "user", content: prompt }] } },
    ])
    expect(BATCH_COMMAND_CUSTOM_ID).toBe("prompt")
    expect(BATCH_COMMAND_MODEL).toBe("claude-haiku-5-5-anthropic")
    expect(BATCH_COMMAND_MAX_TOKENS).toBe(4096)
    expect(fake.synthetics).toHaveLength(1)
    const feedback = fake.synthetics[0]!
    expect(feedback.sessionID).toBe(SESSION)
    expect(feedback.resume).toBe(false)
    expect(feedback.delivery).toBe("queue")
    expect(feedback.text).toContain("output limit 4096 tokens")
    expect(feedback.text).toContain("Collect the result separately")
    expect(feedback.text).not.toContain("not ready")
    expect(feedback.description).toBe("FueliX batch submitted")
    expect(feedback.text).toContain("job-1")
    expect(feedback.text).toContain("msgbatch_1")
    expect(feedback.text).not.toContain("Summarize")
  })

  test("uses the delivery of the invocation", async () => {
    const { service } = mockService()
    const { fake } = await setup(service)
    await fake.runCommand(BATCH_COMMAND_NAME, { sessionID: SESSION, prompt: { text: "x" }, delivery: "steer" })
    expect(fake.synthetics[0]!.delivery).toBe("steer")
  })

  test("blank, whitespace, and non-text prompts show usage and submit nothing", async () => {
    const { service, submits } = mockService()
    const { fake } = await setup(service)
    for (const text of ["", "   \n\t ", undefined, 42]) await run(fake, text)
    expect(submits).toHaveLength(0)
    expect(fake.synthetics).toHaveLength(4)
    for (const feedback of fake.synthetics) {
      expect(feedback.text).toContain("Usage: /fuelix-batch <prompt>")
      expect(feedback.resume).toBe(false)
    }
    expect(fake.state.storageWrites).toBe(0)
  })

  test("attachments, agents, and skills are rejected, never silently dropped", async () => {
    const { service, submits } = mockService()
    const { fake } = await setup(service)
    await run(fake, "look at this", { files: [{ uri: "file:///work/project/secret.txt" }] })
    await run(fake, "ask @oracle", { agents: [{ name: "oracle" }] })
    await run(fake, "use skill", { skills: [{ id: "s1" }] })
    expect(submits).toHaveLength(0)
    expect(fake.synthetics).toHaveLength(3)
    for (const feedback of fake.synthetics) {
      expect(feedback.text).toContain("plain prompt text only")
      expect(feedback.text).toContain("Nothing was submitted")
      expect(feedback.text).not.toContain("secret.txt")
    }
  })

  test("empty attachment arrays do not block a plain prompt", async () => {
    const { service, submits } = mockService()
    const { fake } = await setup(service)
    await run(fake, "plain", { files: [], agents: [], skills: [] })
    expect(submits).toHaveLength(1)
  })

  test("never uses a model or prompt API of the session", async () => {
    const { service } = mockService()
    const { fake } = await setup(service)
    const session = (fake.ctx as any).session
    expect(session.prompt).toBeUndefined()
    expect(session.generate).toBeUndefined()
    await run(fake, "hello")
    expect(fake.synthetics).toHaveLength(1)
  })

  test("a replaced service without inline submission reports a generic error and does not throw", async () => {
    const { service } = mockService()
    delete (service as { submitRequests?: unknown }).submitRequests
    const { fake } = await setup(service)
    await run(fake, "hello")
    expect(fake.synthetics[0]!.text).toContain("failed")
  })
})

describe("/fuelix-batch failures", () => {
  test("unknown errors become a generic message without the prompt, key, or thrown text", async () => {
    const { service, submits } = mockService(async () => {
      throw new Error(`remote said ${KEY} and PROMPT-TEXT-123`)
    })
    const { fake, log } = await setup(service)
    await run(fake, "PROMPT-TEXT-123")
    expect(submits).toHaveLength(1)
    const all = JSON.stringify(fake.synthetics) + log.lines.join("\n")
    expect(fake.synthetics[0]!.text).toContain("error details are not shown")
    expect(all).not.toContain(KEY)
    expect(all).not.toContain("PROMPT-TEXT-123")
    expect(all).not.toContain("remote said")
  })

  test("safe service errors keep their fixed message with the key redacted", async () => {
    const { service } = mockService(async () => {
      throw new BatchServiceError("invalid_input", `Input is wrong near ${KEY}`)
    })
    const { fake } = await setup(service)
    await run(fake, "x")
    expect(fake.synthetics[0]!.text).toContain("Input is wrong")
    expect(fake.synthetics[0]!.text).not.toContain(KEY)
  })

  test("an ambiguous failure says it was not retried and may be billed", async () => {
    const { service, submits } = mockService(async () => {
      throw new BatchServiceError("submission_unknown", "Submission outcome is unknown. Job: job-9.", { jobID: "job-9", ambiguous: true })
    })
    const { fake } = await setup(service)
    await run(fake, "x")
    expect(submits).toHaveLength(1)
    expect(fake.synthetics[0]!.text).toContain("not retried")
    expect(fake.synthetics[0]!.text).toContain("may be billed")
    expect(fake.synthetics[0]!.description).toBe("FueliX batch submission needs attention")
  })

  test("a duplicate message names the job and offers no override", async () => {
    const { service } = mockService(async () => {
      throw new BatchServiceError("duplicate_submission", "Set allowDuplicate to true.", { jobID: "job-7" })
    })
    const { fake } = await setup(service)
    await run(fake, "x")
    const text = String(fake.synthetics[0]!.text)
    expect(text).toContain("job-7")
    expect(text).toContain("Nothing was sent")
    expect(text).not.toContain("allowDuplicate")
  })

  test("a feedback failure after an accepted batch is logged, does not throw, and never resubmits", async () => {
    const { service, submits } = mockService()
    const { fake, log } = await setup(service, { failSynthetic: true })
    await run(fake, "x")
    expect(submits).toHaveLength(1)
    expect(log.lines.some((line) => line.includes("feedback failed"))).toBe(true)
  })

  test("a feedback failure whose error name holds a key is logged without it and never resubmits", async () => {
    const { service, submits } = mockService()
    const { fake, log } = await setup(service, { failSynthetic: Object.assign(new Error(`body ${KEY}`), { name: `Weird${KEY}` }) })
    await run(fake, "x")
    expect(submits).toHaveLength(1)
    expect(log.lines.some((line) => line.includes("feedback failed"))).toBe(true)
    expect(log.lines.join("\n")).not.toContain(KEY)
  })

  test("a feedback failure on an error throws only the safe text and never resubmits", async () => {
    const { service, submits } = mockService(async () => {
      throw new Error(`secret ${KEY}`)
    })
    const { fake } = await setup(service, { failSynthetic: true })
    const error = await run(fake, "x").then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toContain("error details are not shown")
    expect(error?.message).not.toContain(KEY)
    expect(submits).toHaveLength(1)
  })
})

describe("/fuelix-batch with the default service", () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })

  function gateway(post: () => Response | Promise<Response>) {
    const posts: { url: string; body: string; authorization: string }[] = []
    const other: string[] = []
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input)
      if (init?.method === "POST" && url.pathname === "/v1/messages/batches") {
        posts.push({ url: input, body: String(init.body), authorization: String((init.headers as Record<string, string>).authorization) })
        return post()
      }
      other.push(`${init?.method ?? "GET"} ${url.pathname}`)
      return Response.json({
        id: "msgbatch_cmd",
        type: "message_batch",
        processing_status: "in_progress",
        request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
        created_at: "2026-11-05T10:00:00Z",
        ended_at: null,
        results_url: null,
      })
    }
    return { fetch, posts, other }
  }

  const accepted = () =>
    Response.json({
      id: "msgbatch_cmd",
      type: "message_batch",
      processing_status: "in_progress",
      request_counts: { processing: 1, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      created_at: "2026-11-05T10:00:00Z",
      ended_at: null,
      results_url: null,
    })

  async function start(gw: ReturnType<typeof gateway>, resolveKeys?: BatchToolsInput["resolveKeys"]) {
    const dir = await mkdtemp(join(tmpdir(), "td-batch-command-"))
    dirs.push(dir)
    await mkdir(join(dir, "project"))
    const fake = createFakeCtx({ directory: join(dir, "project") })
    const log = createMemoryLogger()
    const registration = await setupBatchTools(
      fake.ctx,
      toolsInput(log, { baseURL: "https://api.fuelix.ai", fetch: gw.fetch, ...(resolveKeys ? { resolveKeys } : {}) }),
      { artifactRoot: join(dir, "artifacts") },
    )
    return { dir, fake, log, registration, artifactRoot: join(dir, "artifacts") }
  }

  const persisted = async (dir: string, fake: ReturnType<typeof createFakeCtx>) => {
    const parts = [JSON.stringify([...fake.storage.entries()])]
    const walk = async (path: string) => {
      for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) await walk(child)
        else parts.push(await readFile(child, "utf8"))
      }
    }
    await walk(dir)
    return parts.join("\n")
  }

  test("one POST with the exact payload; tools of the same session inspect and status the job; no key persisted", async () => {
    const gw = gateway(accepted)
    const f = await start(gw)
    const prompt = "  Explain \"batches\"  "
    await run(f.fake, prompt)
    expect(gw.posts).toHaveLength(1)
    expect(gw.posts[0]!.authorization).toBe(`Bearer ${KEY}`)
    expect(JSON.parse(gw.posts[0]!.body)).toEqual({
      requests: [
        { custom_id: "prompt", params: { model: "claude-haiku-5-5-anthropic", max_tokens: 4096, messages: [{ role: "user", content: prompt }] } },
      ],
    })
    const text = String(f.fake.synthetics[0]!.text)
    const jobID = /Job (job-[^\s,]+)/.exec(text)![1]!
    const listed = JSON.parse((await f.fake.runTool("fuelix_batch_list", {}, { sessionID: SESSION })).content)
    expect(listed.jobs).toHaveLength(1)
    expect(listed.jobs[0].jobID).toBe(jobID)
    expect(listed.jobs[0].inputPath).toBe("inline:/fuelix-batch")
    const inspected = JSON.parse((await f.fake.runTool("fuelix_batch_inspect", { batch_id: jobID }, { sessionID: SESSION })).content)
    expect(inspected.requests.items[0]).toEqual({ index: 0, custom_id: "prompt", model: "claude-haiku-5-5-anthropic", max_tokens: 4096 })
    const status = JSON.parse((await f.fake.runTool("fuelix_batch_status", { batch_id: jobID }, { sessionID: SESSION })).content)
    expect(status.remote.status).toBe("in_progress")
    // Another session cannot see it.
    await expect(f.fake.runTool("fuelix_batch_inspect", { batch_id: jobID }, { sessionID: "ses_other" })).rejects.toThrow("No batch job")
    expect(await persisted(f.dir, f.fake)).not.toContain(KEY)
    expect(JSON.stringify(f.fake.synthetics) + f.log.lines.join("\n")).not.toContain(KEY)
    expect(JSON.stringify(f.fake.synthetics) + f.log.lines.join("\n")).not.toContain("Explain")
  })

  test("a prompt that contains the active key is rejected before storage or the network", async () => {
    const gw = gateway(accepted)
    const f = await start(gw)
    await run(f.fake, `use ${KEY} please`)
    expect(gw.posts).toHaveLength(0)
    expect(String(f.fake.synthetics[0]!.text)).toContain("active API key material")
    expect(String(f.fake.synthetics[0]!.text)).not.toContain(KEY)
    expect(f.fake.state.storageWrites).toBe(0)
    expect(await readdir(f.dir)).toEqual(["project"])
  })

  test("a missing key fails before storage and sends nothing", async () => {
    const gw = gateway(accepted)
    const f = await start(gw, async () => {
      throw new Error("credential store unavailable")
    })
    await run(f.fake, "hello")
    expect(gw.posts).toHaveLength(0)
    expect(String(f.fake.synthetics[0]!.text)).toContain("Active credentials could not be checked")
    expect(f.fake.state.storageWrites).toBe(0)
  })

  test("an ambiguous gateway failure is posted once and the same prompt is then blocked", async () => {
    const gw = gateway(() => new Response(`upstream ${KEY}`, { status: 503 }))
    const f = await start(gw)
    await run(f.fake, "same prompt")
    expect(gw.posts).toHaveLength(1)
    expect(String(f.fake.synthetics[0]!.text)).toContain("not retried")
    await run(f.fake, "same prompt")
    expect(gw.posts).toHaveLength(1)
    expect(String(f.fake.synthetics[1]!.text)).toContain("Nothing was sent")
    expect(String(f.fake.synthetics[1]!.text)).not.toContain("allowDuplicate")
    expect(JSON.stringify(f.fake.synthetics)).not.toContain(KEY)
    expect(await persisted(f.dir, f.fake)).not.toContain(KEY)
  })

  test("a feedback failure after acceptance does not post again", async () => {
    const gw = gateway(accepted)
    const dir = await mkdtemp(join(tmpdir(), "td-batch-command-"))
    dirs.push(dir)
    await mkdir(join(dir, "project"))
    const fake = createFakeCtx({ directory: join(dir, "project"), failSynthetic: true })
    await setupBatchTools(fake.ctx, toolsInput(createMemoryLogger(), { baseURL: "https://api.fuelix.ai", fetch: gw.fetch }), {
      artifactRoot: join(dir, "artifacts"),
    })
    await run(fake, "hello")
    expect(gw.posts).toHaveLength(1)
    const listed = JSON.parse((await fake.runTool("fuelix_batch_list", {}, { sessionID: SESSION })).content)
    expect(listed.jobs).toHaveLength(1)
  })
})
