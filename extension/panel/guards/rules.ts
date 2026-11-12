/**
 * Plain-language text for guard rules. The panel builds it from the rule data
 * itself, so the text always matches what the plugin enforces. The model's own
 * summary is shown separately, after this text, and never replaces it.
 *
 * The text follows the matcher exactly: a command rule matches the program, then
 * ANY listed subcommand prefix, then ALL listed flags. A permission rule matches
 * the exact action name and ANY listed resource glob.
 */
import { COMMAND_ACTIONS, type Rule } from "./shared.ts"

/** Permission actions with a short name for people. Other actions show their exact name. */
const ACTION_NAMES: Record<string, string> = {
  shell: "shell commands",
  edit: "file edits",
  write: "file writes",
  patch: "file patches",
  subagent: "subagent starts",
}

export const actionName = (action: string): string => ACTION_NAMES[action] ?? `"${action}" permission requests`

const quoteList = (items: readonly string[]): string => items.map((item) => `"${item}"`).join(", ")

/** One line per rule, for example `Blocks shell command: git commit`. */
export const describeRule = (rule: Rule): string => {
  if (rule.kind === "command") {
    const prefixes = (rule.subcommands ?? []).filter((prefix) => prefix.length > 0)
    const commands = prefixes.length === 0 ? [`${rule.program} (any use)`] : prefixes.map((prefix) => [rule.program, ...prefix].join(" "))
    const flags =
      rule.flags && rule.flags.length > 0
        ? rule.flags.length === 1
          ? `, only with ${rule.flags[0]}`
          : `, only with all of ${rule.flags.join(" ")}`
        : ""
    return `Blocks ${commands.length === 1 ? "shell command" : "shell commands"}: ${commands.join(", ")}${flags}`
  }
  const resources = rule.resources && rule.resources.length > 0 ? ` matching ${quoteList(rule.resources)}` : " (all)"
  return `Blocks ${actionName(rule.action)}${resources}`
}

/** When the rule can apply. Shown under each rule. */
export const ruleCoverage = (rule: Rule): string => {
  if (rule.kind === "command") {
    return "Checked when the agent asks OpenCode to run a shell command. Commands hidden in scripts or other programs are not seen."
  }
  if (COMMAND_ACTIONS.includes(rule.action)) return `Checked against the text of each shell command the agent asks to run.`
  return `Applies only when a tool asks OpenCode for the exact "${rule.action}" permission. Tools that do not ask are not blocked.`
}

/** Actions of the rules that the plugin does not report it can block. Empty when the plugin did not report. */
export const uncoveredActions = (rules: readonly Rule[], covered: readonly string[] | null): string[] => {
  if (!covered || covered.length === 0) return []
  const needed = new Set(rules.map((rule) => (rule.kind === "command" ? "shell" : rule.action)))
  return [...needed].filter((action) => !covered.includes(action))
}
