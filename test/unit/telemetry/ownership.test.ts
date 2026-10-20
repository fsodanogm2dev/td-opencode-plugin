import { describe, expect, test } from "bun:test"
import { createOwnership, globalOwnerRegistry } from "../../../src/telemetry/ownership.ts"
import type { OwnerRegistry } from "../../../src/telemetry/ownership.ts"

/** Fake real paths: `/var/p` and `/private/var/p` are one place. */
const REAL: Record<string, string> = {
  "/private/var/p": "/private/var/p",
  "/var/p": "/private/var/p",
  "/private/var/q": "/private/var/q",
  "/other": "/other",
}
const realpath = (path: string) => {
  const value = REAL[path]
  if (value === undefined) throw new Error("ENOENT")
  return value
}

function instance(directory: string | undefined, registry: OwnerRegistry, onNoOwner?: (directory: string, id: string | undefined) => void) {
  const ownership = createOwnership({ ownDirectory: directory, registry, realpath, ...(onNoOwner ? { onNoOwner } : {}) })
  ownership.register()
  return ownership
}

describe("ownership", () => {
  test("the exact owner owns its session", () => {
    const registry: OwnerRegistry = new Map()
    expect(instance("/var/p", registry).owns("/var/p")).toBe(true)
  })

  test("an alias with an exact owner registered: the non-owner skips and the exact owner reports", () => {
    const registry: OwnerRegistry = new Map()
    const real = instance("/private/var/p", registry)
    const alias = instance("/var/p", registry)
    expect(alias.owns("/private/var/p")).toBe(false)
    expect(real.owns("/private/var/p")).toBe(true)
    expect(alias.owns("/var/p")).toBe(true)
    expect(real.owns("/var/p")).toBe(false)
  })

  test("an alias without an exact owner: the smallest directory with the same real path owns", () => {
    const registry: OwnerRegistry = new Map()
    const a = instance("/private/var/p", registry)
    const b = instance("/var/p", registry)
    // The session location is a third spelling that no instance has.
    REAL["/var/../private/var/p"] = "/private/var/p"
    try {
      expect(a.owns("/var/../private/var/p")).toBe(true)
      expect(b.owns("/var/../private/var/p")).toBe(false)
    } finally {
      delete REAL["/var/../private/var/p"]
    }
  })

  test("a lone instance owns a session at an alias of its directory", () => {
    const registry: OwnerRegistry = new Map()
    expect(instance("/var/p", registry).owns("/private/var/p")).toBe(true)
  })

  test("a session in a different real location is skipped, with one debug callback per session", () => {
    const registry: OwnerRegistry = new Map()
    const seen: Array<string | undefined> = []
    const p = instance("/private/var/p", registry, (_directory, id) => seen.push(id))
    expect(p.owns("/other", "ses_1")).toBe(false)
    expect(p.owns("/other", "ses_1")).toBe(false)
    expect(p.owns("/other", "ses_2")).toBe(false)
    expect(seen).toEqual(["ses_1", "ses_2"])
  })

  test("a different location with its own instance is owned by that instance only", () => {
    const registry: OwnerRegistry = new Map()
    const p = instance("/private/var/p", registry)
    const q = instance("/private/var/q", registry)
    expect(p.owns("/private/var/q")).toBe(false)
    expect(q.owns("/private/var/q")).toBe(true)
  })

  test("unknown directories are processed", () => {
    const registry: OwnerRegistry = new Map()
    const p = instance("/private/var/p", registry)
    expect(p.owns(undefined)).toBe(true)
    expect(instance(undefined, registry).owns("/other")).toBe(true)
  })

  test("a directory that does not resolve is compared as written", () => {
    const registry: OwnerRegistry = new Map()
    const a = instance("/gone/a", registry)
    expect(a.owns("/gone/b")).toBe(false)
    const b = instance("/gone/b", registry)
    expect(a.owns("/gone/b")).toBe(false)
    expect(b.owns("/gone/b")).toBe(true)
  })

  test("two instances with the same directory share a count, and unregister decrements", () => {
    const registry: OwnerRegistry = new Map()
    const one = instance("/private/var/p", registry)
    const two = instance("/private/var/p", registry)
    expect(registry.get("/private/var/p")).toBe(2)
    one.unregister()
    one.unregister()
    expect(registry.get("/private/var/p")).toBe(1)
    two.unregister()
    expect(registry.has("/private/var/p")).toBe(false)
    expect(registry.size).toBe(0)
  })

  test("an instance without a directory does not register", () => {
    const registry: OwnerRegistry = new Map()
    instance(undefined, registry).unregister()
    expect(registry.size).toBe(0)
  })

  test("the global registry is one shared map", () => {
    expect(globalOwnerRegistry()).toBe(globalOwnerRegistry())
    expect((globalThis as any)[Symbol.for("td-opencode-plugin.telemetry.owners")]).toBe(globalOwnerRegistry())
  })
})
