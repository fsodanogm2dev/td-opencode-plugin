import { readdir, stat } from "node:fs/promises"
import { homedir as osHomedir } from "node:os"
import path from "node:path"
import type { RunProcess } from "./process.ts"

export interface LocateFs {
  readdir(dir: string): Promise<string[]>
  exists(file: string): Promise<boolean>
}

export const defaultLocateFs: LocateFs = {
  async readdir(dir) {
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  },
  async exists(file) {
    try {
      await stat(file)
      return true
    } catch {
      return false
    }
  },
}

const REQUIRED_FILES = [path.join("scripts", "hook-record-feature.mjs"), path.join("lib", "process-manager.mjs")]

export type Semver = readonly [number, number, number]

export function parseSemver(text: string): { version: Semver; prerelease: boolean } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return undefined
  return { version: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined }
}

/** Positive when `a` is newer than `b`. A release is newer than a prerelease of the same version. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index++) {
    const diff = (left.version[index] as number) - (right.version[index] as number)
    if (diff !== 0) return diff
  }
  return Number(left.prerelease) * -1 - Number(right.prerelease) * -1
}

async function hasRequiredFiles(root: string, fs: LocateFs): Promise<boolean> {
  for (const file of REQUIRED_FILES) {
    if (!(await fs.exists(path.join(root, file)))) return false
  }
  return true
}

export type LocateResult = { readonly root: string } | { readonly root: undefined; readonly reason: string }

export interface LocateOptions {
  readonly explicitRoot?: string | undefined
  readonly homedir?: string
  readonly fs?: LocateFs
}

/** Finds the td-telemetry installation: the explicit root, else the newest copy in the Claude Code plugin cache. */
export async function locateRoot(options: LocateOptions): Promise<LocateResult> {
  const fs = options.fs ?? defaultLocateFs
  if (options.explicitRoot) {
    if (await hasRequiredFiles(options.explicitRoot, fs)) return { root: options.explicitRoot }
    return { root: undefined, reason: "the configured td-telemetry root has no hook scripts" }
  }
  const home = options.homedir ?? osHomedir()
  const cache = path.join(home, ".claude", "plugins", "cache")
  const candidates: Array<{ dir: string; version: string }> = []
  for (const marketplace of await fs.readdir(cache)) {
    const base = path.join(cache, marketplace, "td-telemetry")
    for (const version of await fs.readdir(base)) {
      if (parseSemver(version)) candidates.push({ dir: path.join(base, version), version })
    }
  }
  candidates.sort((a, b) => compareSemver(b.version, a.version))
  for (const candidate of candidates) {
    if (await hasRequiredFiles(candidate.dir, fs)) return { root: candidate.dir }
  }
  return { root: undefined, reason: "no td-telemetry installation found" }
}

export const MIN_NODE: Semver = [22, 5, 0]

export function nodeVersionSupported(output: string): boolean {
  const parsed = parseSemver(output.trim())
  if (!parsed) return false
  for (let index = 0; index < 3; index++) {
    const have = parsed.version[index] as number
    const need = MIN_NODE[index] as number
    if (have !== need) return have > need
  }
  return true
}

/** Runs `<node> --version` once. */
export async function checkNode(
  run: RunProcess,
  node: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<{ ok: boolean; detail: string }> {
  const result = await run(node, ["--version"], { timeoutMs: 5000, ...(env ? { env } : {}) })
  if (result.code !== 0) return { ok: false, detail: result.error ?? "node --version failed" }
  const version = result.stdout.trim()
  return nodeVersionSupported(version)
    ? { ok: true, detail: version }
    : { ok: false, detail: `${version || "unknown version"} (need 22.5 or later)` }
}

export const NODE_FALLBACKS: readonly string[] = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]

export interface ResolvedNode {
  readonly ok: boolean
  /** The executable to use. Empty when none qualifies. */
  readonly node: string
  readonly detail: string
}

/**
 * Finds a Node.js executable of version 22.5 or later. A configured path other than the default "node" is checked
 * alone. For the default, `node` on PATH is tried first, then the common install locations of Homebrew.
 */
export async function resolveNode(
  run: RunProcess,
  configured: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<ResolvedNode> {
  const candidates = configured === "node" ? ["node", ...NODE_FALLBACKS] : [configured]
  const failures: string[] = []
  for (const candidate of candidates) {
    const result = await checkNode(run, candidate, env)
    if (result.ok) return { ok: true, node: candidate, detail: result.detail }
    failures.push(`${candidate}: ${result.detail}`)
  }
  return { ok: false, node: "", detail: failures.join("; ") }
}
