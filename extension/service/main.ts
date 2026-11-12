/**
 * Entry of the TD-Plugin guard service. The OpenChamber host starts it (`service/main.js`) and sets
 * `OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN`. It listens on 127.0.0.1 only.
 *
 * The service is the only writer of guard intent (`~/.td-opencode-plugin/guards/store.json`). It exposes no
 * model-facing tool. Removing the extension does not delete the store.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { backendSchema } from "./backend-port.ts"
import { createApp } from "./app.ts"
import { createHttpServer } from "./http.ts"
import { nodeRuntime } from "./ports.ts"
import { createSessionBridge } from "./session.ts"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN

if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) {
  console.error("td-guards service: OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required")
  process.exit(1)
}

const app = createApp({
  runtime: nodeRuntime(),
  schema: backendSchema,
  root: join(homedir(), ".td-opencode-plugin"),
  token,
  bridge: createSessionBridge(process.env),
  // Log fixed codes only. Never log tokens, paths, commands, or request bodies.
  log: (code) => console.error(`td-guards service: ${code}`),
})

const server = createHttpServer(app)
server.listen(port, "127.0.0.1")
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
