import { describe, expect, test } from "bun:test"
import { DEFAULT_PLUGIN_SPEC, migrateConfig } from "../../../scripts/migrate-config.ts"

const input = () => ({
  $schema: "https://opencode.ai/config.json",
  provider: {
    "fuelix-openai": { npm: "@ai-sdk/openai", models: { "gpt-6-luna": {}, "gpt-4.1": {} } },
    fuelix: { npm: "@ai-sdk/openai-compatible", models: { "gemini-2.5-pro": {} } },
    other: { npm: "@ai-sdk/openai-compatible", models: { "keep-me": {} } },
  },
  model: "fuelix-openai/gpt-6-luna",
  mcp: { secret: { environment: { TOKEN: "sk-test-not-a-real-key" } } },
  plugin: ["/legacy/v1-plugin.js"],
  plugins: ["oh-my-opencode-slim@3.0.1"],
  providers: {
    "fuelix-anthropic": {
      settings: { apiKey: "{env:FUELIX_API_KEY}" },
      headers: { Authorization: "Bearer {env:FUELIX_API_KEY}" },
      models: { "claude-opus": {} },
    },
  },
})

describe("migrateConfig", () => {
  test("removes the three FueliX provider blocks and counts their models", () => {
    const result = migrateConfig(input())
    expect(result.removed).toEqual(["provider.fuelix", "provider.fuelix-openai", "providers.fuelix-anthropic"])
    expect(result.removedModelCount).toBe(4)
    expect(result.config.provider).toEqual({ other: { npm: "@ai-sdk/openai-compatible", models: { "keep-me": {} } } })
    expect("providers" in result.config).toBe(false)
  })

  test("keeps every other key unchanged, including the default model and other plugins", () => {
    const result = migrateConfig(input())
    expect(result.config.model).toBe("fuelix-openai/gpt-6-luna")
    expect(result.config.mcp).toEqual(input().mcp)
    expect(result.config.plugin).toEqual(["/legacy/v1-plugin.js"])
    expect(result.config.plugins).toEqual(["oh-my-opencode-slim@3.0.1", { package: DEFAULT_PLUGIN_SPEC, options: {} }])
  })

  test("adds the plugin only once", () => {
    const once = migrateConfig(input())
    const twice = migrateConfig(once.config)
    expect(twice.addedPlugin).toBe(false)
    expect(twice.config.plugins).toEqual(once.config.plugins)
  })

  test("uses a custom plugin spec", () => {
    const result = migrateConfig({}, "/Users/me/work/td-opencode-plugin")
    expect(result.config.plugins).toEqual([{ package: "/Users/me/work/td-opencode-plugin", options: {} }])
    expect(result.removed).toEqual([])
  })

  test("never changes the input object", () => {
    const original = input()
    const snapshot = structuredClone(original)
    migrateConfig(original)
    expect(original).toEqual(snapshot)
  })
})
