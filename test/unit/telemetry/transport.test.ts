import { afterEach, describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { Transport } from "../../../src/telemetry/transport.ts"
import { msToUnixNano } from "../../../src/telemetry/types.ts"
import type { TelemetryRecord } from "../../../src/telemetry/types.ts"
import { sleep } from "./helpers.ts"

function rec(n: number, sessionID = "ses_1"): TelemetryRecord {
  return { eventName: "user_prompt", sessionID, timeUnixNano: msToUnixNano(1000 + n), attributes: { "event.sequence": n } }
}

interface Received {
  body: any
  contentType: string | null
  path: string
}

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

function serve(handler: (request: Request, count: number) => Response | Promise<Response>) {
  const received: Received[] = []
  let count = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      count += 1
      const body = await request.json().catch(() => undefined)
      received.push({ body, contentType: request.headers.get("content-type"), path: new URL(request.url).pathname })
      return handler(request, count)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, received }
}

const count = (received: Received[]) =>
  received.reduce((total, item) => total + item.body.resourceLogs[0].scopeLogs[0].logRecords.length, 0)

const base = { serviceVersion: "0.0.0", backoffMs: [1, 1] as const, flushIntervalMs: 20 }

describe("transport", () => {
  test("posts a batch to /v1/logs as JSON", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1), rec(2)])
    await transport.flush()
    expect(received).toHaveLength(1)
    expect(received[0]?.path).toBe("/v1/logs")
    expect(received[0]?.contentType).toBe("application/json")
    expect(count(received)).toBe(2)
    expect(transport.sent).toBe(2)
  })

  test("flushes at 25 records without waiting for the timer", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, flushIntervalMs: 60_000, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue(Array.from({ length: 25 }, (_, index) => rec(index)))
    await sleep(100)
    expect(count(received)).toBe(25)
  })

  test("flushes after the interval", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    expect(received).toHaveLength(0)
    await sleep(120)
    expect(count(received)).toBe(1)
  })

  test("retries and then succeeds", async () => {
    const { url, received } = serve((_, n) => (n < 3 ? new Response("no", { status: 503 }) : new Response("{}")))
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    await transport.flush()
    expect(received).toHaveLength(3)
    expect(transport.sent).toBe(1)
    expect(transport.dropped).toBe(0)
  })

  test("drops a batch after all retries fail and logs at debug level", async () => {
    const { url, received } = serve(() => new Response("no", { status: 500 }))
    const log = createMemoryLogger()
    const transport = new Transport({ ...base, receiverURL: url, log })
    transport.enqueue([rec(1), rec(2)])
    await transport.flush()
    expect(received).toHaveLength(3)
    expect(transport.dropped).toBe(2)
    expect(transport.pending).toBe(0)
    expect(log.lines.some((line) => line.includes(" debug ") && line.includes("batch dropped"))).toBe(true)
  })

  test("a client error is not retried", async () => {
    const { url, received } = serve(() => new Response("bad", { status: 400 }))
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    await transport.flush()
    expect(received).toHaveLength(1)
    expect(transport.dropped).toBe(1)
  })

  test("a connection error drops the batch without throwing", async () => {
    const transport = new Transport({ ...base, receiverURL: "http://127.0.0.1:1", log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    await transport.flush()
    expect(transport.dropped).toBe(1)
  })

  test("a slow receiver times out", async () => {
    const { url } = serve(async () => {
      await sleep(400)
      return new Response("{}")
    })
    const log = createMemoryLogger()
    const transport = new Transport({ ...base, retries: 0, timeoutMs: 50, receiverURL: url, log })
    transport.enqueue([rec(1)])
    const started = Date.now()
    await transport.flush()
    expect(Date.now() - started).toBeLessThan(350)
    expect(transport.dropped).toBe(1)
    expect(log.lines.some((line) => line.includes("timeout"))).toBe(true)
  })

  test("the queue holds 1000 records and drops the oldest", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, flushAt: 100_000, flushIntervalMs: 60_000, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue(Array.from({ length: 1005 }, (_, index) => rec(index)))
    expect(transport.pending).toBe(1000)
    expect(transport.dropped).toBe(5)
    await transport.flush()
    const sequences = received.flatMap((item) =>
      item.body.resourceLogs[0].scopeLogs[0].logRecords.map((log: any) =>
        Number(log.attributes.find((attribute: any) => attribute.key === "event.sequence").value.intValue),
      ),
    )
    expect(sequences).toHaveLength(1000)
    expect(sequences[0]).toBe(5)
    expect(sequences.at(-1)).toBe(1004)
  })

  test("waits for the segment of the session before sending", async () => {
    const { url, received } = serve(() => new Response("{}"))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger(), ready: () => gate })
    transport.enqueue([rec(1)])
    const flushed = transport.flush()
    await sleep(60)
    expect(received).toHaveLength(0)
    release()
    await flushed
    expect(received).toHaveLength(1)
  })

  test("stops waiting for a segment after the limit", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, readyWaitMs: 40, receiverURL: url, log: createMemoryLogger(), ready: () => new Promise<void>(() => {}) })
    transport.enqueue([rec(1)])
    await transport.flush()
    expect(received).toHaveLength(1)
  })

  test("close flushes the queue", async () => {
    const { url, received } = serve(() => new Response("{}"))
    const transport = new Transport({ ...base, flushIntervalMs: 60_000, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    await transport.close(1000)
    expect(count(received)).toBe(1)
  })

  test("close stops after its budget", async () => {
    const { url } = serve(async () => {
      await sleep(1000)
      return new Response("{}")
    })
    const transport = new Transport({ ...base, receiverURL: url, log: createMemoryLogger() })
    transport.enqueue([rec(1)])
    const started = Date.now()
    await transport.close(100)
    expect(Date.now() - started).toBeLessThan(600)
  })
})
