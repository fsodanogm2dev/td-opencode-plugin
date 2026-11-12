import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { buildPlugin, externalImports } from "../../../scripts/build-extension-plugin.ts"
import { statusFileName } from "../../../src/fuelix/status.ts"

const ROOT = new URL("../../..", import.meta.url).pathname
const LOCATION = "/isolated/location"

interface RootManifest {
  name: string
  version: string
  files: string[]
  exports: Record<string, string>
  openchamber: {
    apiVersion: number
    engines: { openchamber: string }
    id: string
    name: string
    icon: string
    contributes: { panel: { entry: string }; filesystem: string[]; opencodePlugin: string }
  }
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T

describe("root package manifest", () => {
  test("declares the OpenChamber extension with the standalone OpenCode plugin", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    expect(pkg.openchamber).toEqual({
      apiVersion: 1,
      engines: { openchamber: ">=2.7.0" },
      id: "td-fuelix-status",
      name: "FueliX status",
      icon: "extension/icon.svg",
      contributes: {
        panel: { entry: "extension/panel/index.html" },
        filesystem: ["~/.td-opencode-plugin/status/*.json"],
        opencodePlugin: "extension/plugin",
      },
    })
  })

  test("keeps the source export for standalone OpenCode installs", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    expect(pkg.exports["."]).toBe("./src/index.ts")
    expect(pkg.files).toContain("src")
    expect(pkg.files).toContain("data")
  })

  test("every manifest asset exists and is listed in files", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const { icon, contributes } = pkg.openchamber
    const assets = [icon, contributes.panel.entry, "extension/panel/main.js", `${contributes.opencodePlugin}/index.js`]
    for (const asset of assets) {
      expect(existsSync(join(ROOT, asset))).toBe(true)
      expect(pkg.files).toContain(asset)
    }
    expect(existsSync(join(ROOT, "data/fuelix-models.json"))).toBe(true)
  })

  test("the root and the status-only extension manifests have one version", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const child = await readJson<{ version: string; openchamber: { contributes: Record<string, unknown> } }>(
      join(ROOT, "extension/package.json"),
    )
    expect(child.version).toBe(pkg.version)
    expect(child.openchamber.contributes.opencodePlugin).toBeUndefined()
  })
})

describe("generated plugin bundle", () => {
  test("is current with the source", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(committed).toBe(await buildPlugin())
  }, 30_000)

  test("imports only Node built-in modules", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(externalImports(committed)).toEqual([])
    expect(externalImports(`import x from "zod"\nimport { a } from "node:fs"\nawait import("@opencode/plugin")`)).toEqual([
      "@opencode/plugin",
      "zod",
    ])
  })

  test("has a version banner that matches the root version", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(committed.startsWith(`// ${pkg.name} v${pkg.version}.`)).toBe(true)
  })
})

/** Result that the child process prints for one plugin run. */
interface RunResult {
  id: unknown
  setupType: unknown
  providers: Record<string, { models: number; integrationID: unknown }>
  sessionHookProviders: string[]
  aisdkHooks: number
  tools: string[]
  methods: number
}

describe("plugin bundle in the shipped package layout", () => {
  let packageDir: string

  beforeAll(async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    packageDir = await mkdtemp(join(tmpdir(), "td-package-"))
    // Copy only what the package ships and the bundle needs. The copied `package.json` marks `index.js` as an ES
    // module. The source tree stays out, so the run proves that the bundle needs no `src/` and no `node_modules/`,
    // and that it finds the catalog by its relative path.
    for (const entry of [...pkg.files.filter((file) => file === "data" || file.startsWith("extension/plugin/")), "package.json"]) {
      await mkdir(dirname(join(packageDir, entry)), { recursive: true })
      await cp(join(ROOT, entry), join(packageDir, entry), { recursive: true })
    }
  })

  afterAll(async () => {
    await rm(packageDir, { recursive: true, force: true })
  })

  async function run(options: Record<string, unknown>): Promise<{ result: RunResult; home: string }> {
    const home = await mkdtemp(join(tmpdir(), "td-bundle-home-"))
    const script = join(home, "run.mjs")
    await Bun.write(
      script,
      `
import plugin from ${JSON.stringify(join(packageDir, "extension/plugin/index.js"))}
import { createFakeCtx } from ${JSON.stringify(join(ROOT, "test/unit/fuelix/fake-ctx.ts"))}
const fake = createFakeCtx({ directory: ${JSON.stringify(LOCATION)} })
fake.ctx.options = { fuelix: ${JSON.stringify({ keychainService: false, refreshMinutes: 0, ...options })} }
const cleanup = await plugin.setup(fake.ctx)
fake.runProviderTransforms()
await new Promise((resolve) => setTimeout(resolve, 600))
const providers = {}
for (const [id, record] of fake.providers) providers[id] = { models: record.models.size, integrationID: record.provider.integrationID }
console.log("RESULT " + JSON.stringify({
  id: plugin.id,
  setupType: typeof plugin.setup,
  providers,
  sessionHookProviders: fake.hooks.map((hook) => hook.options?.providerID).filter(Boolean).sort(),
  aisdkHooks: fake.aisdkHooks.length,
  tools: [...fake.tools.keys()].sort(),
  methods: fake.integrationMethods.length,
}))
await cleanup()
process.exit(0)
`,
    )
    // No key in the environment, no Keychain lookup, no network, and a temporary HOME and XDG tree.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
    }
    const child = Bun.spawn([process.execPath, script], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`bundle subprocess exited with ${code}: ${stderr}`)
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
    if (!line) throw new Error(`bundle subprocess printed no result: ${stdout}${stderr}`)
    return { result: JSON.parse(line.slice("RESULT ".length)) as RunResult, home }
  }

  test("default-exports the plugin id and setup and loads the catalog by its relative path", async () => {
    const { result, home: dir } = await run({})
    try {
      expect(result.id).toBe("td-opencode-plugin")
      expect(result.setupType).toBe("function")
      expect(Object.keys(result.providers).sort()).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
      for (const provider of Object.values(result.providers)) {
        expect(provider.integrationID).toBe("fuelix")
        expect(provider.models).toBeGreaterThan(0)
      }
      expect(result.methods).toBe(2)
      expect(result.sessionHookProviders).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
      expect(result.aisdkHooks).toBeGreaterThan(0)

      const catalog = await readJson<{ models: Record<string, { listed?: boolean; kind: string }> }>(join(ROOT, "data/fuelix-models.json"))
      const listedChat = Object.values(catalog.models).filter((entry) => entry.listed === true && entry.kind === "chat").length
      const total = Object.values(result.providers).reduce((sum, provider) => sum + provider.models, 0)
      expect(total).toBe(listedChat)

      const reportPath = join(dir, ".td-opencode-plugin", "status", statusFileName(LOCATION))
      const report = await readJson<{
        pluginVersion: string
        models: { source: string; providers: { id: string; count: number }[] }
        configuration: { authSource: string; authHooks: { sessionProviders: string[]; aiSdk: boolean } }
        lastCheck: { outcome: string } | null
      }>(reportPath)
      const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
      expect(report.pluginVersion).toBe(pkg.version)
      expect(report.models.source).toBe("catalog")
      expect(report.models.providers.reduce((sum, provider) => sum + provider.count, 0)).toBe(total)
      expect(report.configuration.authSource).toBe("none")
      expect(report.configuration.authHooks.aiSdk).toBe(true)
      expect([...report.configuration.authHooks.sessionProviders].sort()).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
      expect(report.lastCheck?.outcome).toBe("no-key")
      expect(JSON.stringify(report)).not.toContain("sk-")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("fuelix.statusReport false writes no report", async () => {
    const { home: dir } = await run({ statusReport: false })
    try {
      expect(existsSync(join(dir, ".td-opencode-plugin"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test("source options still apply: includeNonChatModels adds models", async () => {
    const base = await run({ statusReport: false })
    const withAll = await run({ statusReport: false, includeNonChatModels: true })
    try {
      const count = (result: RunResult) => Object.values(result.providers).reduce((sum, provider) => sum + provider.models, 0)
      expect(count(withAll.result)).toBeGreaterThan(count(base.result))
    } finally {
      await rm(base.home, { recursive: true, force: true })
      await rm(withAll.home, { recursive: true, force: true })
    }
  }, 60_000)
})
