import { describe, expect, test } from "bun:test"
import { createMemoryLogger } from "../../../src/log.ts"
import { createManagerSpawner, globalProcessManagerState, RESPAWN_INTERVAL_MS } from "../../../src/telemetry/manager.ts"
import type { ProcessManagerState } from "../../../src/telemetry/manager.ts"

function setup() {
  const calls: Array<{ command: string; args: readonly string[]; env: unknown }> = []
  const state: ProcessManagerState = { spawned: false, lastSpawnAt: undefined }
  let clock = 1000
  const spawner = createManagerSpawner({
    root: "/td",
    node: "node22",
    env: { PATH: "/bin" },
    spawn: (command, args, env) => calls.push({ command, args, env }),
    now: () => clock,
    log: createMemoryLogger(),
    state,
  })
  return { spawner, calls, state, advance: (ms: number) => (clock += ms) }
}

describe("process manager spawner", () => {
  test("ensure spawns once per state", () => {
    const { spawner, calls } = setup()
    expect(spawner.ensure()).toBe(true)
    expect(spawner.ensure()).toBe(false)
    expect(calls).toEqual([{ command: "node22", args: ["/td/lib/process-manager.mjs"], env: { PATH: "/bin" } }])
  })

  test("restart waits 10 minutes after the last spawn", () => {
    const { spawner, calls, advance } = setup()
    spawner.ensure()
    expect(spawner.restart()).toBe(false)
    advance(RESPAWN_INTERVAL_MS - 1)
    expect(spawner.restart()).toBe(false)
    advance(1)
    expect(spawner.restart()).toBe(true)
    expect(spawner.restart()).toBe(false)
    expect(calls).toHaveLength(2)
  })

  test("the global state is one shared object", () => {
    expect(globalProcessManagerState()).toBe(globalProcessManagerState())
  })
})
