import { describe, expect, test } from "bun:test"
import { currentPluginSource, detectPluginSource } from "../../../src/fuelix/plugin-source.ts"

describe("detectPluginSource", () => {
  test("extension folder", () => {
    expect(detectPluginSource("file:///Users/me/.config/openchamber/extensions/td-fuelix/plugin/index.js")).toBe("extension")
    expect(detectPluginSource("file:///C:/Users/me/AppData/Roaming/openchamber/extensions/td-fuelix/plugin/index.js")).toBe("extension")
  })

  test("git install in the OpenCode package cache", () => {
    expect(
      detectPluginSource(
        "file:///Users/me/.cache/opencode/npm/git-td-opencode-plugin-091d548438f4/1793215284243/node_modules/td-opencode-plugin/src/index.ts",
      ),
    ).toBe("git")
    expect(
      detectPluginSource(
        "file:///C:/Users/me/AppData/Local/opencode/npm/git-td-opencode-plugin-091d548438f4/1/node_modules/td-opencode-plugin/src/index.ts",
      ),
    ).toBe("git")
  })

  test("npm install", () => {
    expect(detectPluginSource("file:///Users/me/proj/node_modules/td-opencode-plugin/src/index.ts")).toBe("npm")
    expect(detectPluginSource("file:///Users/me/.cache/opencode/npm/td-opencode-plugin@0.8.1/node_modules/td-opencode-plugin/src/index.ts")).toBe("npm")
    expect(detectPluginSource("file:///C:/Users/me/proj/node_modules/td-opencode-plugin/src/index.ts")).toBe("npm")
  })

  test("folder", () => {
    expect(detectPluginSource("file:///Users/me/work/td-opencode-plugin/src/index.ts")).toBe("folder")
    expect(detectPluginSource("file:///C:/work/td-opencode-plugin/src/index.ts")).toBe("folder")
    expect(detectPluginSource("")).toBe("folder")
    expect(detectPluginSource("not a url")).toBe("folder")
  })

  test("a git-like directory outside the OpenCode cache is a folder", () => {
    expect(detectPluginSource("file:///Users/me/git-stuff/td-opencode-plugin/src/index.ts")).toBe("folder")
  })

  test("accepts a Windows path with backslashes", () => {
    expect(detectPluginSource("C:\\Users\\me\\AppData\\Roaming\\openchamber\\extensions\\td\\plugin\\index.js")).toBe("extension")
  })

  test("the current module is a source checkout", () => {
    expect(currentPluginSource()).toBe("folder")
  })
})
