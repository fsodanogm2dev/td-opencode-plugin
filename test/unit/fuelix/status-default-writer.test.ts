import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { statusFileName } from "../../../src/fuelix/status.ts"

const ROOT = new URL("../../..", import.meta.url).pathname
const LOCATION = "/isolated/location"

/**
 * Runs the real plugin entry (`src/index.ts`) in a subprocess with a temporary HOME, a fake context, no key, no
 * Keychain lookup, and no network. Nothing in this process or in the real home directory is touched.
 */
async function runPlugin(home: string, fuelix: Record<string, unknown>): Promise<void> {
  const script = join(home, "run.mjs")
  await writeFile(
    script,
    `
import plugin from ${JSON.stringify(join(ROOT, "src/index.ts"))}
import { createFakeCtx } from ${JSON.stringify(join(ROOT, "test/unit/fuelix/fake-ctx.ts"))}
const fake = createFakeCtx({ directory: ${JSON.stringify(LOCATION)} })
fake.ctx.options = { fuelix: ${JSON.stringify({ keychainService: false, refreshMinutes: 0, ...fuelix })} }
const cleanup = await plugin.setup(fake.ctx)
await new Promise((resolve) => setTimeout(resolve, 600))
await cleanup()
process.exit(0)
`,
  )
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }
  const child = Bun.spawn([process.execPath, script], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
  const code = await child.exited
  if (code !== 0) throw new Error(`plugin subprocess exited with ${code}: ${await new Response(child.stderr).text()}`)
}

describe("default status report writer", () => {
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "td-status-home-"))
  })
  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  test("the real plugin entry writes the report below HOME by default", async () => {
    await runPlugin(home, {})
    const root = join(home, ".td-opencode-plugin", "status")
    expect(await readdir(root)).toEqual([statusFileName(LOCATION)])
    const report = JSON.parse(await readFile(join(root, statusFileName(LOCATION)), "utf8"))
    expect(report).toMatchObject({ version: 1, directory: LOCATION, lastCheck: { outcome: "no-key" } })
  }, 20_000)

  test("fuelix.statusReport false writes nothing", async () => {
    await runPlugin(home, { statusReport: false })
    expect(existsSync(join(home, ".td-opencode-plugin"))).toBe(false)
  }, 20_000)
})
