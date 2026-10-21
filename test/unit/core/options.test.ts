import { describe, expect, test } from "bun:test"
import { DEFAULT_FUELIX_BASE_URL, DEFAULT_KEYCHAIN_SERVICE, parseOptions } from "../../../src/options.ts"

describe("parseOptions", () => {
  test("returns defaults for undefined options", () => {
    const parsed = parseOptions(undefined, {})
    expect(parsed.warnings).toEqual([])
    expect(parsed.debug).toBe(false)
    expect(parsed.fuelix).toEqual({
      baseURL: DEFAULT_FUELIX_BASE_URL,
      keychainService: DEFAULT_KEYCHAIN_SERVICE,
      refreshMinutes: 60,
      includeNonChatModels: false,
      discoveryTimeoutMs: 5000,
      scrubShellEnv: true,
    })
  })

  test("normalizes the FueliX base URL", () => {
    expect(parseOptions({ fuelix: { baseURL: "https://gw.example.com/v1/" } }, {}).fuelix.baseURL).toBe(
      "https://gw.example.com",
    )
    expect(parseOptions({ fuelix: { baseURL: "https://gw.example.com//" } }, {}).fuelix.baseURL).toBe(
      "https://gw.example.com",
    )
  })

  test("accepts keychainService false to disable the Keychain lookup", () => {
    expect(parseOptions({ fuelix: { keychainService: false } }, {}).fuelix.keychainService).toBe(false)
    expect(parseOptions({ fuelix: { keychainService: "my-key" } }, {}).fuelix.keychainService).toBe("my-key")
  })

  test("falls back to defaults with a warning for invalid values", () => {
    const parsed = parseOptions(
      {
        fuelix: { refreshMinutes: -5, includeNonChatModels: "yes", baseURL: "" },
        debug: "true",
      },
      {},
    )
    expect(parsed.fuelix.refreshMinutes).toBe(60)
    expect(parsed.fuelix.includeNonChatModels).toBe(false)
    expect(parsed.fuelix.baseURL).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(parsed.debug).toBe(false)
    expect(parsed.warnings.length).toBe(4)
  })

  test("scrubShellEnv defaults to true, accepts false, and rejects other values", () => {
    expect(parseOptions({ fuelix: {} }, {}).fuelix.scrubShellEnv).toBe(true)
    expect(parseOptions({ fuelix: { scrubShellEnv: false } }, {}).fuelix.scrubShellEnv).toBe(false)
    const parsed = parseOptions({ fuelix: { scrubShellEnv: "no" } }, {})
    expect(parsed.fuelix.scrubShellEnv).toBe(true)
    expect(parsed.warnings).toEqual(["options.fuelix.scrubShellEnv must be true or false; using true"])
  })

  test("warns when a section is not an object", () => {
    const parsed = parseOptions({ fuelix: "nope" }, {})
    expect(parsed.warnings).toContain("options.fuelix must be an object; using defaults")
  })

  test("reads the debug flag from the environment", () => {
    expect(parseOptions(undefined, { TD_OPENCODE_PLUGIN_DEBUG: "1" }).debug).toBe(true)
  })

  test("ignores unknown option keys without a warning", () => {
    const parsed = parseOptions({ removedFeature: { enabled: true }, unknownKey: 1, fuelix: {} }, {})
    expect(parsed.warnings).toEqual([])
    expect(parsed.fuelix.baseURL).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(parsed.debug).toBe(false)
  })
})
