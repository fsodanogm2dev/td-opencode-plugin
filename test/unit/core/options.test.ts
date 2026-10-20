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
    expect(parsed.telemetry).toEqual({
      enabled: true,
      root: undefined,
      receiverURL: "http://127.0.0.1:4418",
      node: "node",
      idleMinutes: 30,
      subagentToolNames: ["task", "subagent"],
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
        telemetry: { idleMinutes: "ten", subagentToolNames: [1, 2] },
        debug: "true",
      },
      {},
    )
    expect(parsed.fuelix.refreshMinutes).toBe(60)
    expect(parsed.fuelix.includeNonChatModels).toBe(false)
    expect(parsed.fuelix.baseURL).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(parsed.telemetry.idleMinutes).toBe(30)
    expect(parsed.telemetry.subagentToolNames).toEqual(["task", "subagent"])
    expect(parsed.debug).toBe(false)
    expect(parsed.warnings.length).toBe(6)
  })

  test("scrubShellEnv defaults to true, accepts false, and rejects other values", () => {
    expect(parseOptions({ fuelix: {} }, {}).fuelix.scrubShellEnv).toBe(true)
    expect(parseOptions({ fuelix: { scrubShellEnv: false } }, {}).fuelix.scrubShellEnv).toBe(false)
    const parsed = parseOptions({ fuelix: { scrubShellEnv: "no" } }, {})
    expect(parsed.fuelix.scrubShellEnv).toBe(true)
    expect(parsed.warnings).toEqual(["options.fuelix.scrubShellEnv must be true or false; using true"])
  })

  test("warns when a section is not an object", () => {
    const parsed = parseOptions({ fuelix: "nope", telemetry: [] }, {})
    expect(parsed.warnings).toContain("options.fuelix must be an object; using defaults")
    expect(parsed.warnings).toContain("options.telemetry must be an object; using defaults")
  })

  test("reads the receiver port, telemetry root, and debug flag from the environment", () => {
    const parsed = parseOptions(undefined, {
      TD_RECEIVER_PORT: "14418",
      TD_TELEMETRY_ROOT: "/opt/td-telemetry",
      TD_OPENCODE_PLUGIN_DEBUG: "1",
    })
    expect(parsed.telemetry.receiverURL).toBe("http://127.0.0.1:14418")
    expect(parsed.telemetry.root).toBe("/opt/td-telemetry")
    expect(parsed.debug).toBe(true)
  })

  test("explicit options win over the environment", () => {
    const parsed = parseOptions(
      { telemetry: { root: "/explicit", receiverURL: "http://127.0.0.1:9999/" } },
      { TD_RECEIVER_PORT: "14418", TD_TELEMETRY_ROOT: "/from-env" },
    )
    expect(parsed.telemetry.root).toBe("/explicit")
    expect(parsed.telemetry.receiverURL).toBe("http://127.0.0.1:9999")
  })

  test("ignores a non-numeric receiver port in the environment", () => {
    expect(parseOptions(undefined, { TD_RECEIVER_PORT: "abc" }).telemetry.receiverURL).toBe("http://127.0.0.1:4418")
  })
})
