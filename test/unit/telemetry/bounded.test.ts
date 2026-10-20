import { describe, expect, test } from "bun:test"
import { addBounded, setBounded } from "../../../src/telemetry/bounded.ts"

describe("bounded collections", () => {
  test("setBounded drops the oldest entry at the cap and keeps updates in place", () => {
    const map = new Map<string, number>()
    for (let index = 0; index < 5; index++) setBounded(map, `k${index}`, index, 3)
    expect([...map.keys()]).toEqual(["k2", "k3", "k4"])
    setBounded(map, "k3", 99, 3)
    expect([...map.keys()]).toEqual(["k2", "k3", "k4"])
    expect(map.get("k3")).toBe(99)
  })

  test("addBounded drops the oldest value at the cap", () => {
    const set = new Set<string>()
    for (let index = 0; index < 5; index++) addBounded(set, `v${index}`, 3)
    expect([...set]).toEqual(["v2", "v3", "v4"])
    addBounded(set, "v3", 3)
    expect(set.size).toBe(3)
  })

  test("the default cap is 5000", () => {
    const set = new Set<number>()
    for (let index = 0; index < 5100; index++) addBounded(set, index)
    expect(set.size).toBe(5000)
    expect(set.has(0)).toBe(false)
    expect(set.has(5099)).toBe(true)
  })
})
