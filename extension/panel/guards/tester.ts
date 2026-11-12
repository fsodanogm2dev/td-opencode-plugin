/**
 * The sample command test in the preview. It calls the shared matcher, the same
 * function the plugin uses before a shell command runs. Nothing is executed.
 */
import { previewCommand, type Rule } from "./shared.ts"

export type TestResult =
  | { kind: "empty" }
  /** `certain` is false when the matcher could not read the command exactly and matched to be safe. */
  | { kind: "blocked"; rule: Rule; index: number; certain: boolean }
  | { kind: "allowed" }

export const testCommand = (rules: readonly Rule[], command: string): TestResult => {
  if (!command.trim()) return { kind: "empty" }
  const match = previewCommand(rules, command)
  if (!match) return { kind: "allowed" }
  return { kind: "blocked", rule: match.rule, index: match.index, certain: match.reason === "command" || match.reason === "permission" }
}
