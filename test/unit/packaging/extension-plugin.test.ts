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
    contributes: {
      panel: { entry: string }
      statusSection: { entry: string; title: string; height: number; requiresProject: boolean }
      capabilities: string[]
      service: { entry: string; runtime: string; provides: string[] }
      filesystem: string[]
      opencodePlugin: string
    }
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
      name: "TD-Plugin extension",
      icon: "extension/icon.svg",
      contributes: {
        panel: { entry: "extension/panel/index.html" },
        statusSection: {
          entry: "extension/panel/status.html",
          title: "TD-Plugin guards",
          height: 48,
          requiresProject: false,
        },
        capabilities: ["model", "sessions"],
        service: { entry: "extension/service/main.js", runtime: "host", provides: ["opencode"] },
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
    const assets = [
      icon,
      contributes.panel.entry,
      "extension/panel/main.js",
      contributes.statusSection.entry,
      "extension/panel/status.js",
      contributes.service.entry,
      `${contributes.opencodePlugin}/index.js`,
    ]
    for (const asset of assets) {
      expect(existsSync(join(ROOT, asset))).toBe(true)
      expect(pkg.files).toContain(asset)
    }
    expect(existsSync(join(ROOT, "data/fuelix-models.json"))).toBe(true)
  })

  test("the root and the child extension manifests have one version, id, and display name", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const child = await readJson<{ version: string; openchamber: { id: string; name: string; contributes: Record<string, unknown> } }>(
      join(ROOT, "extension/package.json"),
    )
    expect(child.version).toBe(pkg.version)
    expect(child.openchamber.id).toBe(pkg.openchamber.id)
    expect(child.openchamber.name).toBe(pkg.openchamber.name)
    expect(child.openchamber.contributes.opencodePlugin).toBeUndefined()
  })

  test("the child extension has the same contributions as the root, with paths relative to extension/", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const child = await readJson<{ openchamber: { contributes: Record<string, any> } }>(join(ROOT, "extension/package.json"))
    const { opencodePlugin: _plugin, ...rootContributes } = pkg.openchamber.contributes
    const prefixed = JSON.parse(JSON.stringify(child.openchamber.contributes), (key, value) =>
      key === "entry" && typeof value === "string" ? `extension/${value}` : value,
    )
    expect(prefixed).toEqual(rootContributes)
  })

  test("every file that the child extension ships is also shipped by the root package", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    const child = await readJson<{ files: string[] }>(join(ROOT, "extension/package.json"))
    for (const file of child.files.filter((entry) => entry !== "package.json")) {
      expect(existsSync(join(ROOT, "extension", file))).toBe(true)
      expect(pkg.files).toContain(`extension/${file}`)
    }
  })

  test("the root package has no broad file globs", async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    for (const file of pkg.files) expect(file).not.toMatch(/\*/)
    expect(pkg.files).not.toContain("extension")
    expect(pkg.files).not.toContain("extension/panel")
    expect(pkg.files).not.toContain("extension/service")
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
  permissionHooks: string[]
  guardRuntime: Array<{ registered: boolean; coveredActions: string[]; storeState: string }>
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
// The guards need the permission host. The fake context leaves it out.
const permissionHooks = []
fake.ctx.permission = { hook: async (name) => (permissionHooks.push(name), { dispose: async () => {} }) }
const cleanup = await plugin.setup(fake.ctx)
fake.runProviderTransforms()
await new Promise((resolve) => setTimeout(resolve, 600))
const { readdir, readFile } = await import("node:fs/promises")
const runtimeDir = process.env.HOME + "/.td-opencode-plugin/guards/runtime"
const guardRuntime = []
for (const name of await readdir(runtimeDir).catch(() => [])) guardRuntime.push(JSON.parse(await readFile(runtimeDir + "/" + name, "utf8")))
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
  permissionHooks,
  guardRuntime: guardRuntime.map((report) => ({ registered: report.registered, coveredActions: report.coveredActions, storeState: report.storeState })),
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
      // The guards are separate from FueliX. They register the permission hook and write their own runtime report.
      expect(result.permissionHooks).toEqual(["evaluate"])
      expect(result.guardRuntime).toEqual([{ registered: true, coveredActions: ["shell", "subagent"], storeState: "missing" }])

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

  test("fuelix.statusReport false writes no FueliX status report", async () => {
    const { home: dir } = await run({ statusReport: false })
    try {
      // The guards keep their own files under `.td-opencode-plugin/guards`. Only the FueliX `status` folder must be absent.
      expect(existsSync(join(dir, ".td-opencode-plugin", "status"))).toBe(false)
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

// ---------------------------------------------------------------------------------------------------------------------
// Jev in the bundle
//
// The bundle and the source must behave the same. Every run uses a child process with a temporary HOME and XDG tree, a
// fake plugin context, fake keys, a `fetch` that records and answers every request itself, and no Keychain lookup. No
// OpenCode server starts, and no request leaves the machine.
// ---------------------------------------------------------------------------------------------------------------------

const FAKE_JEV_KEY = "ts-test-not-a-real-typesafe-key"
const FAKE_FUELIX_KEY = "sk-test-not-a-real-fuelix-key"
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** What the child process reports about one plugin run. Booleans stand for key checks, so no key is printed. */
interface JevRun {
  hookLabels: string[]
  disposedLabels: string[]
  shellHookCount: number
  typesafeMethods: Array<{ integrationID: string; method: { type: string; names?: string[]; label?: string } }>
  typesafeName: string | null
  providerIDs: string[]
  requests: Array<{ url: string; authorizationIsFakeJevKey: boolean; bodyHasKey: boolean; bodyHasCommand: boolean }>
  nonTypesafeRequests: number
  shellEnvAfter: string[]
  events: Record<string, { effect: string; hasMessage: boolean }>
  loadError: string | null
}

interface ChildResult {
  run: JevRun
  home: string
  stderr: string
}

/** Fakes for the hook hosts that `createFakeCtx` leaves out, and the script that runs one plugin entry. */
function childScript(entry: string, options: Record<string, unknown>, exercise: boolean): string {
  return `
const requests = []
let nonTypesafe = 0
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input)
  if (!url.startsWith("https://api.typesafe.ai/")) {
    nonTypesafe++
    return new Response("{}", { status: 503 })
  }
  const headers = new Headers(init && init.headers)
  const body = typeof (init && init.body) === "string" ? init.body : ""
  requests.push({
    url,
    authorizationIsFakeJevKey: headers.get("authorization") === "Bearer " + ${JSON.stringify(FAKE_JEV_KEY)},
    bodyHasKey: body.includes(${JSON.stringify(FAKE_JEV_KEY)}),
    bodyHasCommand: body.includes("npm test"),
  })
  const questions = JSON.parse(body).questions
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.9 }
    else if (question.type === "choice") answers[id] = { type: "choice", choice: Object.keys(question.criteria)[0] }
    else answers[id] = { type: "score", score: 0 }
  }
  return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status: 200, headers: { "content-type": "application/json" } })
}
const { default: plugin } = await import(${JSON.stringify(entry)})
const { createFakeCtx } = await import(${JSON.stringify(join(ROOT, "test/unit/fuelix/fake-ctx.ts"))})
const fake = createFakeCtx({ directory: ${JSON.stringify(LOCATION)} })
const callbacks = new Map()
const registered = []
const disposed = []
const host = (kind) => ({
  hook: async (name, callback) => {
    const label = kind + "." + name
    registered.push(label)
    callbacks.set(label, [...(callbacks.get(label) ?? []), callback])
    return { dispose: async () => void disposed.push(label) }
  },
})
fake.ctx.permission = host("permission")
fake.ctx.tool.hook = host("tool").hook
fake.ctx.model = { list: async () => ({ data: [] }) }
fake.ctx.options = ${JSON.stringify(options)}
let loadError = null
let cleanup = async () => {}
try {
  cleanup = await plugin.setup(fake.ctx)
} catch (error) {
  loadError = String(error && error.message)
}
fake.runProviderTransforms()
await new Promise((resolve) => setTimeout(resolve, 400))
const events = {}
// Hooks run in registration order, as OpenCode runs them. The guard hook registers last and only ever denies.
if (${JSON.stringify(exercise)} && callbacks.get("permission.evaluate")) {
  const before = callbacks.get("tool.execute.before")?.[0]
  const evaluate = async (event) => {
    for (const callback of callbacks.get("permission.evaluate")) await callback(event)
  }
  const exec = async (name, command) => {
    before?.({ tool: "shell", sessionID: "ses-1", id: "call-" + name, input: { command } })
    const event = { sessionID: "ses-1", action: "shell", resources: [command], source: { type: "tool", id: "call-" + name }, effect: "allow" }
    await evaluate(event)
    events[name] = { effect: event.effect, hasMessage: typeof event.message === "string" && event.message.length > 0 }
  }
  await exec("risky", "npm test")
  await exec("destructive", "rm -rf build")
}
const shellEnv = { TYPESAFE_API_KEY: ${JSON.stringify(FAKE_JEV_KEY)}, FUELIX_API_KEY: ${JSON.stringify(FAKE_FUELIX_KEY)}, PATH: "/usr/bin" }
for (const hook of fake.shellHooks) if (hook.name === "create.before") hook.callback({ env: shellEnv })
await cleanup()
const typesafeMethods = fake.integrationMethods.filter((method) => method.integrationID === "typesafe-ai")
console.log("RESULT " + JSON.stringify({
  hookLabels: registered.sort(),
  disposedLabels: disposed.sort(),
  shellHookCount: fake.shellHooks.length,
  typesafeMethods,
  typesafeName: fake.integrationNames.get("typesafe-ai") ?? null,
  providerIDs: [...fake.providers.keys()].sort(),
  requests,
  nonTypesafeRequests: nonTypesafe,
  shellEnvAfter: Object.keys(shellEnv).sort(),
  events,
  loadError,
}))
process.exit(0)
`
}

async function walkFiles(dir: string): Promise<string[]> {
  const { readdir, lstat } = await import("node:fs/promises")
  const out: string[] = []
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name)
    const stat = await lstat(path)
    if (stat.isDirectory()) out.push(...(await walkFiles(path)))
    else out.push(path)
  }
  return out
}

/** Replaces ISO timestamps, which differ between runs, so reports compare by content. */
function normalizeTimes(value: unknown): unknown {
  if (typeof value === "string") return ISO_TIME.test(value) ? "<time>" : value
  if (Array.isArray(value)) return value.map(normalizeTimes)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeTimes(item)]))
  }
  return value
}

describe("bundle and source behave the same with Jev", () => {
  let packageDir: string
  const bundleEntry = () => join(packageDir, "extension/plugin/index.js")
  const sourceEntry = join(ROOT, "src/index.ts")

  beforeAll(async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    packageDir = await mkdtemp(join(tmpdir(), "td-package-jev-"))
    for (const entry of [...pkg.files.filter((file) => file === "data" || file.startsWith("extension/plugin/")), "package.json"]) {
      await mkdir(dirname(join(packageDir, entry)), { recursive: true })
      await cp(join(ROOT, entry), join(packageDir, entry), { recursive: true })
    }
  })

  afterAll(async () => {
    await rm(packageDir, { recursive: true, force: true })
  })

  async function runEntry(entry: string, jev: Record<string, unknown> | undefined, exercise = false, env: Record<string, string> = {}): Promise<ChildResult> {
    const home = await mkdtemp(join(tmpdir(), "td-jev-home-"))
    const script = join(home, "run.mjs")
    const options = { fuelix: { keychainService: false, refreshMinutes: 0 }, ...(jev ? { jev } : {}) }
    await Bun.write(script, childScript(entry, options, exercise))
    // The fake Jev key sits in the environment, as a user's shell would provide it. A Jev that is off must ignore it.
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      TYPESAFE_API_KEY: FAKE_JEV_KEY,
      ...env,
    }
    const child = Bun.spawn([process.execPath, script], { env: childEnv, cwd: home, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`child exited with ${code}: ${stderr}`)
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
    if (!line) throw new Error(`child printed no result: ${stdout}${stderr}`)
    return { run: JSON.parse(line.slice("RESULT ".length)) as JevRun, home, stderr }
  }

  const reportOf = async (home: string): Promise<unknown> =>
    normalizeTimes(await readJson(join(home, ".td-opencode-plugin", "status", statusFileName(LOCATION))))

  const cleanup = async (...results: ChildResult[]) => {
    for (const result of results) await rm(result.home, { recursive: true, force: true })
  }

  test("Jev off (the default): no TypeSafe request, no key use, no Jev hook, integration, or files", async () => {
    const bundle = await runEntry(bundleEntry(), undefined, true)
    const source = await runEntry(sourceEntry, undefined, true)
    try {
      for (const { run, home, stderr } of [bundle, source]) {
        expect(run.loadError).toBeNull()
        expect(run.requests).toEqual([])
        expect(run.typesafeMethods).toEqual([])
        expect(run.typesafeName).toBeNull()
        // Only the TD-Plugin guard hook is registered. With no active guard it leaves the permission effect as it was.
        expect(run.hookLabels).toEqual(["permission.evaluate"])
        expect(run.events).toEqual({
          risky: { effect: "allow", hasMessage: false },
          destructive: { effect: "allow", hasMessage: false },
        })
        // The agent shell keeps TYPESAFE_API_KEY, which Jev does not manage when it is off. FueliX still removes its own key.
        expect(run.shellEnvAfter).toEqual(["PATH", "TYPESAFE_API_KEY"])
        expect(existsSync(join(home, "data", "td-opencode-plugin"))).toBe(false)
        expect(stderr).not.toContain(FAKE_JEV_KEY)
        expect(stderr.toLowerCase()).not.toContain("jev enabled")
      }
      expect(bundle.run.providerIDs).toEqual(["fuelix", "fuelix-anthropic", "fuelix-openai"])
      expect(bundle.run.providerIDs).toEqual(source.run.providerIDs)
      expect(bundle.run.shellHookCount).toBe(source.run.shellHookCount)
    } finally {
      await cleanup(bundle, source)
    }
  }, 60_000)

  test("an explicit enabled false is the same as no jev block", async () => {
    const result = await runEntry(bundleEntry(), { enabled: false, model: "jev-1.14.0" }, true)
    try {
      expect(result.run.requests).toEqual([])
      expect(result.run.hookLabels).toEqual(["permission.evaluate"])
      expect(result.run.typesafeMethods).toEqual([])
      expect(existsSync(join(result.home, "data", "td-opencode-plugin"))).toBe(false)
    } finally {
      await cleanup(result)
    }
  }, 30_000)

  test("the FueliX status report is identical with Jev off, with Jev on, and from the source", async () => {
    const jev = { enabled: true, model: "jev-1.14.0", keychainService: false, telemetry: false }
    const bundleOff = await runEntry(bundleEntry(), undefined)
    const sourceOff = await runEntry(sourceEntry, undefined)
    const bundleOn = await runEntry(bundleEntry(), jev)
    const sourceOn = await runEntry(sourceEntry, jev)
    try {
      const reports = await Promise.all([bundleOff, sourceOff, bundleOn, sourceOn].map((item) => reportOf(item.home)))
      const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
      expect((reports[0] as { pluginVersion: string }).pluginVersion).toBe(pkg.version)
      for (const report of reports.slice(1)) expect(report).toEqual(reports[0])
      for (const report of reports) {
        const text = JSON.stringify(report)
        expect(text).not.toContain(FAKE_JEV_KEY)
        expect(text).not.toContain(FAKE_FUELIX_KEY)
        expect(text.toLowerCase()).not.toContain("typesafe")
      }
      // The bundle needs the catalog schema and source labels that the report carries.
      const report = reports[0] as { models: { source: string }; configuration: { authSource: string } }
      expect(report.models.source).toBe("catalog")
      expect(report.configuration.authSource).toBe("none")
    } finally {
      await cleanup(bundleOff, sourceOff, bundleOn, sourceOn)
    }
  }, 120_000)

  test("custom Jev 1.14.0 config in the bundle registers the integration, the V2 hooks, and the env scrub", async () => {
    const jev = { enabled: true, model: "jev-1.14.0", keychainService: false }
    const bundle = await runEntry(bundleEntry(), jev, true)
    const source = await runEntry(sourceEntry, jev, true)
    try {
      for (const { run, home, stderr } of [bundle, source]) {
        expect(run.loadError).toBeNull()
        // The TypeSafe integration for /connect: one key method and one environment method.
        expect(run.typesafeMethods).toEqual([
          { integrationID: "typesafe-ai", method: { type: "key", label: "TypeSafe API key" } },
          { integrationID: "typesafe-ai", method: { type: "env", names: ["TYPESAFE_API_KEY"] } },
        ])
        expect(run.typesafeName).toBe("TypeSafe")
        // The default points (safety and test output) register their V2 hooks. Skill and reasoning stay off.
        // The second `permission.evaluate` is the TD-Plugin guard hook.
        expect(run.hookLabels).toEqual([
          "permission.evaluate",
          "permission.evaluate",
          "tool.execute.after",
          "tool.execute.after",
          "tool.execute.before",
        ])
        // The shell scrub removes both keys: the FueliX hook and the Jev hook each remove their own.
        expect(run.shellEnvAfter).toEqual(["PATH"])
        // Cleanup disposes every hook.
        expect(run.disposedLabels).toEqual(run.hookLabels)
        expect(stderr).not.toContain(FAKE_JEV_KEY)
        expect(stderr).not.toContain(FAKE_FUELIX_KEY)
        expect(home).toBeTruthy()
      }
      expect(bundle.run.hookLabels).toEqual(source.run.hookLabels)
      expect(bundle.run.shellHookCount).toBe(source.run.shellHookCount)
      expect(bundle.run.shellHookCount).toBeGreaterThan(0)
    } finally {
      await cleanup(bundle, source)
    }
  }, 60_000)

  test("scrubShellEnv false keeps TYPESAFE_API_KEY in the agent shell", async () => {
    const result = await runEntry(bundleEntry(), { enabled: true, keychainService: false, scrubShellEnv: false }, false)
    try {
      expect(result.run.shellEnvAfter).toEqual(["PATH", "TYPESAFE_API_KEY"])
      expect(result.run.typesafeMethods.length).toBe(2)
    } finally {
      await cleanup(result)
    }
  }, 30_000)

  test("the bundled safety hook uses the key only in the Authorization header, and writes only to the protected root", async () => {
    const jev = { enabled: true, model: "jev-1.14.0", keychainService: false, telemetry: true }
    const bundle = await runEntry(bundleEntry(), jev, true)
    try {
      const { run, home, stderr } = bundle
      expect(run.loadError).toBeNull()
      // `npm test` is neither destructive nor read-only, so it reaches TypeSafe. `rm -rf build` is vetoed without a request.
      expect(run.requests).toEqual([{ url: "https://api.typesafe.ai/v1/systemone", authorizationIsFakeJevKey: true, bodyHasKey: false, bodyHasCommand: true }])
      expect(run.events.risky).toEqual({ effect: "ask", hasMessage: true })
      expect(run.events.destructive).toEqual({ effect: "ask", hasMessage: true })
      // The key came from the environment, and no other request carried or needed it.
      expect(run.nonTypesafeRequests).toBe(0)

      const root = join(home, "data", "td-opencode-plugin", "jev")
      const { lstat } = await import("node:fs/promises")
      expect((await lstat(root)).mode & 0o777).toBe(0o700)
      const telemetry = join(root, "telemetry.jsonl")
      expect((await lstat(telemetry)).mode & 0o777).toBe(0o600)
      const rows = (await readFile(telemetry, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(rows.every((row) => row.point === "safetyPreCheck")).toBe(true)

      // No fake key, command text, or raw session ID anywhere under the isolated home, and none in the plugin log.
      for (const file of await walkFiles(home)) {
        if (file.endsWith("run.mjs")) continue
        const text = await readFile(file, "utf8").catch(() => "")
        for (const needle of [FAKE_JEV_KEY, FAKE_FUELIX_KEY, "npm test", "rm -rf", "ses-1"]) {
          expect(`${file}:${text.includes(needle)}`).toBe(`${file}:false`)
        }
      }
      expect(stderr).not.toContain(FAKE_JEV_KEY)
      expect(stderr).toContain("Jev enabled")
    } finally {
      await cleanup(bundle)
    }
  }, 60_000)

  test("a custom TypeSafe URL in project options is ignored without the server flag", async () => {
    const jev = { enabled: true, keychainService: false, baseURL: "https://evil.example.com" }
    const result = await runEntry(bundleEntry(), jev, true)
    try {
      expect(result.run.requests.every((request) => request.url.startsWith("https://api.typesafe.ai/"))).toBe(true)
      expect(result.run.nonTypesafeRequests).toBe(0)
      expect(result.stderr).toContain("options.jev.baseURL is ignored")
    } finally {
      await cleanup(result)
    }
  }, 30_000)

  test("the Keychain service of FueliX is never accepted for TypeSafe", async () => {
    const jev = { enabled: true, keychainService: "fuelix-api-key" }
    const result = await runEntry(bundleEntry(), jev, false)
    try {
      // The FueliX no-key warning names its own service. Only the Jev warning is checked here.
      const warning = result.stderr.split("\n").find((line) => line.includes("options.jev.keychainService"))
      expect(warning).toBeDefined()
      expect(warning).not.toContain("fuelix-api-key")
    } finally {
      await cleanup(result)
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------------------------------------------------
// Guards first, then Jev
//
// A real guard store (valid, in a temporary HOME) is active. TypeSafe is a fake `fetch` that rates every command that
// reaches it as risky (`noul` 0.9, above the default threshold). `session.get` is a stub that answers the parent of
// each session, so the guard resolves the session tree and does not fail closed. The same scenarios run against the
// source and against the generated bundle in the shipped layout.
// ---------------------------------------------------------------------------------------------------------------------

const GUARD_MESSAGE = "Guard test message: commits are blocked in this session tree."
const GUARDED_ROOT = "root-ses"
const GUARDED_CHILD = "child-ses"
const UNGUARDED_SESSION = "other-ses"

interface ScenarioResult {
  effect: string
  message: string | null
  upstreamCalls: number
}

interface GuardedRun {
  registrationOrder: string[]
  permissionHandlers: number
  firstAloneGuarded: ScenarioResult
  firstAloneUnguarded: ScenarioResult
  chainGuardedAllow: ScenarioResult
  chainGuardedAsk: ScenarioResult
  chainUnguardedRisky: ScenarioResult
  chainDestructive: ScenarioResult
  chainGuardedUpstream503: ScenarioResult
  chainUnguardedUpstream503: ScenarioResult
  loadError: string | null
  nonTypesafeRequests: number
  runtime: Array<{ registered: boolean; storeState: string }>
}

function guardedScript(entry: string, options: Record<string, unknown>): string {
  return `
const requests = []
let nonTypesafe = 0
let upstream = "ok"
globalThis.fetch = async (input, init) => {
  const url = String(input && input.url ? input.url : input)
  if (!url.startsWith("https://api.typesafe.ai/")) {
    nonTypesafe++
    return new Response("{}", { status: 503 })
  }
  requests.push(url)
  if (upstream === "503") return new Response("{}", { status: 503 })
  const questions = JSON.parse(typeof (init && init.body) === "string" ? init.body : "{}").questions
  const answers = {}
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.9 }
    else if (question.type === "choice") answers[id] = { type: "choice", choice: Object.keys(question.criteria)[0] }
    else answers[id] = { type: "score", score: 0 }
  }
  return new Response(JSON.stringify({ model: "jev-1.14.0", answers }), { status: 200, headers: { "content-type": "application/json" } })
}
const { default: plugin } = await import(${JSON.stringify(entry)})
const { createFakeCtx } = await import(${JSON.stringify(join(ROOT, "test/unit/fuelix/fake-ctx.ts"))})
const fake = createFakeCtx({ directory: ${JSON.stringify(LOCATION)} })
const callbacks = new Map()
const order = []
const host = (kind) => ({
  hook: async (name, callback) => {
    const label = kind + "." + name
    order.push(label)
    callbacks.set(label, [...(callbacks.get(label) ?? []), callback])
    return { dispose: async () => {} }
  },
})
const parents = { ${JSON.stringify(GUARDED_ROOT)}: null, ${JSON.stringify(GUARDED_CHILD)}: ${JSON.stringify(GUARDED_ROOT)}, ${JSON.stringify(UNGUARDED_SESSION)}: null }
fake.ctx.session = {
  ...fake.ctx.session,
  get: async ({ sessionID }) => (sessionID in parents ? { data: { id: sessionID, parentID: parents[sessionID] } } : { error: { name: "NotFound" } }),
}
fake.ctx.permission = host("permission")
fake.ctx.tool.hook = host("tool").hook
fake.ctx.model = { list: async () => ({ data: [] }) }
fake.ctx.options = ${JSON.stringify(options)}
let loadError = null
let cleanup = async () => {}
try {
  cleanup = await plugin.setup(fake.ctx)
} catch (error) {
  loadError = String(error && error.message)
}
fake.runProviderTransforms()
await new Promise((resolve) => setTimeout(resolve, 400))
const evaluators = callbacks.get("permission.evaluate") ?? []
const before = callbacks.get("tool.execute.before")?.[0]
let counter = 0
const scenario = async (sessionID, command, effect, firstOnly) => {
  const id = "call-" + ++counter
  before?.({ tool: "shell", sessionID, id, input: { command } })
  const event = { sessionID, action: "shell", resources: [command], source: { type: "tool", id }, effect }
  const calls = requests.length
  for (const callback of firstOnly ? evaluators.slice(0, 1) : evaluators) await callback(event)
  return { effect: event.effect, message: typeof event.message === "string" ? event.message : null, upstreamCalls: requests.length - calls }
}
const firstAloneGuarded = await scenario(${JSON.stringify(GUARDED_CHILD)}, "git commit -m x", "allow", true)
const firstAloneUnguarded = await scenario(${JSON.stringify(UNGUARDED_SESSION)}, "git commit -m x", "allow", true)
const chainGuardedAllow = await scenario(${JSON.stringify(GUARDED_CHILD)}, "git commit -m x", "allow", false)
const chainGuardedAsk = await scenario(${JSON.stringify(GUARDED_ROOT)}, "git commit -m x", "ask", false)
const chainUnguardedRisky = await scenario(${JSON.stringify(UNGUARDED_SESSION)}, "npm test", "allow", false)
const chainDestructive = await scenario(${JSON.stringify(UNGUARDED_SESSION)}, "rm -rf build", "allow", false)
upstream = "503"
const chainGuardedUpstream503 = await scenario(${JSON.stringify(GUARDED_CHILD)}, "git commit -m y", "allow", false)
const chainUnguardedUpstream503 = await scenario(${JSON.stringify(UNGUARDED_SESSION)}, "npm test", "allow", false)
const { readdir, readFile } = await import("node:fs/promises")
const runtimeDir = process.env.HOME + "/.td-opencode-plugin/guards/runtime"
const runtime = []
// The reporter writes through a temporary file and renames it, so read finished reports only.
for (const name of (await readdir(runtimeDir).catch(() => [])).filter((entry) => entry.endsWith(".json"))) {
  const report = JSON.parse(await readFile(runtimeDir + "/" + name, "utf8"))
  runtime.push({ registered: report.registered, storeState: report.storeState })
}
await cleanup()
console.log("RESULT " + JSON.stringify({
  registrationOrder: order,
  permissionHandlers: evaluators.length,
  firstAloneGuarded,
  firstAloneUnguarded,
  chainGuardedAllow,
  chainGuardedAsk,
  chainUnguardedRisky,
  chainDestructive,
  chainGuardedUpstream503,
  chainUnguardedUpstream503,
  loadError,
  nonTypesafeRequests: nonTypesafe,
  runtime,
}))
process.exit(0)
`
}

describe("guards run before Jev, in the source and in the bundle", () => {
  let packageDir: string
  const bundleEntry = () => join(packageDir, "extension/plugin/index.js")
  const sourceEntry = join(ROOT, "src/index.ts")

  beforeAll(async () => {
    const pkg = await readJson<RootManifest>(join(ROOT, "package.json"))
    packageDir = await mkdtemp(join(tmpdir(), "td-package-guards-"))
    for (const entry of [...pkg.files.filter((file) => file === "data" || file.startsWith("extension/plugin/")), "package.json"]) {
      await mkdir(dirname(join(packageDir, entry)), { recursive: true })
      await cp(join(ROOT, entry), join(packageDir, entry), { recursive: true })
    }
  })

  afterAll(async () => {
    await rm(packageDir, { recursive: true, force: true })
  })

  async function runGuarded(entry: string, jev: Record<string, unknown> | undefined): Promise<ChildResult & { guarded: GuardedRun }> {
    const home = await mkdtemp(join(tmpdir(), "td-guarded-home-"))
    const guardsDir = join(home, ".td-opencode-plugin", "guards")
    await mkdir(guardsDir, { recursive: true })
    const stamp = "2026-11-12T10:00:00.000Z"
    await Bun.write(
      join(guardsDir, "store.json"),
      JSON.stringify({
        schema: "td-guards/1",
        revision: 1,
        guards: [
          {
            id: "no-commit",
            label: "No commit",
            summary: "Blocks git commit.",
            request: "Do not commit.",
            message: GUARD_MESSAGE,
            rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        activations: [{ id: "act-1", guardId: "no-commit", sessionId: GUARDED_ROOT, scope: "session", createdAt: stamp, expiresAt: null }],
      }),
    )
    const script = join(home, "run.mjs")
    // Fake keys only, no Keychain lookup (`keychainService: false` for FueliX and Jev), no network.
    const options = { fuelix: { keychainService: false, refreshMinutes: 0 }, ...(jev ? { jev } : {}) }
    await Bun.write(script, guardedScript(entry, options))
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_CACHE_HOME: join(home, "cache"),
      TYPESAFE_API_KEY: FAKE_JEV_KEY,
    }
    const child = Bun.spawn([process.execPath, script], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(`child exited with ${code}: ${stderr}`)
    const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
    if (!line) throw new Error(`child printed no result: ${stdout}${stderr}`)
    return { guarded: JSON.parse(line.slice("RESULT ".length)) as GuardedRun, run: undefined as unknown as JevRun, home, stderr }
  }

  const jevOn = { enabled: true, model: "jev-1.14.0", keychainService: false, telemetry: false }
  const cleanup = async (...results: Array<{ home: string }>) => {
    for (const result of results) await rm(result.home, { recursive: true, force: true })
  }

  for (const [label, entry] of [
    ["bundle", () => bundleEntry()],
    ["source", () => sourceEntry],
  ] as const) {
    test(`${label}: the guard hook is first and denies a guarded command alone, without a TypeSafe call`, async () => {
      const result = await runGuarded(entry(), jevOn)
      try {
        const { guarded } = result
        expect(guarded.loadError).toBeNull()
        // Order of registration, not sorted: the guard hook comes first, and Jev adds one more permission hook.
        expect(guarded.registrationOrder[0]).toBe("permission.evaluate")
        expect(guarded.registrationOrder.filter((name) => name === "permission.evaluate")).toHaveLength(2)
        expect(guarded.permissionHandlers).toBe(2)
        expect(guarded.runtime).toEqual([{ registered: true, storeState: "ready" }])
        // The first callback alone is the guard: it denies a guarded child session with the exact guard message
        // (not the fail-closed text), and it leaves an unrelated session alone.
        expect(guarded.firstAloneGuarded).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        expect(guarded.firstAloneUnguarded).toEqual({ effect: "allow", message: null, upstreamCalls: 0 })
      } finally {
        await cleanup(result)
      }
    }, 60_000)

    test(`${label}: through the full hook chain a guard deny survives Jev, and Jev still asks for unguarded risky commands`, async () => {
      const result = await runGuarded(entry(), jevOn)
      try {
        const { guarded } = result
        // Guarded command with an incoming `allow` or `ask`: deny with the guard message, and no TypeSafe call.
        expect(guarded.chainGuardedAllow).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        expect(guarded.chainGuardedAsk).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        // Unguarded `npm test` is risky (0.9): one TypeSafe call, and the effect becomes `ask`.
        expect(guarded.chainUnguardedRisky.effect).toBe("ask")
        expect(guarded.chainUnguardedRisky.upstreamCalls).toBe(1)
        expect(guarded.chainUnguardedRisky.message).not.toBe(GUARD_MESSAGE)
        // `rm -rf build` is deterministic: `ask` with no TypeSafe call.
        expect(guarded.chainDestructive.effect).toBe("ask")
        expect(guarded.chainDestructive.upstreamCalls).toBe(0)
        // TypeSafe answers 503: a guarded command stays denied with the guard message and makes no call.
        expect(guarded.chainGuardedUpstream503).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        // An unguarded command never receives the guard text.
        expect(guarded.chainUnguardedUpstream503.message).not.toBe(GUARD_MESSAGE)
        expect(guarded.nonTypesafeRequests).toBe(0)
        expect(result.stderr).not.toContain(FAKE_JEV_KEY)
        for (const file of await walkFiles(result.home)) {
          // The run script holds the commands, and the Bun cache (`cache/`) holds transpiled plugin source.
          if (file.endsWith("run.mjs") || file.startsWith(join(result.home, "cache"))) continue
          const text = await readFile(file, "utf8").catch(() => "")
          for (const needle of [FAKE_JEV_KEY, FAKE_FUELIX_KEY, "npm test", "rm -rf"]) {
            expect(`${file}:${text.includes(needle)}`).toBe(`${file}:false`)
          }
        }
      } finally {
        await cleanup(result)
      }
    }, 60_000)

    test(`${label}: with Jev off one guard handler is registered and still denies the guarded command`, async () => {
      const result = await runGuarded(entry(), undefined)
      try {
        const { guarded } = result
        expect(guarded.registrationOrder).toEqual(["permission.evaluate"])
        expect(guarded.permissionHandlers).toBe(1)
        expect(guarded.chainGuardedAllow).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        expect(guarded.chainGuardedAsk).toEqual({ effect: "deny", message: GUARD_MESSAGE, upstreamCalls: 0 })
        expect(guarded.chainUnguardedRisky).toEqual({ effect: "allow", message: null, upstreamCalls: 0 })
      } finally {
        await cleanup(result)
      }
    }, 60_000)
  }
})
