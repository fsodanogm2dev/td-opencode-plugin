/** Minimal `--flag value` / `--flag` parser. */

export function parseArgs(argv: readonly string[], booleans: readonly string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (booleans.includes(name)) {
      result[name] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`Option --${name} needs a value.`)
    result[name] = value
    index++
  }
  return result
}
