import { describe, expect, test } from "bun:test"
import { diffRegistries, readRegistry, renderMarkdown } from "../../../scripts/compare-registry.ts"

const model = (providerID: string, id: string, extra: Record<string, unknown> = {}) => ({
  id,
  providerID,
  name: id,
  settings: { apiKey: "sk-test-not-a-real-key" },
  headers: { Authorization: "Bearer sk-test-not-a-real-key" },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [{ id: "low" }],
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
  limit: { context: 1000, output: 100 },
  ...extra,
})

describe("compare-registry", () => {
  const before = readRegistry({
    data: [
      model("fuelix", "same"),
      model("fuelix", "priced-later", { cost: [] }),
      model("fuelix-openai", "gone"),
      model("openai", "not-fuelix"),
    ],
  })
  const after = readRegistry([
    model("fuelix", "same"),
    model("fuelix", "priced-later", { limit: { context: 2000, output: 200 } }),
    model("fuelix-anthropic", "new", { variants: [] }),
  ])
  const diff = diffRegistries(before, after)

  test("reads only FueliX providers", () => {
    expect([...before.keys()].sort()).toEqual(["fuelix-openai/gone", "fuelix/priced-later", "fuelix/same"])
  })

  test("finds added, removed, and changed models", () => {
    expect(diff.added.map((item) => item.key)).toEqual(["fuelix-anthropic/new"])
    expect(diff.removed.map((item) => item.key)).toEqual(["fuelix-openai/gone"])
    expect(diff.changed).toEqual([
      { key: "fuelix/priced-later", field: "cost", before: "none", after: "1/2/0.1/0" },
      { key: "fuelix/priced-later", field: "limit", before: "1000/100", after: "2000/200" },
    ])
    expect(diff.unpricedBefore).toEqual(["fuelix/priced-later"])
    expect(diff.unpricedAfter).toEqual([])
  })

  test("formats context tiers", () => {
    const tiered = readRegistry([
      model("fuelix", "tiered", {
        cost: [
          { input: 1, output: 2, cache: { read: 0.1, write: 0 } },
          { tier: { type: "context", size: 200000 }, input: 2, output: 4, cache: { read: 0.2, write: 0 } },
        ],
      }),
    ])
    expect(tiered.get("fuelix/tiered")?.cost).toBe("1/2/0.1/0; >200000: 2/4/0.2/0")
  })

  test("never prints settings or headers", () => {
    const markdown = renderMarkdown(diff)
    expect(markdown).not.toContain("sk-test-not-a-real-key")
    expect(markdown).not.toContain("Authorization")
    expect(markdown).toContain("| Models without a price before | 1 |")
  })
})
