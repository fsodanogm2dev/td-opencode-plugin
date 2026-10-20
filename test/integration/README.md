# Integration tests

These tests start a real `opencode serve` process (OpenCode 2.0.32) and talk to it over HTTP.

## Run

```bash
bun run test:integration
# or one file
bun test test/integration/smoke.test.ts --timeout 180000
```

`KEEP_TMP=1` keeps the temporary root after the run, so you can read its files.

### Live tests with a FueliX key

Pass the key only through the environment. The harness forwards only variables that the test passes in `input.env`.

```bash
FUELIX_API_KEY=... bun run test:integration
```

A live test must read `process.env.FUELIX_API_KEY` and give it to the server with
`startIsolatedServer({ env: { FUELIX_API_KEY: process.env.FUELIX_API_KEY! } })`. Skip the test when the variable is not set.
Never write the key to a file, a log line, or the inline config.

## Isolation

`startIsolatedServer` creates `mkdtemp(tmpdir()/td-opencode-it-*)` with these directories: `config`, `data`, `state`,
`cache`, `home`, and `project`. It starts the server with a minimal environment:

| Variable | Value |
| --- | --- |
| `PATH` | Copied from the test process |
| `HOME` | `<root>/home` (unless `isolateHome: false`) |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | `<root>/config`, `data`, `state`, `cache` |
| `OPENCODE_CONFIG_DIR` | `<root>/config/opencode` |
| `OPENCODE_CONFIG_CONTENT` | Inline JSON config (`$schema` plus `input.config`). It never holds a key |
| `OPENCODE_SERVER_PASSWORD` | A random password for each run, used as Basic auth (user name `opencode`) |
| `input.env` | Extra variables from the caller |

The working directory of the server is `<root>/project`. It is outside `$HOME`, so OpenCode finds no project
configuration in an ancestor directory.

Guarantees:

- The server does not read `~/.config/opencode` or `~/.local/share/opencode`. It does not use the background service.
- The server does not see `FUELIX_API_KEY` or other user variables unless the test passes them.
- `stop()` ends the process and removes the root. It is idempotent and also runs when the test process exits.
- The repository never contains `opencode.json`, `opencode.jsonc`, or `.opencode/`.

The server still reads the macOS Keychain (the plugin looks up `fuelix-api-key` there). `HOME` isolation does not
change that.

## OpenCode 2.0.32 behavior that matters

- **Password.** When `OPENCODE_SERVER_PASSWORD` is not set, the server creates a random password and prints it. Every
  `/api/*` request then needs Basic auth. The harness sets its own password and sends the header.
- **Lazy location boot.** The first request to a location starts its boot. Until the boot ends, `/api/plugin` returns
  an empty list. Use `waitFor` to poll until the list is not empty.
- **Local plugins.** A configured local plugin target must be a directory. OpenCode resolves it through
  `<dir>/server.*` or `<dir>/index.*` only. A file path is rejected (`configured plugin path must be a directory`) and
  `package.json` `exports` is ignored. For that reason the repository root has `index.ts`, which re-exports
  `src/index.ts`. `pluginEntry()` returns `{ package: repoRoot(), options }`, so the tests use the real local install
  path.
- **Server logs.** The server prints only its start line. Use `opencode serve --print-logs --log-level debug` by
  hand to see more. Plugin log lines (for example `[td-opencode-plugin] ...`) appear in `logs()`.

## API shapes (confirmed on 2.0.32)

All paths need Basic auth (the harness does that). Responses wrap data as `{ "data": ... }`.

```text
POST /api/session
  { "location": { "directory": "<project>" },
    "model": { "providerID": "fuelix-openai", "id": "gpt-6-luna", "variant": "default" },   // model and variant are optional
    "agent": "build", "title": "..." }
  -> 200 { "data": { "id": "ses_...", "model": {...}, "location": {...}, ... } }

POST /api/session/{id}/model        { "model": { "providerID": "...", "id": "...", "variant": "..." } }   -> empty body
POST /api/session/{id}/prompt       { "text": "...", "files": [], "agents": [], "skills": [], "metadata": {} }   // only "text" is required
GET  /api/session/{id}/message
GET  /api/plugin   GET /api/provider   GET /api/model   GET /api/info   GET /openapi.json
```

The prompt body has no `model` field. Set the model when you create the session, or with `POST /api/session/{id}/model`.
