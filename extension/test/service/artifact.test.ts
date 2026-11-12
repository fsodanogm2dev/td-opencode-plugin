/**
 * Builds `service/main.ts` the way `openchamber-guest-bundle --node` does, runs the artifact under Node
 * with an isolated HOME, and checks the HTTP surface and API shape against a fake OpenCode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goodDraft } from "./support/harness.ts"

const TOKEN = "test-token-not-a-real-secret"
let dir = ""
let home = ""
let child: ReturnType<typeof Bun.spawn> | undefined
let opencode: Server | undefined
let base = ""
let stderr = ""
const sessionRequests: string[] = []

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

function request(method: string, path: string, body?: unknown, token: string | null = TOKEN, raw?: string) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "td-guards-artifact-"))
  home = join(dir, "home")
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "..", "service", "main.ts")],
    format: "esm",
    target: "node",
    minify: false,
  })
  expect(result.success).toBe(true)
  const text = await result.outputs[0]!.text()
  // Node built-ins only: no native addon, no bare package import left in the bundle.
  expect(text).not.toMatch(/from\s+"(?!node:)[^."/][^"]*"/)
  expect(text).not.toContain("bun:")
  writeFileSync(join(dir, "main.js"), text)

  opencode = createServer((req, res) => {
    sessionRequests.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${TOKEN}`}`)
    const match = /^\/api\/session\/(ses_[a-z]+)$/.exec(req.url ?? "")
    const sessions: Record<string, object> = {
      ses_root: { id: "ses_root", directory: "/work/project" },
      ses_sub: { id: "ses_sub", parentID: "ses_root", directory: "/work/project" },
    }
    const found = match ? sessions[match[1]!] : undefined
    res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" })
    res.end(JSON.stringify(found ?? { error: "not found" }))
  })
  const opencodePort = await new Promise<number>((resolve) =>
    opencode!.listen(0, "127.0.0.1", () => resolve((opencode!.address() as { port: number }).port)),
  )
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = Bun.spawn(["node", join(dir, "main.js")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  void (async () => {
    for await (const chunk of child!.stderr as unknown as AsyncIterable<Uint8Array>) stderr += new TextDecoder().decode(chunk)
  })()
  for (let i = 0; i < 100; i++) {
    try {
      const response = await request("GET", "/health")
      if (response.status === 200) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`service did not start: ${stderr}`)
}, 30_000)

afterAll(() => {
  child?.kill()
  opencode?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("built service artifact under Node", () => {
  test("health needs the token", async () => {
    expect((await request("GET", "/health")).status).toBe(200)
    expect((await request("GET", "/health", undefined, null)).status).toBe(401)
    expect((await request("GET", "/health", undefined, "wrong")).status).toBe(401)
  })

  test("full flow over HTTP with the documented response shapes", async () => {
    const created = await (await request("POST", "/guards", { opId: "op-http-create-1", draft: goodDraft })).json()
    expect(created).toMatchObject({ ok: true, data: { revision: 1, guard: { label: goodDraft.label } } })
    const guardId = created.data.guard.id

    const enabled = await (
      await request("POST", "/activations", { opId: "op-http-enable-1", guardId, sessionId: "ses_sub", scope: "request", expiresInMinutes: 10 })
    ).json()
    expect(enabled.ok).toBe(true)
    expect(enabled.data.revision).toBe(2)
    expect(enabled.data.activation).toMatchObject({ guardId, sessionId: "ses_root", scope: "request" })
    expect(Date.parse(enabled.data.activation.expiresAt) - Date.parse(enabled.data.activation.createdAt)).toBe(600_000)

    const state = await (await request("GET", `/state?sessionId=ses_sub&directory=${encodeURIComponent("/work/project")}`)).json()
    expect(Object.keys(state.data).sort()).toEqual(
      ["activations", "bridge", "effective", "guards", "lifecycle", "lifecycleHistory", "lifecycles", "revision", "runtime", "runtimeStatus"].sort(),
    )
    expect(state.data.effective.activationIds).toEqual([enabled.data.activation.id])
    expect(state.data.runtime).toBeNull()

    const released = await (await request("DELETE", `/activations/${enabled.data.activation.id}`, { opId: "op-http-release-1" })).json()
    expect(released.data).toMatchObject({ removed: true })
    const deleted = await (await request("DELETE", `/guards/${guardId}`, { opId: "op-http-delete-1" })).json()
    expect(deleted.data).toMatchObject({ removed: true })

    // Only the fixed read route was used, always with the service token.
    expect(new Set(sessionRequests)).toEqual(new Set(["GET /api/session/ses_sub true", "GET /api/session/ses_root true"]))
  })

  test("failure shape, body limit, and no stray output", async () => {
    const bad = await request("POST", "/guards", undefined, TOKEN, "{ nope")
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: { code: "INVALID_JSON", message: "The request body is not valid JSON." } })
    const big = await request("POST", "/guards", undefined, TOKEN, JSON.stringify({ opId: "x".repeat(70_000) }))
    expect(big.status).toBe(413)
    expect((await big.json()).error.code).toBe("PAYLOAD_TOO_LARGE")
    const unauthenticated = await request("POST", "/guards", undefined, null, "x".repeat(70_000))
    expect(unauthenticated.status).toBe(401)
    expect((await request("PUT", "/guards", {})).status).toBe(405)
  })

  test("files land under HOME with private modes and no token inside", () => {
    const file = join(home, ".td-opencode-plugin", "guards", "store.json")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, ".td-opencode-plugin", "guards")).mode & 0o777).toBe(0o700)
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN)
    expect(stderr).not.toContain(TOKEN)
  })

  test("store recovery over HTTP: corrupt store, confirmation, backup, replay", async () => {
    const guardsDir = join(home, ".td-opencode-plugin", "guards")
    const file = join(guardsDir, "store.json")
    const raw = '{"schema":"td-guards/1","revision":7,"guards":'
    writeFileSync(file, raw)

    const view = await request("GET", "/state")
    expect(view.status).toBe(503)
    expect((await view.json()).error.code).toBe("STORE_CORRUPT")

    const refused = await request("POST", "/store/recover", { opId: "op-http-recover-0", confirmation: "yes" })
    expect(refused.status).toBe(400)
    const refusedBody = await refused.json()
    expect(refusedBody.error.code).toBe("CONFIRMATION_REQUIRED")
    expect(refusedBody.error.message).toContain("all projects")
    expect(readFileSync(file, "utf8")).toBe(raw)

    const body = { opId: "op-http-recover-1", confirmation: "reset-global-guards" }
    const done = await (await request("POST", "/store/recover", body)).json()
    expect(done.ok).toBe(true)
    expect(Object.keys(done.data).sort()).toEqual(["backup", "recovered", "revision"])
    expect(done.data.revision).toBeGreaterThan(7)
    const backup = join(guardsDir, done.data.backup)
    expect(readFileSync(backup, "utf8")).toBe(raw)
    expect(statSync(backup).mode & 0o777).toBe(0o600)

    const replay = await (await request("POST", "/store/recover", body)).json()
    expect(replay.data).toMatchObject({ backup: done.data.backup, replayed: true })
    const fresh = await request("POST", "/store/recover", { opId: "op-http-recover-2", confirmation: "reset-global-guards" })
    expect(fresh.status).toBe(409)
    expect((await fresh.json()).error.code).toBe("RECOVERY_NOT_NEEDED")
    const state = await (await request("GET", "/state")).json()
    expect(state.data).toMatchObject({ revision: done.data.revision, guards: [], activations: [] })
  })
})
