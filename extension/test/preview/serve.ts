/**
 * Development preview server, not shipped. Serves the extension folder on
 * localhost so the preview can load the built panel in sandboxed iframes.
 * Usage: bun test/preview/serve.ts [port]
 */
import { join, normalize, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const port = Number(process.argv[2] ?? 4319)

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview.ts")],
  format: "iife",
  target: "browser",
})
if (!build.success || !build.outputs[0]) {
  console.error(build.logs.map((log) => log.message).join("\n"))
  process.exit(1)
}
const previewJs = await build.outputs[0].text()

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/test/preview/preview.js") {
      return new Response(previewJs, { headers: { "content-type": "text/javascript" } })
    }
    let path = normalize(decodeURIComponent(url.pathname))
    if (path.endsWith("/")) path += "index.html"
    if (!path.startsWith("/panel/") && !path.startsWith("/test/preview/")) return new Response("Not found", { status: 404 })
    const file = Bun.file(join(root, path))
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 })
  },
})
console.log(`Preview: http://127.0.0.1:${port}/test/preview/`)
