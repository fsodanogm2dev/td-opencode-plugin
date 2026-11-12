/**
 * Shell command analyzer. Pure: it parses text and never runs anything.
 *
 * It is a convenience matcher, not a security boundary. It finds the programs that a command line would start,
 * through quotes, separators, assignments, common wrappers (`env`, `sudo`, `command`, `nohup`, ...), `sh -c`
 * nesting, `eval`, `xargs`, `find -exec`, and command substitution. It cannot see what a script file or a
 * non-shell interpreter would run. Text that is only an argument (`echo 'git commit'`) is not an invocation.
 *
 * Malformed or over-budget input sets `fallback`. The matcher then looks for the guarded tokens in the raw text.
 */

export const COMMAND_BUDGET = {
  /** Longest command text that the parser accepts. */
  chars: 50_000,
  /** Longest raw text that the fallback scan reads. */
  fallbackChars: 1_000_000,
  segments: 512,
  depth: 6,
} as const

interface Word {
  text: string
  /** Contains a parameter expansion or a command substitution. */
  dynamic: boolean
  /** Contains an unquoted glob or tilde character. */
  glob: boolean
  /** Words of command substitutions inside this word. */
  inner: string[]
}

interface Segment {
  words: Word[]
  heredocs: string[]
  pipedFrom: Segment | undefined
}

export interface Invocation {
  /** Base name of the executable (or the raw word when `dynamicProgram`). */
  readonly program: string
  readonly args: readonly string[]
  /** The executable word was not literal (`$X`, `$(...)`, unquoted glob). */
  readonly dynamicProgram: boolean
  /** Extra words that a dynamic executable may have produced. */
  readonly hints: readonly string[]
}

export interface CommandAnalysis {
  readonly invocations: readonly Invocation[]
  /** True when the parser gave up. `raw` then holds the original text. */
  readonly fallback: boolean
  readonly raw: string
}

class BudgetExceeded extends Error {}

interface Budget {
  segments: number
}

// ---------------------------------------------------------------------------------------------------------------
// Tokenizer

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/

/** Finds `$(...)` / `` `...` `` / `<(...)` starting at `index`. Returns the inner text and the index after it. */
function findSubstitution(source: string, index: number): { inner: string; end: number } | undefined {
  const char = source[index]
  if (char === "`") {
    let i = index + 1
    while (i < source.length) {
      if (source[i] === "\\") i += 2
      else if (source[i] === "`") return { inner: source.slice(index + 1, i), end: i + 1 }
      else i++
    }
    return { inner: source.slice(index + 1), end: source.length }
  }
  const open = source[index] === "$" ? index + 1 : index + 1
  if (source[open] !== "(") return undefined
  let depth = 0
  let i = open
  let quote: string | undefined
  while (i < source.length) {
    const c = source[i]
    if (quote) {
      if (c === "\\" && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === "\\") i++
    else if (c === "'" || c === '"') quote = c
    else if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return { inner: source.slice(open + 1, i), end: i + 1 }
    }
    i++
  }
  return { inner: source.slice(open + 1), end: source.length }
}

function wordsOf(segments: readonly Segment[]): string[] {
  return segments.flatMap((segment) => segment.words.map((word) => word.text))
}

function splitScript(source: string, depth: number, budget: Budget): Segment[] {
  if (depth > COMMAND_BUDGET.depth) throw new BudgetExceeded()
  if (source.length > COMMAND_BUDGET.chars) throw new BudgetExceeded()
  const out: Segment[] = []
  let current: Segment = { words: [], heredocs: [], pipedFrom: undefined }
  let word: Word | undefined
  let skipNext = false
  let heredocNext: { strip: boolean } | undefined
  let delimiterQuoted = false
  const pending: { segment: Segment; delimiter: string; strip: boolean; quoted: boolean }[] = []
  let previous: Segment | undefined

  const push = (segment: Segment) => {
    if (++budget.segments > COMMAND_BUDGET.segments) throw new BudgetExceeded()
    out.push(segment)
  }
  const nested = (inner: string) => {
    const segments = splitScript(inner, depth + 1, budget)
    for (const segment of segments) push(segment)
    return wordsOf(segments)
  }
  const ensureWord = (): Word => (word ??= { text: "", dynamic: false, glob: false, inner: [] })
  const endWord = () => {
    if (!word) return
    const finished = word
    word = undefined
    if (heredocNext) {
      pending.push({ segment: current, delimiter: finished.text, strip: heredocNext.strip, quoted: delimiterQuoted })
      heredocNext = undefined
      delimiterQuoted = false
      return
    }
    if (skipNext) {
      skipNext = false
      return
    }
    current.words.push(finished)
  }
  const endSegment = (pipe: boolean) => {
    endWord()
    if (current.words.length > 0 || current.heredocs.length > 0) {
      push(current)
      previous = current
    }
    const next: Segment = { words: [], heredocs: [], pipedFrom: pipe ? previous : undefined }
    current = next
    skipNext = false
  }

  let i = 0
  const length = source.length
  while (i < length) {
    const c = source[i]!
    if (c === "\\") {
      if (source[i + 1] === "\n") {
        i += 2
        continue
      }
      const w = ensureWord()
      if (i + 1 < length) w.text += source[i + 1]
      i += 2
      continue
    }
    if (c === "'") {
      const w = ensureWord()
      const close = source.indexOf("'", i + 1)
      w.text += close === -1 ? source.slice(i + 1) : source.slice(i + 1, close)
      if (heredocNext) delimiterQuoted = true
      i = close === -1 ? length : close + 1
      continue
    }
    if (c === '"') {
      const w = ensureWord()
      if (heredocNext) delimiterQuoted = true
      i++
      while (i < length && source[i] !== '"') {
        const d = source[i]!
        if (d === "\\" && i + 1 < length) {
          const n = source[i + 1]!
          w.text += n === '"' || n === "\\" || n === "$" || n === "`" ? n : `\\${n}`
          i += 2
        } else if (d === "`" || (d === "$" && source[i + 1] === "(")) {
          const sub = findSubstitution(source, i)!
          w.dynamic = true
          w.inner.push(...nested(sub.inner))
          w.text += source.slice(i, sub.end)
          i = sub.end
        } else {
          if (d === "$") w.dynamic = true
          w.text += d
          i++
        }
      }
      i++
      continue
    }
    if (c === "`" || (c === "$" && source[i + 1] === "(")) {
      const w = ensureWord()
      const sub = findSubstitution(source, i)!
      w.dynamic = true
      w.inner.push(...nested(sub.inner))
      w.text += source.slice(i, sub.end)
      i = sub.end
      continue
    }
    if (c === "$") {
      const w = ensureWord()
      w.dynamic = true
      w.text += c
      i++
      if (source[i] === "{") {
        const close = source.indexOf("}", i)
        const end = close === -1 ? length : close + 1
        w.text += source.slice(i, end)
        i = end
      } else if (i < length && NAME_START.test(source[i]!)) {
        while (i < length && NAME_CHAR.test(source[i]!)) w.text += source[i++]
      } else if (i < length && /[0-9@*#?$!-]/.test(source[i]!)) {
        w.text += source[i++]
      }
      continue
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord()
      i++
      continue
    }
    if (c === "\n") {
      endSegment(false)
      i++
      // Heredoc bodies start after the line end.
      while (pending.length > 0) {
        const item = pending.shift()!
        const lines: string[] = []
        let found = false
        while (i < length) {
          let end = source.indexOf("\n", i)
          if (end === -1) end = length
          const line = source.slice(i, end)
          i = Math.min(end + 1, length)
          const compare = item.strip ? line.replace(/^\t+/, "") : line
          if (compare === item.delimiter) {
            found = true
            break
          }
          lines.push(line)
        }
        void found
        const body = lines.join("\n")
        item.segment.heredocs.push(body)
        if (!item.quoted && /`|\$\(/.test(body)) {
          // An unquoted heredoc expands substitutions.
          for (let j = 0; j < body.length; j++) {
            if (body[j] === "\\") j++
            else if (body[j] === "`" || (body[j] === "$" && body[j + 1] === "(")) {
              const sub = findSubstitution(body, j)!
              nested(sub.inner)
              j = sub.end - 1
            }
          }
        }
      }
      continue
    }
    if (c === ";" || c === "&" || c === "|") {
      if (c === "&" && source[i + 1] === ">") {
        // `&>file` and `&>>file` redirect both streams.
        endWord()
        i += source[i + 2] === ">" ? 3 : 2
        skipNext = true
        continue
      }
      const pipe = c === "|"
      endSegment(pipe)
      i++
      if ((c === "&" || c === "|") && source[i] === c) i++
      else if (c === "|" && source[i] === "&") i++
      else if (c === ";" && source[i] === ";") i++
      continue
    }
    if (c === "(" || c === ")") {
      endSegment(false)
      i++
      continue
    }
    if ((c === "<" || c === ">") && source[i + 1] === "(") {
      const w = ensureWord()
      const sub = findSubstitution(source, i)!
      w.dynamic = true
      w.inner.push(...nested(sub.inner))
      w.text += source.slice(i, sub.end)
      i = sub.end
      continue
    }
    if (c === "<" || c === ">") {
      // A word that is only digits before the operator is a file descriptor.
      if (word && /^\d+$/.test(word.text) && !word.dynamic) word = undefined
      else endWord()
      let operator = c
      i++
      if (c === "<" && source[i] === "<" && source[i + 1] === "<") {
        operator = "<<<"
        i += 2
      } else if (c === "<" && source[i] === "<") {
        operator = "<<"
        i++
        if (source[i] === "-") {
          operator = "<<-"
          i++
        }
      } else if (source[i] === c) {
        i++
      } else if (c === ">" && source[i] === "|") {
        i++
      } else if (source[i] === "&") {
        i++
        // `>&2` and `<&0` take a descriptor, not a file.
        while (i < length && /[0-9-]/.test(source[i]!)) i++
        continue
      } else if (c === "<" && source[i] === ">") {
        i++
      }
      if (operator === "<<" || operator === "<<-") heredocNext = { strip: operator === "<<-" }
      else skipNext = true
      continue
    }
    const w = ensureWord()
    if (c === "*" || c === "?" || c === "[" || (c === "~" && w.text === "")) w.glob = true
    w.text += c
    i++
  }
  endSegment(false)
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Wrapper resolution

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"])
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "time", "coproc"])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

/** Options that take a separate value, by wrapper. */
const VALUE_OPTIONS: Record<string, readonly string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S"],
  sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-U", "-D", "--user", "--group", "--host", "--prompt", "--chdir"],
  doas: ["-u", "-C"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-P", "-u"],
  nohup: [],
  setsid: [],
  exec: ["-a"],
  builtin: [],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  watch: ["-n", "--interval", "-d"],
  caffeinate: ["-t", "-w"],
  xargs: ["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "-J"],
  command: [],
}

function skipOptions(args: readonly string[], valueOptions: readonly string[]): string[] {
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg === "--") {
      index++
      break
    }
    if (!arg.startsWith("-") || arg === "-") break
    if (valueOptions.includes(arg)) index += 2
    else index += 1
  }
  return args.slice(index)
}

function basename(program: string): string {
  const slash = program.lastIndexOf("/")
  const name = slash === -1 ? program : program.slice(slash + 1)
  return name.endsWith(".exe") ? name.slice(0, -4) : name
}

function resolveWords(
  segment: Segment,
  words: Word[],
  depth: number,
  budget: Budget,
  out: Invocation[],
): void {
  if (depth > COMMAND_BUDGET.depth) throw new BudgetExceeded()
  let current = words
  for (let guard = 0; guard < 64; guard++) {
    // Reserved words (`if`, `{`, `time`) and leading assignments never name the program.
    while (current.length > 0 && ((!current[0]!.dynamic && RESERVED.has(current[0]!.text)) || ASSIGNMENT.test(current[0]!.text))) {
      current = current.slice(1)
    }
    if (current.length === 0) return
    const head = current[0]!
    const args = current.slice(1)
    const argTexts = args.map((arg) => arg.text)
    const hints = current.flatMap((entry) => entry.inner)
    if (head.dynamic || head.glob) {
      out.push({ program: head.text, args: argTexts, dynamicProgram: true, hints })
      return
    }
    const name = basename(head.text)
    const lower = name.toLowerCase()

    if (lower === "command") {
      const opts = args.filter((arg) => arg.text.startsWith("-")).map((arg) => arg.text)
      if (opts.some((opt) => /^-[a-z]*[vV]/.test(opt))) return // Lookup only. Nothing runs.
      let rest = args
      while (rest.length > 0 && rest[0]!.text.startsWith("-") && rest[0]!.text !== "--") rest = rest.slice(1)
      if (rest[0]?.text === "--") rest = rest.slice(1)
      current = rest
      continue
    }
    if (lower in VALUE_OPTIONS && lower !== "command") {
      if (lower === "env") {
        // `env -S 'cmd args'` splits one string into a command.
        const split = argTexts.findIndex((arg) => arg === "-S" || arg.startsWith("--split-string"))
        if (split !== -1) {
          const value = argTexts[split] === "-S" ? argTexts[split + 1] : argTexts[split]!.split("=")[1]
          if (value) {
            for (const nestedSegment of splitScript(value, depth + 1, budget)) resolveSegment(nestedSegment, depth + 1, budget, out)
          }
        }
      }
      let rest = skipOptions(argTexts, VALUE_OPTIONS[lower]!)
      if (lower === "timeout" && rest.length > 0) rest = rest.slice(1) // DURATION
      if (lower === "nice" || lower === "ionice") rest = rest.filter((arg, index) => !(index === 0 && /^-\d+$/.test(arg)))
      const consumed = argTexts.length - rest.length
      current = args.slice(consumed)
      continue
    }
    if (lower === "eval") {
      const script = argTexts.join(" ")
      for (const nestedSegment of splitScript(script, depth + 1, budget)) resolveSegment(nestedSegment, depth + 1, budget, out)
      return
    }
    if (SHELLS.has(lower)) {
      let script: string | undefined
      let commandFlag = false
      let file = false
      for (let index = 0; index < argTexts.length; index++) {
        const arg = argTexts[index]!
        if (arg === "--") {
          if (commandFlag && argTexts[index + 1] !== undefined) script = argTexts[index + 1]
          else file = argTexts[index + 1] !== undefined
          break
        }
        if (arg.startsWith("--")) {
          if (arg === "--rcfile" || arg === "--init-file") index++
          continue
        }
        if (arg.startsWith("-") || arg.startsWith("+")) {
          if (arg.startsWith("-") && /^-[A-Za-z]*c/.test(arg)) commandFlag = true
          if (arg === "-o" || arg === "-O" || arg === "+o" || arg === "+O") index++
          continue
        }
        if (commandFlag) script = arg
        else file = true
        break
      }
      if (script !== undefined) {
        for (const nestedSegment of splitScript(script, depth + 1, budget)) resolveSegment(nestedSegment, depth + 1, budget, out)
        return
      }
      // A shell without `-c` reads a script file or standard input.
      out.push({ program: name, args: argTexts, dynamicProgram: false, hints: [] })
      if (!file) {
        for (const body of segment.heredocs) {
          for (const nestedSegment of splitScript(body, depth + 1, budget)) resolveSegment(nestedSegment, depth + 1, budget, out)
        }
        if (segment.pipedFrom) {
          const scripts = [segment.pipedFrom.words.slice(1).map((word) => word.text).join(" "), ...segment.pipedFrom.heredocs]
          for (const script of scripts) {
            if (script === "") continue
            for (const nestedSegment of splitScript(script, depth + 1, budget)) resolveSegment(nestedSegment, depth + 1, budget, out)
          }
        }
      }
      return
    }
    if (lower === "find" || lower === "fd") {
      out.push({ program: name, args: argTexts, dynamicProgram: false, hints: [] })
      for (let index = 0; index < argTexts.length; index++) {
        if (/^-(exec|execdir|ok|okdir)$/.test(argTexts[index]!) || (lower === "fd" && /^(-x|-X|--exec|--exec-batch)$/.test(argTexts[index]!))) {
          let end = index + 1
          while (end < argTexts.length && argTexts[end] !== ";" && argTexts[end] !== "+") end++
          resolveWords(segment, args.slice(index + 1, end), depth + 1, budget, out)
        }
      }
      return
    }
    out.push({ program: name, args: argTexts, dynamicProgram: false, hints: [] })
    return
  }
  throw new BudgetExceeded()
}

function resolveSegment(segment: Segment, depth: number, budget: Budget, out: Invocation[]): void {
  resolveWords(segment, segment.words, depth, budget, out)
  void budget
}

/** Parses a command line into the invocations it would start. Never throws. */
export function analyzeCommand(raw: string): CommandAnalysis {
  if (typeof raw !== "string" || raw.length > COMMAND_BUDGET.chars) return { invocations: [], fallback: true, raw: String(raw).slice(0, COMMAND_BUDGET.fallbackChars) }
  try {
    const budget: Budget = { segments: 0 }
    const segments = splitScript(raw, 0, budget)
    const invocations: Invocation[] = []
    for (const segment of segments) resolveSegment(segment, 0, budget, invocations)
    if (invocations.length > COMMAND_BUDGET.segments * 2) throw new BudgetExceeded()
    return { invocations, fallback: false, raw }
  } catch {
    return { invocations: [], fallback: true, raw }
  }
}
