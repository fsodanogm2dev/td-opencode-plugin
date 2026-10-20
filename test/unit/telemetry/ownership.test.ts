import { describe, expect, test } from "bun:test"
import { createOwnership } from "../../../src/telemetry/ownership.ts"

const fakeRealpath = (map: Record<string, string>) => (path: string) => {
  const value = map[path]
  if (value === undefined) throw new Error("ENOENT")
  return value
}

describe("ownership", () => {
  test("equal strings, unknown directories, and different places are owned", () => {
    const owns = createOwnership("/a", fakeRealpath({ "/a": "/a", "/b": "/b" }))
    expect(owns("/a")).toBe(true)
    expect(owns(undefined)).toBe(true)
    expect(owns("/b")).toBe(true)
    expect(owns("/missing")).toBe(true)
    expect(createOwnership(undefined)("/x")).toBe(true)
  })

  test("a different spelling of the same real path is not owned", () => {
    const owns = createOwnership("/private/var/p", fakeRealpath({ "/private/var/p": "/private/var/p", "/var/p": "/private/var/p" }))
    expect(owns("/var/p")).toBe(false)
  })
})
