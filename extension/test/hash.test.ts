import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"

import { reportPath, sha256Hex, sha256HexPure } from "../panel/hash.ts"

const SAMPLES = ["", "abc", "/work/example-project", "/Users/ana/Código/ñandú 🚀", "x".repeat(55), "y".repeat(64), "z".repeat(1000)]

const nodeHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

describe("sha256", () => {
  test("the pure implementation matches node:crypto for UTF-8 input", () => {
    for (const sample of SAMPLES) expect(sha256HexPure(sample)).toBe(nodeHash(sample))
  })

  test("the WebCrypto path matches node:crypto", async () => {
    for (const sample of SAMPLES) expect(await sha256Hex(sample)).toBe(nodeHash(sample))
  })
})

describe("reportPath", () => {
  test("a directory maps to its hash", async () => {
    expect(await reportPath("/work/example-project")).toBe(
      `~/.td-opencode-plugin/status/${nodeHash("/work/example-project")}.json`,
    )
  })

  test("no directory maps to global.json", async () => {
    expect(await reportPath(null)).toBe("~/.td-opencode-plugin/status/global.json")
  })
})
