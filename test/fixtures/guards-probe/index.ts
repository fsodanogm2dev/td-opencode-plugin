/**
 * Feasibility probe plugin (test fixture only, not shipped).
 *
 * Registers `ctx.permission.hook("evaluate")`, appends one JSON line per evaluation to `options.logFile`, and
 * denies any evaluation whose action, resources, or metadata contain `options.denyToken`.
 * It also records `ctx.session.get(sessionID).parentID` so the test can show the child -> parent link.
 */

import { appendFileSync } from "node:fs"

interface ProbeOptions {
  logFile: string
  denyToken: string
  message?: string
}

const plugin = {
  id: "guards-probe",
  async setup(ctx: any) {
    const options = ctx.options as unknown as ProbeOptions
    const write = (entry: Record<string, unknown>) => appendFileSync(options.logFile, `${JSON.stringify(entry)}\n`)
    write({ kind: "setup" })
    await ctx.permission.hook("evaluate", async (event: any) => {
      let parentID: string | undefined
      let sessionError: string | undefined
      try {
        const info = await ctx.session.get({ sessionID: event.sessionID })
        parentID = info?.parentID
      } catch (error) {
        sessionError = String(error)
      }
      const haystack = JSON.stringify({ action: event.action, resources: event.resources, metadata: event.metadata })
      const denied = haystack.includes(options.denyToken)
      write({
        kind: "evaluate",
        sessionID: event.sessionID,
        parentID,
        sessionError,
        agent: event.agent,
        action: event.action,
        resources: event.resources,
        metadata: event.metadata,
        source: event.source,
        incomingEffect: event.effect,
        incomingMessage: event.message,
        denied,
      })
      if (denied) {
        event.effect = "deny"
        event.message = options.message ?? "TD guard blocks this action"
      }
    })
    return async () => {}
  },
}

export default plugin
