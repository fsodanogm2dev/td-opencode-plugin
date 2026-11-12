/**
 * Development preview, not shipped. Shows the real built panel in sandboxed
 * iframes, each driven by the mock host with a fake report.
 * Run: bun test/preview/serve.ts, then open http://localhost:4319/test/preview/
 */
import { reportPath } from "../../panel/hash.ts"
import { json, OTHER_PROJECT, PROJECT, scenarios } from "../support/fixtures.ts"
import { createMockHost, LIGHT_THEME, type FileAnswer } from "../support/mock-host.ts"

type Case = {
  label: string
  directory: string | null
  answer: FileAnswer | null
  light?: boolean
  width?: number
  height: number
}

const report = (value: unknown): FileAnswer => ({ content: json(value) })

const CASES: Case[] = [
  { label: "Models added", directory: PROJECT, answer: report(scenarios.added), height: 1400 },
  { label: "No change (earlier change kept)", directory: PROJECT, answer: report(scenarios.unchanged), height: 1400 },
  { label: "Changes found, reload failed", directory: PROJECT, answer: report(scenarios.reloadFailed), height: 1400 },
  { label: "No FueliX key", directory: PROJECT, answer: report(scenarios.noKey), height: 1400 },
  { label: "Rejected result", directory: PROJECT, answer: report(scenarios.rejected), height: 1400 },
  { label: "Check failed", directory: PROJECT, answer: report(scenarios.failed), height: 1400 },
  { label: "Out of date report", directory: PROJECT, answer: report(scenarios.stale), height: 1400 },
  { label: "First check running", directory: PROJECT, answer: report(scenarios.firstCheckPending), height: 1400 },
  { label: "No report", directory: OTHER_PROJECT, answer: null, height: 420 },
  { label: "File access not approved", directory: PROJECT, answer: { code: "NOT_GRANTED" }, height: 420 },
  { label: "Damaged report", directory: PROJECT, answer: { content: "{ half" }, height: 420 },
  { label: "No project open", directory: null, answer: report(scenarios.global), height: 1400 },
  { label: "Light theme", directory: PROJECT, answer: report(scenarios.added), light: true, height: 1400 },
  { label: "Narrow rail (300px)", directory: PROJECT, answer: report(scenarios.rejected), width: 300, height: 1700 },
  {
    label: "Narrow rail (300px), light",
    directory: PROJECT,
    answer: report(scenarios.failed),
    light: true,
    width: 300,
    height: 1700,
  },
]

const grid = document.getElementById("grid")!
const only = new URLSearchParams(location.search).get("case")

for (const [index, item] of CASES.entries()) {
  if (only !== null && Number(only) !== index) continue
  const figure = document.createElement("figure")
  const caption = document.createElement("figcaption")
  caption.textContent = `${index}. ${item.label}`
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.title = item.label
  frame.style.width = `${item.width ?? 360}px`
  frame.style.height = `${item.height}px`
  frame.style.background = item.light ? LIGHT_THEME.tokens.background : "#151313"
  figure.append(caption, frame)
  grid.append(figure)

  const mock = createMockHost({ post: (data) => frame.contentWindow?.postMessage(data, "*") })
  if (item.light) mock.setTheme(LIGHT_THEME)
  void reportPath(item.directory).then((path) => {
    if (item.answer) mock.files.set(path, item.answer)
  })
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: string }
    if (data?.type === "hello") {
      void reportPath(item.directory).then(() => mock.ready(item.directory))
      return
    }
    mock.receive(event.data)
  })
  frame.src = "/panel/index.html"
}
