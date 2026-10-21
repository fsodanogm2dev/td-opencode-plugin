/**
 * Prints a copy of an OpenCode configuration without the FueliX provider blocks and with this plugin added.
 *
 * Dry run only: the script never writes the input file. Review the output, then apply it yourself.
 *
 *   bun scripts/migrate-config.ts                                  # reads ~/.config/opencode/opencode.json, prints to stdout
 *   bun scripts/migrate-config.ts --out /tmp/opencode.migrated.json
 *   bun scripts/migrate-config.ts --config ./opencode.json --plugin github:fsodanogm2dev/td-opencode-plugin#v0.1.0
 *
 * The default plugin spec pins the tag of the version in package.json.
 *
 * The summary goes to stderr. Note: the output contains every other value of the input file, including secrets that
 * the file already holds. Write it to a file with `--out` instead of pasting it anywhere.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import pkg from "../package.json" with { type: "json" }

export const FUELIX_PROVIDER_IDS = ["fuelix", "fuelix-openai", "fuelix-anthropic"] as const
export const DEFAULT_PLUGIN_SPEC = `github:fsodanogm2dev/td-opencode-plugin#v${pkg.version}`
const PROVIDER_BLOCK_KEYS = ["provider", "providers"] as const

export interface MigrationResult {
  readonly config: Record<string, unknown>
  /** Removed blocks, for example `provider.fuelix-openai`. */
  readonly removed: readonly string[]
  /** Number of model entries inside the removed blocks. */
  readonly removedModelCount: number
  readonly addedPlugin: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function pluginName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (isRecord(entry) && typeof entry.package === "string") return entry.package
  return undefined
}

export function migrateConfig(input: Record<string, unknown>, pluginSpec: string = DEFAULT_PLUGIN_SPEC): MigrationResult {
  const config = structuredClone(input)
  const removed: string[] = []
  let removedModelCount = 0

  for (const key of PROVIDER_BLOCK_KEYS) {
    const block = config[key]
    if (!isRecord(block)) continue
    for (const id of FUELIX_PROVIDER_IDS) {
      if (!Object.hasOwn(block, id)) continue
      const provider = block[id]
      if (isRecord(provider) && isRecord(provider.models)) removedModelCount += Object.keys(provider.models).length
      delete block[id]
      removed.push(`${key}.${id}`)
    }
    if (Object.keys(block).length === 0) delete config[key]
  }

  const plugins = Array.isArray(config.plugins) ? [...config.plugins] : []
  const present = plugins.some((entry) => pluginName(entry)?.includes("td-opencode-plugin") === true)
  if (!present) plugins.push({ package: pluginSpec, options: {} })
  config.plugins = plugins

  return { config, removed, removedModelCount, addedPlugin: !present }
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

function main(args: readonly string[]): number {
  const configPath = resolve(readFlag(args, "--config") ?? join(homedir(), ".config", "opencode", "opencode.json"))
  const outPath = readFlag(args, "--out")
  const pluginSpec = readFlag(args, "--plugin") ?? DEFAULT_PLUGIN_SPEC

  if (outPath !== undefined && resolve(outPath) === configPath) {
    console.error("Refusing to write the input file. Choose another --out path and apply the result yourself.")
    return 2
  }

  const text = readFileSync(configPath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    console.error(`${configPath} is not plain JSON. Remove comments and trailing commas, then run again.`)
    return 2
  }
  if (!isRecord(parsed)) {
    console.error(`${configPath} does not contain a JSON object.`)
    return 2
  }

  const result = migrateConfig(parsed, pluginSpec)
  const output = `${JSON.stringify(result.config, null, 2)}\n`
  if (outPath !== undefined) writeFileSync(outPath, output, { mode: 0o600 })
  else process.stdout.write(output)

  const linesBefore = text.split("\n").length
  const linesAfter = output.split("\n").length
  console.error(
    [
      `input: ${configPath} (${linesBefore} lines)`,
      `output: ${outPath ?? "stdout"} (${linesAfter} lines)`,
      `removed blocks: ${result.removed.length > 0 ? result.removed.join(", ") : "none"}`,
      `removed model entries: ${result.removedModelCount}`,
      `plugin entry: ${result.addedPlugin ? `added ${pluginSpec}` : "already present"}`,
    ].join("\n"),
  )
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
