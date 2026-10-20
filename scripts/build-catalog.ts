/**
 * Build `data/fuelix-models.json` from an OpenCode config (routing seed), the LLM-Inventory files (metadata),
 * and an optional live ID list.
 *
 *   bun scripts/build-catalog.ts --config <opencode.json> [--inventory <dir>] [--ids <file>] [--out <file>] [--check]
 *
 * Without `--inventory`, the script fetches the inventory with the `gh` CLI.
 */

import { parseArgs } from "./lib/args.ts"
import { buildCatalog, formatSummary, stabilizeTimestamp, summarize } from "./lib/build.ts"
import { parseIds } from "./lib/ids.ts"
import { fetchInventory, loadLocalInventory } from "./lib/inventory-source.ts"
import { parseInventory } from "./lib/inventory.ts"
import { parseSeed } from "./lib/seed.ts"

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), ["check"])
  const configPath = args.config
  if (typeof configPath !== "string") throw new Error("Option --config <opencode.json> is required.")
  const out = typeof args.out === "string" ? args.out : "data/fuelix-models.json"

  const seed = parseSeed(JSON.parse(await Bun.file(configPath).text()))
  const inventory =
    typeof args.inventory === "string" ? await loadLocalInventory(args.inventory) : await fetchInventory()
  const deployments = parseInventory(inventory.deploymentsYaml, inventory.costsYaml)
  const liveIds = typeof args.ids === "string" ? parseIds(await Bun.file(args.ids).text()) : undefined

  const catalog = buildCatalog({
    seed,
    deployments,
    liveIds,
    generatedAt: new Date().toISOString(),
    sources: [
      "OpenCode configuration (routing seed)",
      inventory.label,
      ...(liveIds ? ["GET /v1/models (live IDs)"] : []),
    ],
  })

  const file = Bun.file(out)
  const existing = (await file.exists()) ? await file.text() : undefined
  const text = stabilizeTimestamp(existing, catalog)
  console.log(formatSummary(summarize(catalog)))

  if (args.check) {
    if (text !== existing) {
      console.error(`${out} is out of date. Run the build without --check.`)
      return 1
    }
    return 0
  }
  if (text !== existing) await Bun.write(out, text)
  console.log(text === existing ? `${out} is unchanged.` : `Wrote ${out}.`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  },
)
