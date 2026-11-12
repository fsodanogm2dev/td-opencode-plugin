import { describe, expect, test } from "bun:test"
import { analyzeCommand, COMMAND_BUDGET } from "../../../src/guards/command.ts"
import { globMatches, matchRules, previewCommand, previewMatch, previewPermission } from "../../../src/guards/matcher.ts"
import type { Rule } from "../../../src/guards/schema.ts"

const gitCommit: Rule[] = [{ kind: "command", program: "git", subcommands: [["commit"]] }]
const hits = (rules: Rule[], command: string) => previewCommand(rules, command)?.reason

describe("command matcher: git commit", () => {
  const blocked = [
    "git commit -m x",
    "git commit",
    "/usr/bin/git commit -m x",
    "git -C /tmp/repo commit -m x",
    "git -c user.name=a -c user.email=b commit -m x",
    "git --git-dir=/x/.git --work-tree=/x commit",
    "git --git-dir /x/.git commit",
    "git --no-pager commit",
    "FOO=bar git commit",
    "FOO=bar BAZ='a b' git commit",
    "env git commit",
    "env -i FOO=1 git commit",
    "env -u HOME git commit",
    "command git commit",
    "sudo git commit",
    "sudo -u root git commit",
    "nohup git commit",
    "time git commit",
    "timeout 5 git commit",
    "xargs git commit",
    "exec git commit",
    "git add . && git commit -m x",
    "git add .; git commit -m x",
    "false || git commit",
    "echo hi | git commit",
    "(git commit)",
    "{ git commit; }",
    "if true; then git commit; fi",
    "bash -c 'git commit -m x'",
    'sh -c "git commit"',
    "zsh -lc 'git commit'",
    "bash -c 'bash -c \"git commit\"'",
    "eval 'git commit'",
    "eval git commit",
    "echo $(git commit)",
    "echo `git commit`",
    'echo "$(git commit)"',
    "X=$(git commit) true",
    "find . -exec git commit {} \\;",
    "cat <<EOF | sh\ngit commit\nEOF",
    "sh <<EOF\ngit commit\nEOF",
    "echo 'git commit' | sh",
    "g\"i\"t commit",
    "\\git commit",
    "git-commit -m x",
    "git commit > /dev/null 2>&1",
    "2>&1 git commit",
    "git commit\n",
    "echo ok\ngit commit",
    "git \\\ncommit",
  ]
  for (const command of blocked) {
    test(`matches ${JSON.stringify(command)}`, () => {
      expect(hits(gitCommit, command)).toBeDefined()
    })
  }

  const allowed = [
    "echo 'git commit'",
    'echo "git commit -m x"',
    "printf '%s' 'git commit'",
    "git status",
    "git log --oneline",
    "git -C /tmp commit-tree HEAD",
    "grep commit file.txt",
    "gitk commit",
    "git add . && git push",
    "git commits",
    "cat <<'EOF'\ngit commit\nEOF",
    "cat <<EOF\ngit commit\nEOF",
    "echo hi > git.txt # commit",
    "git config user.name commit",
    "cd /tmp/git && ls commit",
    "command -v git commit",
  ]
  for (const command of allowed) {
    test(`allows ${JSON.stringify(command)}`, () => {
      expect(hits(gitCommit, command)).toBeUndefined()
    })
  }
})

describe("command matcher: flags and subcommand prefixes", () => {
  const force: Rule[] = [{ kind: "command", program: "git", subcommands: [["push"]], flags: ["--force"] }]
  test("requires every flag and a subcommand", () => {
    expect(hits(force, "git push --force origin main")).toBe("command")
    expect(hits(force, "git push --force-with-lease")).toBeUndefined()
    expect(hits(force, "git push --force=yes")).toBe("command")
    expect(hits(force, "git push origin main")).toBeUndefined()
    expect(hits(force, "git fetch --force")).toBeUndefined()
    expect(hits(force, "git push -- --force")).toBeUndefined()
  })
  test("short flag clusters", () => {
    const m: Rule[] = [{ kind: "command", program: "git", subcommands: [["commit"]], flags: ["-m"] }]
    expect(hits(m, "git commit -m 'a b'")).toBe("command")
    expect(hits(m, "git commit -am msg")).toBe("command")
    expect(hits(m, "git commit -mmsg")).toBe("command")
    expect(hits(m, "git commit --amend")).toBeUndefined()
  })
  test("multiple subcommand prefixes and words", () => {
    const rules: Rule[] = [{ kind: "command", program: "git", subcommands: [["remote", "add"], ["push"]] }]
    expect(hits(rules, "git remote add origin x")).toBe("command")
    expect(hits(rules, "git push")).toBe("command")
    expect(hits(rules, "git remote -v")).toBeUndefined()
  })
  test("a program-only rule matches any use", () => {
    const rules: Rule[] = [{ kind: "command", program: "rm" }]
    expect(hits(rules, "rm -rf /tmp/x")).toBe("command")
    expect(hits(rules, "echo rm")).toBeUndefined()
  })
  test("global options of other programs", () => {
    const rules: Rule[] = [{ kind: "command", program: "kubectl", subcommands: [["delete"]] }]
    expect(hits(rules, "kubectl -n prod delete pod x")).toBe("command")
    expect(hits(rules, "kubectl --context a get pods")).toBeUndefined()
  })
})

describe("conservative fallback", () => {
  test("dynamic program matches only when guarded tokens are literal", () => {
    expect(hits(gitCommit, '$GIT commit -m x')).toBe("command-dynamic")
    expect(hits(gitCommit, '"$(which git)" commit')).toBe("command-dynamic")
    expect(hits(gitCommit, "$CMD status")).toBeUndefined()
    expect(hits(gitCommit, "$CMD foo bar")).toBeUndefined()
  })
  test("over-budget input uses the raw token scan", () => {
    const huge = `${"echo ok; ".repeat(COMMAND_BUDGET.chars / 8 + 10)}git commit`
    expect(analyzeCommand(huge).fallback).toBe(true)
    expect(hits(gitCommit, huge)).toBe("command-fallback")
    expect(hits(gitCommit, `${"echo ok; ".repeat(COMMAND_BUDGET.chars / 8 + 10)}git status`)).toBeUndefined()
  })
  test("deep nesting uses the raw token scan", () => {
    let command = "git commit"
    for (let i = 0; i < 12; i++) command = `bash -c ${JSON.stringify(command)}`
    expect(analyzeCommand(command).fallback).toBe(true)
    expect(previewMatch(gitCommit, command).matched).toBe(true)
    expect(previewMatch(gitCommit, command).fallback).toBe(true)
  })
  test("unterminated quotes do not throw", () => {
    expect(hits(gitCommit, "git commit -m 'unterminated")).toBe("command")
    expect(() => analyzeCommand('echo "$(')).not.toThrow()
  })
})

describe("permission rules and globs", () => {
  test("glob semantics", () => {
    expect(globMatches("/a/*.ts", "/a/b.ts")).toBe(true)
    expect(globMatches("/a/*.ts", "/a/b/c.ts")).toBe(false)
    expect(globMatches("/a/**", "/a/b/c.ts")).toBe(true)
    expect(globMatches("/a/**/c.ts", "/a/b/c.ts")).toBe(true)
    expect(globMatches("/a/?.ts", "/a/b.ts")).toBe(true)
    expect(globMatches("/a/?.ts", "/a//.ts")).toBe(false)
    expect(globMatches("*.env", ".env")).toBe(true)
    expect(globMatches("a.b", "aXb")).toBe(false)
    expect(globMatches("(a|b)+", "(a|b)+")).toBe(true) // Regular expression syntax is literal.
  })
  test("glob matching is linear on adversarial input", () => {
    const start = Date.now()
    expect(globMatches("*a*a*a*a*a*a*a*a*a*a*b", "a".repeat(4000))).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })
  const rules: Rule[] = [{ kind: "permission", action: "edit", resources: ["/repo/secrets/**", "**/.env"] }]
  test("action is exact and any resource may match", () => {
    expect(previewPermission(rules, "edit", "/repo/secrets/a.txt")?.reason).toBe("permission")
    expect(previewPermission(rules, "edit", "/repo/x/.env")).toBeDefined()
    expect(previewPermission(rules, "edit", "/repo/src/a.ts")).toBeUndefined()
    expect(previewPermission(rules, "write", "/repo/secrets/a.txt")).toBeUndefined()
    expect(matchRules(rules, { action: "edit", resources: ["/repo/src/a.ts", "/repo/secrets/b"] })).toBeDefined()
  })
  test("no resources means any resource", () => {
    expect(matchRules([{ kind: "permission", action: "subagent" }], { action: "subagent", resources: ["general"] })).toBeDefined()
  })
  test("command rules apply only to the shell action", () => {
    expect(matchRules(gitCommit, { action: "edit", resources: ["git commit"] })).toBeUndefined()
    expect(matchRules(gitCommit, { action: "shell", resources: ["git commit -m x"] })).toBeDefined()
  })
  test("metadata.command is also checked", () => {
    expect(matchRules(gitCommit, { action: "shell", resources: ["ls"], metadata: { command: "git commit" } })).toBeDefined()
  })
})
