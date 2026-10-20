/** Load the inventory files from a local directory or from GitHub through the `gh` CLI. */

import { join } from "node:path"

export interface InventoryFiles {
  readonly deploymentsYaml: string
  readonly costsYaml: string
  /** Source label for `Catalog.sources`. */
  readonly label: string
}

export type RunGh = (args: readonly string[]) => Promise<string>

export const LOCAL_LABEL = "fuelix/LLM-Inventory (local copy)"

export async function runGh(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`gh ${args[0]} failed: ${stderr.trim().slice(0, 200)}`)
  return stdout
}

export async function loadLocalInventory(dir: string): Promise<InventoryFiles> {
  return {
    deploymentsYaml: await Bun.file(join(dir, "deployments.yaml")).text(),
    costsYaml: await Bun.file(join(dir, "costs.yaml")).text(),
    label: LOCAL_LABEL,
  }
}

export async function fetchInventory(gh: RunGh = runGh): Promise<InventoryFiles> {
  const sha = (await gh(["api", "repos/fuelix/LLM-Inventory/commits/main", "--jq", ".sha"])).trim()
  const file = (name: string) =>
    gh(["api", `repos/fuelix/LLM-Inventory/contents/data/${name}?ref=${sha}`, "-H", "Accept: application/vnd.github.raw"])
  const [deploymentsYaml, costsYaml] = await Promise.all([file("deployments.yaml"), file("costs.yaml")])
  return { deploymentsYaml, costsYaml, label: `fuelix/LLM-Inventory@${sha}` }
}
