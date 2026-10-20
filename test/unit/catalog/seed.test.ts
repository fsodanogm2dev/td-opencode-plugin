import { describe, expect, test } from "bun:test"
import { parseSeed } from "../../../scripts/lib/seed.ts"
import { fixtureSeed, fixtureText } from "./helpers.ts"

describe("seed parsing", () => {
  test("reads V1 blocks", async () => {
    const seed = await fixtureSeed()
    expect(seed.get("beta")).toEqual({
      provider: "fuelix-openai",
      name: "Beta",
      context: 400000,
      output: 100000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      tools: true,
      reasoning: true,
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    })
    expect(seed.get("emb")?.provider).toBe("fuelix")
    expect(seed.get("emb")?.output).toBe(0)
  })

  test("reads V2 blocks", async () => {
    const alpha = (await fixtureSeed()).get("alpha")
    expect(alpha).toEqual({
      provider: "fuelix-anthropic",
      name: "Alpha",
      context: 500000,
      output: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      tools: true,
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    })
  })

  test("ignores other providers", async () => {
    expect((await fixtureSeed()).has("ignored-model")).toBe(false)
  })

  test("never copies secrets from the config", async () => {
    const seed = await fixtureSeed()
    const text = JSON.stringify([...seed.entries()])
    for (const secret of ["sk-test", "Bearer", "fake-token", "apiKey", "Authorization", "baseURL"]) {
      expect(text).not.toContain(secret)
    }
    expect(await fixtureText("seed-config.json")).toContain("sk-test-not-a-real-key")
  })

  test("returns an empty seed for a config without FueliX blocks", () => {
    expect(parseSeed({}).size).toBe(0)
    expect(parseSeed(null).size).toBe(0)
  })
})
