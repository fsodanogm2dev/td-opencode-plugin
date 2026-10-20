import { describe, expect, test } from "bun:test"
import { childEnv } from "../../../src/telemetry/env.ts"

const SOURCE: Record<string, string | undefined> = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  USER: "u",
  LOGNAME: "u",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  LC_CTYPE: "UTF-8",
  TMPDIR: "/tmp",
  TZ: "UTC",
  XDG_CONFIG_HOME: "/c",
  XDG_DATA_HOME: "/d",
  XDG_STATE_HOME: "/s",
  XDG_CACHE_HOME: "/k",
  TD_DATA_DIR: "/store",
  TD_RECEIVER_PORT: "1",
  NODE_EXTRA_CA_CERTS: "/ca.pem",
  SSL_CERT_FILE: "/f",
  SSL_CERT_DIR: "/dir",
  HTTP_PROXY: "http://p",
  http_proxy: "http://p",
  HTTPS_PROXY: "http://p",
  https_proxy: "http://p",
  NO_PROXY: "x",
  no_proxy: "x",
  GH_TOKEN: "gh-fake",
  GITHUB_TOKEN: "gh-fake-2",
  GH_HOST: "github.example",
  GH_CONFIG_DIR: "/gh",
  FUELIX_API_KEY: "sk-test-not-a-real-key",
  OPENAI_API_KEY: "sk-other",
  ANTHROPIC_API_KEY: "sk-other",
  TD_SOMETHING_API_KEY: "sk-td",
  OPENCODE_SERVER_PASSWORD: "pw",
  OPENCODE_CONFIG_CONTENT: "{}",
  AWS_SECRET_ACCESS_KEY: "x",
  EDITOR: "vim",
  UNDEFINED_VALUE: undefined,
}

const COMMON = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TD_DATA_DIR", "TD_RECEIVER_PORT",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy",
]

describe("childEnv", () => {
  test("the process manager gets the common allowlist only", () => {
    expect(Object.keys(childEnv(SOURCE, "manager")).sort()).toEqual([...COMMON].sort())
  })

  test("hook scripts also get the gh variables", () => {
    expect(Object.keys(childEnv(SOURCE, "hook")).sort()).toEqual([...COMMON, "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR"].sort())
  })

  test("keys, OpenCode variables, and unknown variables never pass", () => {
    for (const kind of ["hook", "manager"] as const) {
      const env = childEnv(SOURCE, kind)
      for (const name of ["FUELIX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TD_SOMETHING_API_KEY", "OPENCODE_SERVER_PASSWORD", "OPENCODE_CONFIG_CONTENT", "AWS_SECRET_ACCESS_KEY", "EDITOR"]) {
        expect(env[name]).toBeUndefined()
      }
      expect(JSON.stringify(env)).not.toContain("sk-")
    }
  })

  test("values are copied unchanged", () => {
    expect(childEnv(SOURCE, "manager").TD_DATA_DIR).toBe("/store")
  })
})
