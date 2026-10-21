import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  checkNode,
  compareSemver,
  locateRoot,
  MIN_TD_TELEMETRY,
  nodeVersionSupported,
  readTdTelemetryVersion,
  resolveNode,
  tdTelemetryVersionSupported,
} from "../../../src/telemetry/locate.ts"
import type { LocateFs } from "../../../src/telemetry/locate.ts"
import type { RunProcess } from "../../../src/telemetry/process.ts"

let home: string
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "td-locate-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function install(market: string, version: string, complete = true): string {
  const root = path.join(home, ".claude", "plugins", "cache", market, "td-telemetry", version)
  mkdirSync(path.join(root, "scripts"), { recursive: true })
  mkdirSync(path.join(root, "lib"), { recursive: true })
  writeFileSync(path.join(root, "scripts", "hook-record-feature.mjs"), "")
  if (complete) writeFileSync(path.join(root, "lib", "process-manager.mjs"), "")
  return root
}

describe("locateRoot", () => {
  test("picks the newest semver, compared numerically", async () => {
    install("mk", "0.9.0")
    install("mk", "0.10.2")
    const newest = install("other", "0.10.10")
    install("mk", "0.10.9")
    expect(await locateRoot({ homedir: home })).toEqual({ root: newest })
  })

  test("a release is newer than its prerelease", () => {
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0)
    expect(compareSemver("1.2.0", "1.10.0")).toBeLessThan(0)
  })

  test("skips a copy without the required files", async () => {
    install("mk", "1.0.0")
    install("mk", "2.0.0", false)
    expect(await locateRoot({ homedir: home })).toEqual({ root: path.join(home, ".claude", "plugins", "cache", "mk", "td-telemetry", "1.0.0") })
  })

  test("ignores directories that are not semver", async () => {
    install("mk", "latest")
    expect((await locateRoot({ homedir: home })).root).toBeUndefined()
  })

  test("returns no root when nothing is installed", async () => {
    const result = await locateRoot({ homedir: home })
    expect(result.root).toBeUndefined()
  })

  test("an explicit root wins when it has the scripts", async () => {
    install("mk", "9.0.0")
    const explicit = path.join(home, "custom")
    mkdirSync(path.join(explicit, "scripts"), { recursive: true })
    mkdirSync(path.join(explicit, "lib"), { recursive: true })
    writeFileSync(path.join(explicit, "scripts", "hook-record-feature.mjs"), "")
    writeFileSync(path.join(explicit, "lib", "process-manager.mjs"), "")
    expect(await locateRoot({ explicitRoot: explicit, homedir: home })).toEqual({ root: explicit })
  })

  test("an explicit root without scripts is not replaced by the cache", async () => {
    install("mk", "9.0.0")
    const result = await locateRoot({ explicitRoot: path.join(home, "missing"), homedir: home })
    expect(result.root).toBeUndefined()
  })
})

describe("td-telemetry version", () => {
  test("the minimum is 0.26.0, the first version that stores tool_decision", () => {
    expect(MIN_TD_TELEMETRY).toBe("0.26.0")
  })

  test("accepts the minimum and later versions", () => {
    for (const version of ["0.26.0", "0.26.1", "0.27.13", "1.0.0", "v0.26.0", "0.26.0+build.7"]) {
      expect([version, tdTelemetryVersionSupported(version)]).toEqual([version, true])
    }
  })

  test("rejects older versions", () => {
    for (const version of ["0.25.2", "0.25.99", "0.22.5", "0.9.0"]) {
      expect([version, tdTelemetryVersionSupported(version)]).toEqual([version, false])
    }
  })

  test("a prerelease of the minimum is older than the minimum; a prerelease of a later version is newer", () => {
    expect(tdTelemetryVersionSupported("0.26.0-rc.1")).toBe(false)
    expect(tdTelemetryVersionSupported("0.25.3-rc.1")).toBe(false)
    expect(tdTelemetryVersionSupported("0.26.1-rc.1")).toBe(true)
    expect(tdTelemetryVersionSupported("0.27.0-beta.2")).toBe(true)
  })

  test("rejects a missing or non-semver version", () => {
    for (const version of [undefined, "", "dev", "0.26", "latest"]) {
      expect([version, tdTelemetryVersionSupported(version)]).toEqual([version, false])
    }
  })
})

describe("readTdTelemetryVersion", () => {
  function writeManifest(content: string): string {
    const root = path.join(home, "td")
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, "package.json"), content)
    return root
  }

  test("reads version from package.json at the root", async () => {
    expect(await readTdTelemetryVersion(writeManifest(JSON.stringify({ name: "td-telemetry", version: "0.27.13" })))).toBe("0.27.13")
    expect(await readTdTelemetryVersion(writeManifest(JSON.stringify({ version: " 0.26.0\n" })))).toBe("0.26.0")
  })

  test("returns a version that is not semver as written; the gate rejects it", async () => {
    const version = await readTdTelemetryVersion(writeManifest(JSON.stringify({ version: "dev" })))
    expect(version).toBe("dev")
    expect(tdTelemetryVersionSupported(version)).toBe(false)
  })

  test("returns undefined when package.json is missing", async () => {
    expect(await readTdTelemetryVersion(path.join(home, "missing"))).toBeUndefined()
  })

  test("returns undefined when package.json is not valid JSON or has no string version", async () => {
    for (const content of ["{ not json", "null", "[]", '"0.26.0"', "{}", '{"version":26}', '{"version":""}', '{"version":null}']) {
      expect([content, await readTdTelemetryVersion(writeManifest(content))]).toEqual([content, undefined])
    }
  })

  test("returns undefined when the file system throws", async () => {
    const fs: LocateFs = {
      readdir: async () => [],
      exists: async () => true,
      readFile: async () => {
        throw new Error("EACCES")
      },
    }
    expect(await readTdTelemetryVersion("/td", fs)).toBeUndefined()
  })

  test("reads through the given file system", async () => {
    const read: string[] = []
    const fs: LocateFs = {
      readdir: async () => [],
      exists: async () => true,
      readFile: async (file) => {
        read.push(file)
        return JSON.stringify({ version: "0.26.0" })
      },
    }
    expect(await readTdTelemetryVersion("/td", fs)).toBe("0.26.0")
    expect(read).toEqual([path.join("/td", "package.json")])
  })
})

describe("node version", () => {
  test("accepts 22.5 and later", () => {
    expect(nodeVersionSupported("v22.5.0\n")).toBe(true)
    expect(nodeVersionSupported("v22.4.9")).toBe(false)
    expect(nodeVersionSupported("v26.8.1")).toBe(true)
    expect(nodeVersionSupported("v20.11.0")).toBe(false)
    expect(nodeVersionSupported("garbage")).toBe(false)
  })

  test("checkNode runs node --version", async () => {
    const calls: unknown[] = []
    const run: RunProcess = async (command, args) => {
      calls.push([command, args])
      return { code: 0, stdout: "v22.12.0\n", timedOut: false }
    }
    expect((await checkNode(run, "node")).ok).toBe(true)
    expect(calls).toEqual([["node", ["--version"]]])
    expect((await checkNode(async () => ({ code: null, stdout: "", timedOut: false, error: "ENOENT" }), "node")).ok).toBe(false)
    expect((await checkNode(async () => ({ code: 0, stdout: "v18.0.0", timedOut: false }), "node")).ok).toBe(false)
  })
})

describe("resolveNode", () => {
  /** A fake runner. `versions` maps an executable to the output of `--version` (missing means ENOENT). */
  function runner(versions: Record<string, string>) {
    const tried: string[] = []
    const run: RunProcess = async (command) => {
      tried.push(command)
      const out = versions[command]
      return out === undefined ? { code: null, stdout: "", timedOut: false, error: "ENOENT" } : { code: 0, stdout: `${out}\n`, timedOut: false }
    }
    return { run, tried }
  }

  test("uses node on PATH first", async () => {
    const { run, tried } = runner({ node: "v22.12.0", "/opt/homebrew/bin/node": "v24.0.0" })
    expect(await resolveNode(run, "node")).toMatchObject({ ok: true, node: "node" })
    expect(tried).toEqual(["node"])
  })

  test("falls back to the Homebrew locations when PATH node is too old or missing", async () => {
    const old = runner({ node: "v20.1.0", "/opt/homebrew/bin/node": "v22.6.0" })
    expect(await resolveNode(old.run, "node")).toMatchObject({ ok: true, node: "/opt/homebrew/bin/node" })
    expect(old.tried).toEqual(["node", "/opt/homebrew/bin/node"])
    const missing = runner({ "/usr/local/bin/node": "v23.0.0" })
    expect(await resolveNode(missing.run, "node")).toMatchObject({ ok: true, node: "/usr/local/bin/node" })
    expect(missing.tried).toEqual(["node", "/opt/homebrew/bin/node", "/usr/local/bin/node"])
  })

  test("a configured path is checked alone", async () => {
    const { run, tried } = runner({ "/custom/node": "v21.0.0", node: "v22.12.0" })
    const result = await resolveNode(run, "/custom/node")
    expect(result.ok).toBe(false)
    expect(tried).toEqual(["/custom/node"])
  })

  test("reports every failure when none qualifies", async () => {
    const { run } = runner({})
    const result = await resolveNode(run, "node")
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("/opt/homebrew/bin/node")
    expect(result.detail).toContain("/usr/local/bin/node")
  })
})
