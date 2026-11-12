import { describe, expect, test } from "bun:test"

import { createController, type PanelState } from "../panel/controller.ts"
import { json, OTHER_PROJECT, PROJECT, scenarios, withReport } from "./support/fixtures.ts"

type Pending = { path: string; resolve: (content: string) => void; reject: (error: unknown) => void }

const setup = () => {
  const pending: Pending[] = []
  const states: PanelState[] = []
  const controller = createController({
    reader: {
      readFile: (path) =>
        new Promise((resolve, reject) => {
          pending.push({ path, resolve: (content) => resolve({ content }), reject })
        }),
    },
    reportPath: async (directory) => `path:${directory}`,
    onChange: (state) => states.push(state),
  })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { controller, pending, states, flush }
}

const hostError = (code: string) => Object.assign(new Error(code), { code })

describe("controller", () => {
  test("reads the current location's report", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    expect(pending[0]?.path).toBe(`path:${PROJECT}`)
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(controller.state().kind).toBe("report")
  })

  test("discards a slower answer for a location the user left", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    controller.setDirectory(OTHER_PROJECT)
    await flush()
    pending[1]!.resolve(json(withReport({}, OTHER_PROJECT)))
    await flush()
    pending[0]!.resolve(json(scenarios.added))
    await flush()
    const state = controller.state()
    expect(state.kind === "report" && state.directory).toBe(OTHER_PROJECT)
  })

  test("a repeated snapshot for the same location does not read again", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    controller.setDirectory(PROJECT)
    await flush()
    expect(pending).toHaveLength(1)
  })

  test("NOT_FOUND means no report", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.reject(hostError("NOT_FOUND"))
    await flush()
    expect(controller.state().kind).toBe("missing")
  })

  test("missing permission is an error state", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.reject(hostError("NOT_GRANTED"))
    await flush()
    const state = controller.state()
    expect(state.kind === "error" && state.code).toBe("NOT_GRANTED")
  })

  test("a report that names another location is not shown", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(withReport({}, OTHER_PROJECT)))
    await flush()
    const state = controller.state()
    expect(state.kind === "invalid" && state.problem).toBe("other-location")
  })

  test("a failed reload keeps the copy on screen and says so", async () => {
    const { controller, pending, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    controller.reload()
    expect(controller.state().kind === "report" && (controller.state() as { reloading: boolean }).reloading).toBe(true)
    await flush()
    pending[1]!.reject(hostError("HOST_TIMEOUT"))
    await flush()
    const state = controller.state()
    expect(state.kind).toBe("report")
    expect(state.kind === "report" && state.reloadError).toBe("HOST_TIMEOUT")
    expect(state.kind === "report" && state.reloading).toBe(false)
  })

  test("a quiet poll with the same content does not repaint", async () => {
    const { controller, pending, states, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    const before = states.length
    controller.reload({ quiet: true })
    await flush()
    pending[1]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(states.length).toBe(before)
  })

  test("nothing changes after dispose", async () => {
    const { controller, pending, states, flush } = setup()
    controller.setDirectory(PROJECT)
    await flush()
    controller.dispose()
    pending[0]!.resolve(json(scenarios.unchanged))
    await flush()
    expect(states.at(-1)?.kind).toBe("loading")
    controller.setDirectory(OTHER_PROJECT)
    await flush()
    expect(pending).toHaveLength(1)
  })
})
