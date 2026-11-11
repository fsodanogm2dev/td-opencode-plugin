# FueliX prompt command and documentation batch

## Steps
- [x] Verify the OpenCode V2 command API and the existing batch workflow.
- [x] Add the inline `/fuelix-batch` prompt command and verify its behavior.
- [x] Ask `ndv-explain` to prepare and validate the documentation rewrite batch.
- [ ] Submit the documentation batch, collect its results when available, and validate the completed scope.

## Requirements

- Register the command in this plugin. Do not write root OpenCode configuration or `.opencode/` files.
- Accept a free-form prompt and submit it through the existing FueliX batch workflow.
- Preserve the checkout's existing changes and the existing interactive behavior.
- Do not write credentials to source files, fixtures, logs, or provider settings.
- Test OpenCode only on isolated servers with temporary XDG directories and a location outside the user's home directory.
- Prepare the rewrite for `AGENTS.md`, `README.md`, and every direct `docs/*.md` file with `ndv-explain`.
- Keep documentation clear, user friendly, accurate, and self-contained. Explain technical terms and check local references.
- Describe cost savings only when supported by evidence. Batch execution does not inherently reduce token counts.
- Do not commit, push, publish, or change the user's OpenCode configuration.

## Work graph and validation

1. Read-only exploration and official API research can run in parallel. The parent reconciles their findings.
2. The implementation lane owns command code and focused tests. The parent owns final unit, type, and isolated integration checks.
3. After the command is stable, `ndv-explain` owns the documentation request file and its source-grounded instructions. It must not submit or overwrite documents during preparation.
4. The parent submits the authorized batch once. Submission, gateway status, and collection records establish live behavior; isolated tests establish behavior without paid calls.
5. Collected documentation changes require completeness, factual review, preservation of repository rules, and local-link checks before application.

## Limits

FueliX may defer completion. A successfully submitted batch is not evidence of successful generation, collection, or a completed documentation rewrite. Gateway rejection must be reported without automatic paid resubmission.
