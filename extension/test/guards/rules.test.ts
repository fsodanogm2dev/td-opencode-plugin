import { describe, expect, test } from "bun:test"

import { describeRule, ruleCoverage, uncoveredActions } from "../../panel/guards/rules.ts"
import { testCommand } from "../../panel/guards/tester.ts"
import type { Rule } from "../../panel/guards/shared.ts"

describe("rule text", () => {
  test("command rules name the program, each prefix, and every required flag", () => {
    expect(describeRule({ kind: "command", program: "git", subcommands: [["commit"]] })).toBe("Blocks shell command: git commit")
    expect(describeRule({ kind: "command", program: "git", subcommands: [["commit"], ["stash", "drop"]] })).toBe(
      "Blocks shell commands: git commit, git stash drop",
    )
    expect(describeRule({ kind: "command", program: "rm" })).toBe("Blocks shell command: rm (any use)")
    expect(describeRule({ kind: "command", program: "git", subcommands: [["push"]], flags: ["--force"] })).toBe(
      "Blocks shell command: git push, only with --force",
    )
    expect(describeRule({ kind: "command", program: "git", subcommands: [["push"]], flags: ["--force", "-u"] })).toBe(
      "Blocks shell command: git push, only with all of --force -u",
    )
  })

  test("permission rules name the exact action and say when they apply", () => {
    const edit: Rule = { kind: "permission", action: "edit", resources: ["**/.env"] }
    expect(describeRule(edit)).toBe('Blocks file edits matching "**/.env"')
    expect(ruleCoverage(edit)).toContain('exact "edit" permission')
    expect(describeRule({ kind: "permission", action: "subagent" })).toBe("Blocks subagent starts (all)")
    expect(describeRule({ kind: "permission", action: "webfetch" })).toBe('Blocks "webfetch" permission requests (all)')
  })

  test("actions the plugin does not report are listed", () => {
    const rules: Rule[] = [{ kind: "command", program: "git" }, { kind: "permission", action: "webfetch" }]
    expect(uncoveredActions(rules, ["shell", "edit"])).toEqual(["webfetch"])
    expect(uncoveredActions(rules, null)).toEqual([])
  })
})

describe("sample command test", () => {
  const rules: Rule[] = [{ kind: "command", program: "git", subcommands: [["commit"]] }]

  test("uses the enforcement matcher", () => {
    expect(testCommand(rules, "git commit -m wip")).toMatchObject({ kind: "blocked", index: 0, certain: true })
    expect(testCommand(rules, "cd repo && git commit")).toMatchObject({ kind: "blocked" })
    expect(testCommand(rules, "git status")).toEqual({ kind: "allowed" })
    expect(testCommand(rules, "git merge main")).toEqual({ kind: "allowed" })
    expect(testCommand(rules, "echo 'git commit'")).toEqual({ kind: "allowed" })
    expect(testCommand(rules, "  ")).toEqual({ kind: "empty" })
  })

  test("a command the matcher cannot read exactly is a possible match", () => {
    const result = testCommand(rules, "$GIT commit")
    if (result.kind === "blocked") expect(result.certain).toBe(false)
  })
})
