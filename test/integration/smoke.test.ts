import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { type IsolatedServer, pluginEntry, startIsolatedServer, waitFor } from "./harness.ts"

const TIMEOUT = 120_000
const servers: IsolatedServer[] = []

async function start(input?: Parameters<typeof startIsolatedServer>[0]): Promise<IsolatedServer> {
  const server = await startIsolatedServer(input)
  servers.push(server)
  return server
}

interface PluginInfo {
  id: string
  source: { type: string }
  state: { status: string }
}

/** OpenCode boots a location lazily. The first request starts the boot and the plugin list stays empty until it ends. */
async function listPlugins(server: IsolatedServer): Promise<PluginInfo[]> {
  return waitFor(
    async () => {
      const response = await server.api<{ data: PluginInfo[] }>("GET", "/api/plugin")
      return response.status === 200 && response.json.data.length > 0 ? response.json.data : undefined
    },
    60_000,
    "plugin list",
  )
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()))
})

describe("isolated OpenCode server", () => {
  test(
    "starts without plugins and sees none of the user's configuration",
    async () => {
      const server = await start()
      expect(server.dirs.project.startsWith(homedir())).toBe(false)

      const info = await server.api<{ version: string }>("GET", "/api/info")
      expect(info.status).toBe(200)
      expect(typeof info.json.version).toBe("string")

      const providers = await server.api<{ data: Array<{ id: string }> }>("GET", "/api/provider")
      expect(providers.status).toBe(200)
      expect(Array.isArray(providers.json.data)).toBe(true)
      expect(providers.json.data.filter((p) => p.id.startsWith("fuelix"))).toEqual([])

      const plugins = await listPlugins(server)
      const ids = plugins.map((p) => p.id)
      for (const forbidden of ["oh-my-opencode-slim", "jev-orchestrator", "openchamber-agent-tool", "td-opencode-plugin"]) {
        expect(ids).not.toContain(forbidden)
      }
      // Every plugin comes from OpenCode itself.
      expect(plugins.every((p) => p.source.type === "builtin")).toBe(true)
    },
    TIMEOUT,
  )

  test(
    "loads this repository as a plugin and stays healthy",
    async () => {
      const server = await start({ config: { plugins: [pluginEntry()] } })

      const plugins = await listPlugins(server)
      const ours = await waitFor(
        async () => {
          const list = await listPlugins(server)
          return list.find((p) => p.id === "td-opencode-plugin")
        },
        60_000,
        "td-opencode-plugin",
      )
      expect(plugins.length).toBeGreaterThan(0)
      expect(ours.state.status).toBe("active")
      expect(ours.source.type).toBe("local")

      const info = await server.api("GET", "/api/info")
      expect(info.status).toBe(200)
      const providers = await server.api("GET", "/api/provider")
      expect(providers.status).toBe(200)
    },
    TIMEOUT,
  )

  test(
    "stop removes the temporary root",
    async () => {
      const server = await start()
      const root = server.dirs.root
      expect(existsSync(root)).toBe(true)
      await server.stop()
      await server.stop() // idempotent
      expect(existsSync(root)).toBe(process.env.KEEP_TMP === "1")
      if (process.env.KEEP_TMP === "1") console.log(`kept ${root}`)
    },
    TIMEOUT,
  )
})
