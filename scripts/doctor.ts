/**
 * Compare the live FueliX `/v1/models` list with `data/fuelix-models.json`.
 *
 *   bun scripts/doctor.ts [--json] [--strict] [--catalog <path>] [--base-url <url>]
 *
 * Key order: `FUELIX_API_KEY`, then the macOS Keychain item `fuelix-api-key`. The script prints which source it used
 * and never prints the key.
 */

import type { Catalog } from "../src/fuelix/catalog-types.ts"
import { parseArgs } from "./lib/args.ts"
import { buildReport, formatReport, isFailing } from "./lib/doctor-report.ts"
import { parseIds } from "./lib/ids.ts"

async function keychainKey(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "fuelix-api-key", "-w"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const text = (await new Response(proc.stdout).text()).trim()
    return (await proc.exited) === 0 && text ? text : undefined
  } catch {
    return undefined
  }
}

async function resolveKey(): Promise<{ key: string; source: string } | undefined> {
  const env = process.env.FUELIX_API_KEY?.trim()
  if (env) return { key: env, source: "FUELIX_API_KEY environment variable" }
  const keychain = await keychainKey()
  if (keychain) return { key: keychain, source: "macOS Keychain item fuelix-api-key" }
  return undefined
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["json", "strict"])
  const catalogPath = typeof args.catalog === "string" ? args.catalog : new URL("../data/fuelix-models.json", import.meta.url).pathname
  const baseUrl = (typeof args["base-url"] === "string" ? args["base-url"] : "https://api.fuelix.ai/v1").replace(/\/+$/, "")
  const json = args.json === true

  const resolved = await resolveKey()
  if (!resolved) throw new Error("No FueliX key. Set FUELIX_API_KEY or add the Keychain item fuelix-api-key.")
  if (!json) console.log(`Key source: ${resolved.source}`)

  const catalog = (await Bun.file(catalogPath).json()) as Catalog
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${resolved.key}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GET ${baseUrl}/models returned HTTP ${response.status}.`)
  const liveIds = parseIds(await response.text())

  const report = buildReport(catalog, liveIds)
  console.log(json ? JSON.stringify({ keySource: resolved.source, liveCount: liveIds.length, ...report }, null, 2) : formatReport(report))
  return args.strict === true && isFailing(report) ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  },
)
