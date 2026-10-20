import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkNode, compareSemver, locateRoot, nodeVersionSupported } from "../../../src/telemetry/locate.ts"
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
