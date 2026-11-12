/** Loopback HTTP transport for the guard app. Every request needs the bearer token. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { ApiError } from "./contract.ts"
import { MAX_BODY_BYTES, type App } from "./app.ts"

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers["content-length"] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new ApiError("PAYLOAD_TOO_LARGE"))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (overflow) return
      if (size > MAX_BODY_BYTES) {
        // Keep draining so the 413 answer can still be sent.
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => (overflow ? reject(new ApiError("PAYLOAD_TOO_LARGE")) : resolve(Buffer.concat(chunks).toString("utf8"))))
    request.on("error", () => reject(new ApiError("INVALID_REQUEST")))
  })
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  })
  response.end(text)
}

export function createHttpServer(app: App): Server {
  const server = createServer((request, response) => {
    void (async () => {
      const headers: Record<string, string | undefined> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value
      }
      let body: string | null = null
      const method = request.method ?? "GET"
      try {
        if (method === "POST" || method === "DELETE") {
          // The body is read only after the token check, so unauthenticated clients cannot send a large one.
          const pre = await app.handle({ method: "GET", url: "/health", headers, body: null })
          if (pre.status === 401) {
            request.resume()
            send(response, pre.status, pre.body)
            return
          }
          body = await readBody(request)
        }
        const result = await app.handle({ method, url: request.url ?? "/", headers, body })
        send(response, result.status, result.body)
      } catch (error) {
        const api = error instanceof ApiError ? error : new ApiError("INTERNAL_ERROR")
        send(response, api.status, { ok: false, error: { code: api.code, message: api.message } })
      }
    })()
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  return server
}
