/**
 * The questions that the decision points ask. Wording derives from opencode-jev-plugin (MIT, see
 * THIRD_PARTY_NOTICES.md).
 *
 * Question IDs follow the client rule `[A-Za-z0-9_-]{1,64}`, and one request carries at most `MAX_QUESTIONS` of them.
 */

import type { JevQuestions } from "./types.ts"

export { MAX_QUESTIONS } from "./client.ts"

export const SAFETY_QUESTION_ID = "is_destructive"

export function safetyQuestions(): JevQuestions {
  return {
    [SAFETY_QUESTION_ID]: {
      type: "noul",
      instructions: "Does this shell command permanently delete files, drop databases, or cause irreversible loss?",
      criteria: {
        true: "Command deletes files, truncates tables, drops databases, or reformats disks",
        false: "Command is non-destructive, read-only, informational, or an ordinary modification",
      },
    },
  }
}

export const ERROR_TYPE_QUESTION_ID = "error_type"
export const FLAKY_QUESTION_ID = "is_flaky"
export const ERROR_TYPES = ["assertion", "syntax", "environment", "timeout"] as const

export function testOutputQuestions(): JevQuestions {
  return {
    [ERROR_TYPE_QUESTION_ID]: {
      type: "choice",
      instructions: "What is the primary root cause category of this test or build failure?",
      criteria: {
        assertion: "Assertion or unit test failure (expected value did not match received)",
        syntax: "Syntax error, type checking error, or compilation failure",
        environment: "Missing module, command not found, or environment/configuration issue",
        timeout: "Test run timed out or stalled",
      },
    },
    [FLAKY_QUESTION_ID]: {
      type: "noul",
      instructions: "Is this failure likely caused by a network timeout, race condition, or port collision rather than bad code logic?",
      criteria: {
        true: "Transient failure, socket timeout, port busy, or flaky timing",
        false: "Legitimate code logic bug or assertion error",
      },
    },
  }
}

export const REASONING_QUESTION_ID = "reasoning_depth"

export function reasoningQuestions(): JevQuestions {
  return {
    [REASONING_QUESTION_ID]: {
      type: "score",
      instructions: "Score the cognitive reasoning needed for this user turn",
      criteria: [
        "Mechanical edit, typo, simple file read, status check, or trivial instruction",
        "Standard coding, minor bug fix, single component change, routine task",
        "Multi-module refactor, algorithm implementation, or complex debugging",
        "Novel architectural design, security audit, formal verification, or hard logic",
      ],
    },
  }
}

/** Question ID of the skill at `index` of the advertised list. Indexes keep skill IDs out of question IDs. */
export const skillQuestionId = (index: number): string => `s${index}`

/** One question per skill. The state carries the request and the skill descriptions, so the text names the ID only. */
export function skillQuestion(id: string) {
  return {
    type: "noul" as const,
    instructions: `Is the skill "${id}" from the skills list in the state relevant to the developer's request in the state?`,
    criteria: {
      true: "The developer's request needs this skill",
      false: "The developer's request does not need this skill",
    },
  }
}
