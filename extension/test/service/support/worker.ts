/** Child process used by the cross-process tests. Real file system, real process, fake token. */
import { createApp } from "../../../service/app.ts"
import { backendSchema } from "../../../service/backend-port.ts"
import { acquireLock } from "../../../service/lock.ts"
import { nodeFs, nodeRuntime, type FsPort } from "../../../service/ports.ts"

const [mode, rootArg, a = "", b = ""] = process.argv.slice(2)
if (!mode || !rootArg) throw new Error("usage: worker <mode> <root> [args]")
const root: string = rootArg

const draft = (label: string) => ({
  label,
  summary: "Blocks git commit commands.",
  request: "Never commit for me.",
  message: "Blocked by a guard.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
})

function runtime(fs: FsPort) {
  return { ...nodeRuntime(), fs }
}

function app(fs: FsPort = nodeFs) {
  return createApp({ runtime: runtime(fs), schema: backendSchema, root, token: "t", bridge: null, lockTimeoutMs: 20_000 })
}

const headers = { authorization: "Bearer t" }
const kill = () => process.kill(process.pid, "SIGKILL")

if (mode === "create") {
  // a = label prefix, b = count
  const service = app()
  let ok = 0
  for (let i = 0; i < Number(b); i++) {
    const response = await service.handle({
      method: "POST",
      url: "/guards",
      headers,
      body: JSON.stringify({ opId: `op-${a}-${String(i).padStart(4, "0")}`, draft: draft(`${a}-${i}`) }),
    })
    if (response.status === 200) ok++
  }
  console.log(JSON.stringify({ ok }))
} else if (mode === "crash-before-rename" || mode === "crash-after-rename") {
  const fs: FsPort = {
    ...nodeFs,
    async rename(from, to) {
      if (to.endsWith("store.json")) {
        if (mode === "crash-before-rename") kill()
        await nodeFs.rename(from, to)
        kill()
      }
      return nodeFs.rename(from, to)
    },
  }
  await app(fs).handle({
    method: "POST",
    url: "/guards",
    headers,
    body: JSON.stringify({ opId: a, draft: draft("crash") }),
  })
  console.log("unreachable")
} else if (mode === "hold-lock") {
  const lock = await acquireLock({ runtime: nodeRuntime(), path: `${root}/guards/store.lock`, timeoutMs: 5000 })
  console.log(JSON.stringify({ held: lock.owner.pid }))
  await new Promise(() => undefined)
} else {
  throw new Error(`unknown mode ${mode}`)
}
