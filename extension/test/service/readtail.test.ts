import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nodeFs, readTailFrom, type TailHandle } from "../../service/ports.ts"

/** A handle over `content` whose `read` returns at most `chunk` bytes per call, like a short read. */
function shortReads(content: Buffer, chunk: number, calls: number[] = []): TailHandle {
  return {
    async stat() {
      return { size: content.length }
    },
    async read(buffer, offset, length, position) {
      const n = Math.min(chunk, length, Math.max(0, content.length - position))
      content.copy(buffer, offset, position, position + n)
      calls.push(n)
      return { bytesRead: n }
    },
  }
}

describe("readTailFrom", () => {
  test("joins short reads until the wanted length", async () => {
    const content = Buffer.from("first\nsecond\nthird\n")
    const calls: number[] = []
    const result = await readTailFrom(shortReads(content, 4, calls), 1024)
    expect(result).toEqual({ text: "first\nsecond\nthird\n", truncated: false })
    expect(calls.length).toBeGreaterThan(2)
  })

  test("two partial chunks then end of file decode only the bytes read, with no null padding", async () => {
    const content = Buffer.from("0123456789")
    let call = 0
    const handle: TailHandle = {
      async stat() {
        return { size: 100 }
      },
      async read(buffer, offset, _length, position) {
        call++
        if (call === 1) return { bytesRead: content.copy(buffer, offset, position, position + 4) }
        if (call === 2) return { bytesRead: content.copy(buffer, offset, 4, 8) }
        return { bytesRead: 0 }
      },
    }
    // The file reports 100 bytes but ends after 8: the text must stop there.
    const result = await readTailFrom(handle, 100)
    expect(result.text).toBe("01234567")
    expect(result.text).not.toContain("\0")
    expect(result.truncated).toBe(false)
  })

  test("reads the tail with the same 1 MiB style cap and reports truncated", async () => {
    const content = Buffer.from("abcdefghij")
    const result = await readTailFrom(shortReads(content, 3), 4)
    expect(result).toEqual({ text: "ghij", truncated: true })
  })

  test("an empty file reads as empty text", async () => {
    expect(await readTailFrom(shortReads(Buffer.alloc(0), 3), 10)).toEqual({ text: "", truncated: false })
  })
})

describe("nodeFs.readTail", () => {
  let dir = ""
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  test("reads a real file's tail and returns null when it is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "td-guards-tail-"))
    const file = join(dir, "log.jsonl")
    writeFileSync(file, "line1\nline2\nline3\n")
    expect(await nodeFs.readTail(file, 1000)).toEqual({ text: "line1\nline2\nline3\n", truncated: false })
    expect(await nodeFs.readTail(file, 8)).toEqual({ text: "2\nline3\n", truncated: true })
    expect(await nodeFs.readTail(join(dir, "missing"), 8)).toBeNull()
  })
})
