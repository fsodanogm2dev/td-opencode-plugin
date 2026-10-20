import { describe, expect, test } from "bun:test"
import { modeToKind, parseNumber, selectDeployment, toPerMillion } from "../../../scripts/lib/inventory.ts"
import { fixtureDeployments } from "./helpers.ts"

describe("inventory parsing", () => {
  test("joins deployments with costs and accepts string or list aliases", async () => {
    const deployments = await fixtureDeployments()
    const vertex = deployments.find((item) => item.deployment === "vertex_ai/alpha@default")
    expect(vertex?.aliases).toEqual(["alpha", "alpha-2026"])
    expect(vertex?.prices.input).toBeCloseTo(0.000005, 12)
    expect(vertex?.prices.cacheRead).toBeCloseTo(0.0000005, 12)
    expect(vertex?.context).toBe(1000000)
    expect(vertex?.kind).toBe("chat")
    const anthropic = deployments.find((item) => item.deployment === "anthropic/alpha")
    expect(anthropic?.aliases).toEqual(["alpha"])
    expect(anthropic?.tools).toBe(false)
  })

  test("never copies credential fields", async () => {
    const text = JSON.stringify(await fixtureDeployments())
    for (const secret of ["sk-test", "AKIA", "fake-aws-secret", "api_key", "aws_secret"]) {
      expect(text).not.toContain(secret)
    }
  })

  test("falls back from max_context_window to max_input_tokens and from max_output_tokens to max_tokens", async () => {
    const beta = (await fixtureDeployments()).find((item) => item.deployment === "azure/beta")
    expect(beta?.context).toBe(400000)
    expect(beta?.output).toBe(100000)
  })

  test("treats empty strings as unknown", () => {
    expect(parseNumber("")).toBeUndefined()
    expect(parseNumber("abc")).toBeUndefined()
    expect(parseNumber("0.5")).toBe(0.5)
    expect(parseNumber(12)).toBe(12)
  })

  test("maps litellm modes to kinds", () => {
    expect(modeToKind("chat")).toBe("chat")
    expect(modeToKind("embedding")).toBe("embedding")
    expect(modeToKind("image_generation")).toBe("image")
    expect(modeToKind("audio_speech")).toBe("speech")
    expect(modeToKind("audio_transcription")).toBe("transcription")
    expect(modeToKind("")).toBeUndefined()
  })
})

describe("deployment selection", () => {
  test("skips retired and inactive deployments", async () => {
    const selection = selectDeployment("alpha", await fixtureDeployments())
    expect(selection?.candidates.map((item) => item.deployment).sort()).toEqual([
      "anthropic/alpha",
      "vertex_ai/alpha@default",
    ])
  })

  test("chooses the highest input price and the minimum limits", async () => {
    const selection = selectDeployment("alpha", await fixtureDeployments())
    expect(selection?.chosen.deployment).toBe("vertex_ai/alpha@default")
    expect(selection?.context).toBe(200000)
    expect(selection?.output).toBe(64000)
  })

  test("flags a price spread above 1%", async () => {
    const selection = selectDeployment("alpha", await fixtureDeployments())
    expect(selection?.priceSpread).toBe(true)
    expect(selection?.spreadDetail).toContain("anthropic/alpha")
  })

  test("reports no spread for one candidate", async () => {
    const selection = selectDeployment("beta", await fixtureDeployments())
    expect(selection?.priceSpread).toBe(false)
  })

  test("returns undefined when nothing matches", async () => {
    expect(selectDeployment("unknown-model", await fixtureDeployments())).toBeUndefined()
  })

  test("matches model.name when no alias matches", () => {
    const selection = selectDeployment("by-name", [
      {
        deployment: "azure/by-name",
        provider: "azure",
        modelName: "by-name",
        aliases: ["other"],
        active: true,
        prices: { input: 1e-6, output: 2e-6 },
      },
    ])
    expect(selection?.chosen.deployment).toBe("azure/by-name")
  })

  test("breaks a price tie by deployment name", () => {
    const base = { provider: "x", modelName: "m", aliases: ["m"], active: true, prices: { input: 1e-6, output: 2e-6 } }
    const selection = selectDeployment("m", [
      { ...base, deployment: "z/m" },
      { ...base, deployment: "a/m" },
    ])
    expect(selection?.chosen.deployment).toBe("a/m")
    expect(selection?.priceSpread).toBe(false)
  })
})

describe("price conversion", () => {
  test("converts per-token prices to per-1M prices without float noise", () => {
    expect(toPerMillion(0.000005)).toBe(5)
    expect(toPerMillion(0.0000043500)).toBe(4.35)
    expect(toPerMillion(0.0000002)).toBe(0.2)
    expect(toPerMillion(0.000000125)).toBe(0.125)
    expect(toPerMillion(0)).toBe(0)
    expect(toPerMillion(undefined)).toBeUndefined()
  })
})
