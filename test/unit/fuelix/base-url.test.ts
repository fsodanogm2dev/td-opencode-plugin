import { describe, expect, test } from "bun:test"
import { ALLOW_CUSTOM_URL_ENV, resolveBaseURL } from "../../../src/fuelix/base-url.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { DEFAULT_FUELIX_BASE_URL } from "../../../src/options.ts"

const ALLOW = { [ALLOW_CUSTOM_URL_ENV]: "1" }

describe("resolveBaseURL", () => {
  test("the default URL needs no opt-in and logs nothing", () => {
    const log = createMemoryLogger()
    expect(resolveBaseURL(DEFAULT_FUELIX_BASE_URL, {}, log)).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(log.lines).toEqual([])
  })

  test("a custom URL without the opt-in falls back with a warning", () => {
    const log = createMemoryLogger()
    expect(resolveBaseURL("https://evil.example.test", {}, log)).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(log.lines.length).toBe(1)
    expect(log.lines[0]).toContain("warn")
    expect(log.lines[0]).toContain(ALLOW_CUSTOM_URL_ENV)
  })

  test("only the value 1 opts in", () => {
    const log = createMemoryLogger()
    expect(resolveBaseURL("https://gw.example.test", { [ALLOW_CUSTOM_URL_ENV]: "true" }, log)).toBe(DEFAULT_FUELIX_BASE_URL)
  })

  test("a custom https URL with the opt-in is used and its host is logged at info level", () => {
    const log = createMemoryLogger()
    expect(resolveBaseURL("https://gw.example.test", ALLOW, log)).toBe("https://gw.example.test")
    expect(log.lines.length).toBe(1)
    expect(log.lines[0]).toContain("info")
    expect(log.lines[0]).toContain("gw.example.test")
  })

  test("http is rejected for a remote host", () => {
    const log = createMemoryLogger()
    expect(resolveBaseURL("http://gw.example.test", ALLOW, log)).toBe(DEFAULT_FUELIX_BASE_URL)
    expect(log.lines[0]).toContain("warn")
  })

  test("http is allowed for loopback hosts", () => {
    for (const url of ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"]) {
      const log = createMemoryLogger()
      expect(resolveBaseURL(url, ALLOW, log)).toBe(url)
    }
  })

  test("other schemes and invalid URLs are rejected", () => {
    for (const url of ["ftp://gw.example.test", "not a url"]) {
      expect(resolveBaseURL(url, ALLOW, createMemoryLogger())).toBe(DEFAULT_FUELIX_BASE_URL)
    }
  })
})
