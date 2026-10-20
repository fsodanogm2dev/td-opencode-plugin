import { join } from "node:path"
import type { Catalog } from "../../../src/fuelix/catalog-types.ts"
import { buildCatalog } from "../../../scripts/lib/build.ts"
import { parseInventory } from "../../../scripts/lib/inventory.ts"
import { parseSeed } from "../../../scripts/lib/seed.ts"

export const FIXTURES = join(import.meta.dir, "../../fixtures/catalog")

export async function fixtureText(name: string): Promise<string> {
  return Bun.file(join(FIXTURES, name)).text()
}

export async function fixtureSeed() {
  return parseSeed(JSON.parse(await fixtureText("seed-config.json")))
}

export async function fixtureDeployments() {
  return parseInventory(await fixtureText("deployments.yaml"), await fixtureText("costs.yaml"))
}

export async function fixtureCatalog(liveIds?: readonly string[]): Promise<Catalog> {
  return buildCatalog({
    seed: await fixtureSeed(),
    deployments: await fixtureDeployments(),
    liveIds,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sources: ["fixture"],
  })
}
