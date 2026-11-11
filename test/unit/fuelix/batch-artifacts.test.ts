import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatchArtifactError, BatchArtifacts } from "../../../src/fuelix/batch/artifacts.ts"

let base: string
let root: string
let artifacts: BatchArtifacts

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "td-batch-artifacts-"))
  root = join(base, "plugin", "batch")
  artifacts = new BatchArtifacts(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const mode = async (path: string) => (await lstat(path)).mode & 0o777

describe("BatchArtifacts", () => {
  test("requires an absolute root", () => {
    expect(() => new BatchArtifacts("relative/dir")).toThrow(BatchArtifactError)
    expect(() => new BatchArtifacts("")).toThrow(BatchArtifactError)
  })

  test("writes and reads text and bytes with private modes", async () => {
    const path = await artifacts.write("job-1", "requests.json", '{"a":1}')
    expect(path).toBe(join(root, "job-1", "requests.json"))
    expect(await artifacts.read("job-1", "requests.json")).toBe('{"a":1}')
    expect(await mode(path)).toBe(0o600)
    expect(await mode(join(root, "job-1"))).toBe(0o700)
    expect(await mode(root)).toBe(0o700)

    await artifacts.write("job-1", "results.jsonl", new TextEncoder().encode("x\ny\n"))
    expect(await artifacts.read("job-1", "results.jsonl")).toBe("x\ny\n")
  })

  test("creates private directories even with a permissive umask", async () => {
    const old = process.umask(0o000)
    try {
      await artifacts.write("job_a", "manifest.json", "{}")
    } finally {
      process.umask(old)
    }
    expect(await mode(root)).toBe(0o700)
    expect(await mode(join(root, "job_a"))).toBe(0o700)
    expect(await mode(join(root, "job_a", "manifest.json"))).toBe(0o600)
  })

  test("path creates the job dir and returns the target path without creating the file", async () => {
    const path = await artifacts.path("job-2", "successes.jsonl")
    expect(path).toBe(join(root, "job-2", "successes.jsonl"))
    expect(await mode(join(root, "job-2"))).toBe(0o700)
    expect(await readdir(join(root, "job-2"))).toEqual([])
  })

  test("rejects unsafe job IDs and non-allowlisted names", async () => {
    for (const id of ["", "..", ".", "a/b", "../x", "a b", "a\0b", "a.b", "/abs"]) {
      await expect(artifacts.write(id, "requests.json", "x")).rejects.toThrow(BatchArtifactError)
      await expect(artifacts.read(id, "requests.json")).rejects.toThrow(BatchArtifactError)
      await expect(artifacts.path(id, "requests.json")).rejects.toThrow(BatchArtifactError)
    }
    for (const name of ["", "../requests.json", "other.json", "requests.json/", "/etc/passwd", "a/results.jsonl"]) {
      await expect(artifacts.write("job", name, "x")).rejects.toThrow(BatchArtifactError)
      await expect(artifacts.remove("job", name)).rejects.toThrow(BatchArtifactError)
    }
  })

  test("replaces an existing artifact atomically and leaves no temp files", async () => {
    await artifacts.write("job", "manifest.json", "old")
    await artifacts.write("job", "manifest.json", "new")
    expect(await artifacts.read("job", "manifest.json")).toBe("new")
    expect(await readdir(join(root, "job"))).toEqual(["manifest.json"])
  })

  test("a failed write keeps the existing artifact and removes the temp file", async () => {
    await artifacts.write("job", "manifest.json", "keep")
    // A non-string, non-buffer value makes writeFile fail after the temp file exists.
    await expect(artifacts.write("job", "manifest.json", 42 as unknown as string)).rejects.toThrow(BatchArtifactError)
    expect(await artifacts.read("job", "manifest.json")).toBe("keep")
    expect(await readdir(join(root, "job"))).toEqual(["manifest.json"])
  })

  test("jobs are independent", async () => {
    await artifacts.write("one", "results.jsonl", "1")
    await artifacts.write("two", "results.jsonl", "2")
    expect(await artifacts.read("one", "results.jsonl")).toBe("1")
    expect(await artifacts.read("two", "results.jsonl")).toBe("2")
    await artifacts.remove("one", "results.jsonl")
    await expect(artifacts.read("one", "results.jsonl")).rejects.toThrow()
    expect(await artifacts.read("two", "results.jsonl")).toBe("2")
  })

  test("remove ignores a missing artifact", async () => {
    await artifacts.remove("never", "failures.jsonl")
    await artifacts.write("job", "failures.jsonl", "f")
    await artifacts.remove("job", "failures.jsonl")
    await artifacts.remove("job", "failures.jsonl")
  })

  test("rejects a symlink root", async () => {
    const real = join(base, "real")
    await mkdir(real, { mode: 0o700 })
    await mkdir(join(base, "plugin"), { recursive: true })
    await symlink(real, root)
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
    expect(await readdir(real)).toEqual([])
  })

  test("rejects a root that is a file", async () => {
    await mkdir(join(base, "plugin"), { recursive: true })
    await writeFile(root, "x")
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
  })

  test("rejects a symlink job dir", async () => {
    const outside = join(base, "outside")
    await mkdir(outside, { mode: 0o700 })
    await mkdir(root, { recursive: true, mode: 0o700 })
    await symlink(outside, join(root, "job"))
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.read("job", "requests.json")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.path("job", "requests.json")).rejects.toThrow(BatchArtifactError)
    expect(await readdir(outside)).toEqual([])
  })

  test("rejects a job dir that is a file", async () => {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await writeFile(join(root, "job"), "x")
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
  })

  test("rejects a group- or world-accessible existing job dir without changing it", async () => {
    await mkdir(join(root, "job"), { recursive: true, mode: 0o700 })
    await chmod(join(root, "job"), 0o755)
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
    expect(await mode(join(root, "job"))).toBe(0o755)
  })

  test("rejects symlink targets and never writes through them", async () => {
    const secret = join(base, "secret.txt")
    await writeFile(secret, "original")
    await artifacts.path("job", "requests.json")
    await symlink(secret, join(root, "job", "requests.json"))
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.read("job", "requests.json")).rejects.toThrow()
    await expect(artifacts.path("job", "requests.json")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.remove("job", "requests.json")).rejects.toThrow(BatchArtifactError)
    expect(await readFile(secret, "utf8")).toBe("original")
    expect((await lstat(join(root, "job", "requests.json"))).isSymbolicLink()).toBe(true)
    expect(await readdir(join(root, "job"))).toEqual(["requests.json"])
  })

  test("rejects dangling symlink targets", async () => {
    await artifacts.path("job", "results.jsonl")
    await symlink(join(base, "nowhere"), join(root, "job", "results.jsonl"))
    await expect(artifacts.write("job", "results.jsonl", "x")).rejects.toThrow(BatchArtifactError)
    await expect(readdir(base)).resolves.not.toContain("nowhere")
  })

  test("rejects a FIFO target without hanging", async () => {
    await artifacts.path("job", "requests.json")
    const fifo = join(root, "job", "requests.json")
    const made = Bun.spawnSync(["mkfifo", fifo])
    expect(made.exitCode).toBe(0)
    const outcome = await Promise.race([
      artifacts.read("job", "requests.json").then(
        () => "resolved",
        (error: unknown) => (error instanceof BatchArtifactError ? "rejected" : "other"),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ])
    expect(outcome).toBe("rejected")
    await expect(artifacts.write("job", "requests.json", "x")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.remove("job", "requests.json")).rejects.toThrow(BatchArtifactError)
  })

  test("rejects non-regular targets", async () => {
    await artifacts.path("job", "failures.jsonl")
    await mkdir(join(root, "job", "failures.jsonl"))
    await expect(artifacts.write("job", "failures.jsonl", "x")).rejects.toThrow(BatchArtifactError)
    await expect(artifacts.read("job", "failures.jsonl")).rejects.toThrow()
    await expect(artifacts.remove("job", "failures.jsonl")).rejects.toThrow(BatchArtifactError)
    expect(await readdir(join(root, "job"))).toEqual(["failures.jsonl"])
  })
})
