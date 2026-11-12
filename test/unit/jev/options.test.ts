import { describe, expect, test } from "bun:test"
import {
  ALLOW_CUSTOM_JEV_KEYCHAIN_ENV,
  ALLOW_CUSTOM_JEV_URL_ENV,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_OPTIONS,
  parseJevOptions,
  resolveJevBaseURL,
} from "../../../src/jev/options.ts"

const parse = (raw: unknown, env: Record<string, string | undefined> = {}) => {
  const warnings: string[] = []
  return { options: parseJevOptions(raw, env, warnings), warnings }
}

describe("parseJevOptions", () => {
  test("defaults: disabled, jev-1.14.0, safety and compression enforce, others off", () => {
    const { options, warnings } = parse(undefined)
    expect(warnings).toEqual([])
    expect(options).toEqual(DEFAULT_JEV_OPTIONS)
    expect(options.enabled).toBe(false)
    expect(options.model).toBe("jev-1.14.0")
    expect(options.baseURL).toBe("https://api.typesafe.ai")
    expect(options.keychainService).toBe("typesafe-api-key")
    expect(options.points.safetyPreCheck).toEqual({ mode: "enforce", timeoutMs: 1500, riskThreshold: 0.2, failClosed: true })
    expect(options.points.testCompression).toEqual({ mode: "enforce", timeoutMs: 2500, maxRawLength: 1200 })
    expect(options.points.skillPruning.mode).toBe("off")
    expect(options.points.reasoningBudget.mode).toBe("off")
  })

  test("non-object input uses defaults with a warning", () => {
    for (const raw of ["x", 1, [], true]) {
      const { options, warnings } = parse(raw)
      expect(options).toEqual(DEFAULT_JEV_OPTIONS)
      expect(warnings).toEqual(["options.jev must be an object; using defaults"])
    }
  })

  test("valid values are accepted", () => {
    const { options, warnings } = parse({
      enabled: true,
      model: "jev-latest",
      keychainService: false,
      scrubShellEnv: false,
      telemetry: false,
      points: {
        safetyPreCheck: { mode: "shadow", timeoutMs: 900, riskThreshold: 0.5, failClosed: false },
        testCompression: { mode: "off", timeoutMs: 3000, maxRawLength: 2000 },
        skillPruning: { mode: "shadow", maxSkills: 5 },
        reasoningBudget: { mode: "shadow", timeoutMs: 500 },
      },
    })
    expect(warnings).toEqual([])
    expect(options.enabled).toBe(true)
    expect(options.model).toBe("jev-latest")
    expect(options.keychainService).toBe(false)
    expect(options.scrubShellEnv).toBe(false)
    expect(options.telemetry).toBe(false)
    expect(options.points.safetyPreCheck).toEqual({ mode: "shadow", timeoutMs: 900, riskThreshold: 0.5, failClosed: false })
    expect(options.points.testCompression.mode).toBe("off")
    expect(options.points.skillPruning).toEqual({ mode: "shadow", timeoutMs: 800, maxSkills: 5 })
  })

  test("invalid values fall back with one warning each", () => {
    const { options, warnings } = parse({
      enabled: "yes",
      model: "bad model!",
      keychainService: "",
      telemetry: 1,
      points: {
        safetyPreCheck: { mode: "block", timeoutMs: 1, riskThreshold: 2, failClosed: "no" },
        testCompression: { maxRawLength: 1.5 },
        skillPruning: { maxSkills: 0 },
        reasoningBudget: "on",
      },
    })
    expect(options).toEqual(DEFAULT_JEV_OPTIONS)
    expect(warnings.length).toBe(11)
    expect(warnings.some((line) => line.startsWith("options.jev.enabled"))).toBe(true)
    expect(warnings.some((line) => line.startsWith("options.jev.points.safetyPreCheck.mode"))).toBe(true)
    expect(warnings.some((line) => line.startsWith("options.jev.points.reasoningBudget must be an object"))).toBe(true)
  })

  test("enforce on skillPruning and reasoningBudget becomes shadow with a warning", () => {
    const { options, warnings } = parse({ points: { skillPruning: { mode: "enforce" }, reasoningBudget: { mode: "enforce" } } })
    expect(options.points.skillPruning.mode).toBe("shadow")
    expect(options.points.reasoningBudget.mode).toBe("shadow")
    expect(warnings).toEqual([
      'options.jev.points.skillPruning.mode "enforce" is not supported yet; using "shadow"',
      'options.jev.points.reasoningBudget.mode "enforce" is not supported yet; using "shadow"',
    ])
  })

  test("ignored fields warn without echoing their values", () => {
    const secret = "sk-test-not-a-real-key"
    const { options, warnings } = parse({
      apiKey: secret,
      brokerSocket: "/tmp/x.sock",
      categoryRouting: {},
      contextGC: {},
      points: { categoryRouting: { mode: "enforce" }, contextGC: { mode: "enforce" } },
    })
    expect(options).toEqual(DEFAULT_JEV_OPTIONS)
    expect(warnings).toEqual([
      "options.jev.categoryRouting is not supported and is ignored",
      "options.jev.contextGC is not supported and is ignored",
      "options.jev.apiKey is not supported and is ignored",
      "options.jev.brokerSocket is not supported and is ignored",
      "options.jev.points.categoryRouting is not supported and is ignored",
      "options.jev.points.contextGC is not supported and is ignored",
    ])
    expect(warnings.join("\n")).not.toContain(secret)
  })
})

describe("resolveJevBaseURL", () => {
  const allow = { [ALLOW_CUSTOM_JEV_URL_ENV]: "1" }
  const resolve = (url: string, env: Record<string, string | undefined> = {}) => {
    const warnings: string[] = []
    return { url: resolveJevBaseURL(url, env, warnings), warnings }
  }

  test("default and normalized default pass without warning", () => {
    for (const value of ["https://api.typesafe.ai", "https://api.typesafe.ai/", "https://api.typesafe.ai/v1", "https://api.typesafe.ai/v1/"]) {
      expect(resolve(value)).toEqual({ url: DEFAULT_JEV_BASE_URL, warnings: [] })
    }
  })

  test("custom URL needs the environment flag", () => {
    const result = resolve("https://jev.example.com")
    expect(result.url).toBe(DEFAULT_JEV_BASE_URL)
    expect(result.warnings[0]).toContain(ALLOW_CUSTOM_JEV_URL_ENV)
    expect(resolve("https://jev.example.com", { [ALLOW_CUSTOM_JEV_URL_ENV]: "true" }).url).toBe(DEFAULT_JEV_BASE_URL)
  })

  test("custom https URL and loopback http are accepted with the flag", () => {
    expect(resolve("https://jev.example.com/v1", allow)).toEqual({ url: "https://jev.example.com", warnings: [] })
    expect(resolve("http://127.0.0.1:8080", allow).url).toBe("http://127.0.0.1:8080")
    expect(resolve("http://localhost:9", allow).url).toBe("http://localhost:9")
  })

  test("rejects plain http to a remote host, invalid URLs, credentials, query, and fragments", () => {
    for (const value of ["http://jev.example.com", "not a url", "https://user:pw@jev.example.com", "https://jev.example.com?a=1", "https://jev.example.com#x"]) {
      const result = resolve(value, allow)
      expect(result.url).toBe(DEFAULT_JEV_BASE_URL)
      expect(result.warnings.length).toBe(1)
      expect(result.warnings[0]).not.toContain("pw@")
    }
  })

  test("parseJevOptions applies the guard", () => {
    const { options, warnings } = parse({ baseURL: "https://jev.example.com" })
    expect(options.baseURL).toBe(DEFAULT_JEV_BASE_URL)
    expect(warnings.length).toBe(1)
    expect(parse({ baseURL: "https://jev.example.com" }, allow).options.baseURL).toBe("https://jev.example.com")
  })
})

describe("keychainService gate", () => {
  const allow = { [ALLOW_CUSTOM_JEV_KEYCHAIN_ENV]: "1" }

  test("the default is unchanged and needs no flag", () => {
    expect(parse({}).options.keychainService).toBe("typesafe-api-key")
    expect(parse({ keychainService: "typesafe-api-key" })).toEqual({ options: DEFAULT_JEV_OPTIONS, warnings: [] })
    expect(parse({ keychainService: "  typesafe-api-key  " }).warnings).toEqual([])
  })

  test("false is always accepted", () => {
    expect(parse({ keychainService: false })).toMatchObject({ options: { keychainService: false }, warnings: [] })
    expect(parse({ keychainService: false }, allow).options.keychainService).toBe(false)
  })

  test("a custom name is ignored without the server flag, and the warning does not echo it", () => {
    for (const env of [{}, { [ALLOW_CUSTOM_JEV_KEYCHAIN_ENV]: "true" }, { [ALLOW_CUSTOM_JEV_KEYCHAIN_ENV]: "0" }]) {
      const { options, warnings } = parse({ keychainService: "my-secret-service-name" }, env)
      expect(options.keychainService).toBe("typesafe-api-key")
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain(ALLOW_CUSTOM_JEV_KEYCHAIN_ENV)
      expect(warnings.join("\n")).not.toContain("my-secret-service-name")
    }
  })

  test("a custom name works with the flag", () => {
    expect(parse({ keychainService: "my-jev-key" }, allow)).toMatchObject({ options: { keychainService: "my-jev-key" }, warnings: [] })
  })

  test("the FueliX service is always rejected, even with the flag, in any spelling", () => {
    for (const name of ["fuelix-api-key", " fuelix-api-key ", "FUELIX-API-KEY"]) {
      for (const env of [{}, allow]) {
        const { options, warnings } = parse({ keychainService: name }, env)
        expect(options.keychainService).toBe("typesafe-api-key")
        expect(warnings.length).toBe(1)
        expect(warnings.join("\n").toLowerCase()).not.toContain("fuelix")
      }
    }
  })

  test("non-string values still warn", () => {
    for (const value of ["", "  ", 5, true, {}]) {
      const { options, warnings } = parse({ keychainService: value }, allow)
      expect(options.keychainService).toBe("typesafe-api-key")
      expect(warnings.length).toBe(1)
    }
  })
})

describe("model", () => {
  test.each(["jev-1.14.0", "jev-1.13.0", "jev-1.14", "jev-latest", "jev-preview"])("accepts %s", (model) => {
    expect(parse({ model })).toMatchObject({ options: { model }, warnings: [] })
  })

  test.each(["gpt-4", "claude-sonnet-5-5", "jev-1.14.0-evil", "jev-", "jev-1", "jev-1.14.0.1", "sk-test-not-a-real-key", 5])("rejects %p with a warning that does not echo it", (model) => {
    const { options, warnings } = parse({ model })
    expect(options.model).toBe("jev-1.14.0")
    expect(warnings.length).toBe(1)
    expect(warnings.join("\n")).not.toContain("sk-test")
  })
})
