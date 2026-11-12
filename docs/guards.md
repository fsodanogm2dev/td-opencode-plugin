# Execution guards

The TD-Plugin extension lets you save guard definitions and enable them for a session. An active guard rejects
matching actions in OpenCode before they execute. The agent receives a tool error and can continue other work.
Enabling a guard does not stop an action that already started.

## Definitions and activations

A **definition** describes what to block. Definitions are shared across projects and remain saved until you delete
them. An **activation** applies a definition to a session or request. Saving a definition does not activate it.

Enter a plain-text request and select **Generate**. The extension asks OpenChamber's Small Model for a draft. This
costs model tokens. Inspect every rule and test sample commands before saving. The draft is data, not executable
code. Its label and explanation do not determine enforcement; the validated rules do.

For example: a request to block Git commits can produce a command rule for the `git` executable with the `commit`
subcommand. It does not also block merges or rebases unless you explicitly include those operations.

## Scope and release

The default scope is the selected session and its linked subagents. It stays active until you release it. No expiry
is selected by default. You can choose an expiry when you enable a guard.

Request scope follows the current run, or the next run when the session is idle. It includes linked subagents.
OpenCode's events do not carry a run identifier, so this scope is best effort. The plugin releases it automatically
only when it can establish that the tracked run and its descendants have ended. Uncertain completion keeps the
guard active. Read the displayed status and release it explicitly when needed.

A session dispatched without a parent link does not inherit another session's guards.

Releasing an activation stops that activation. Deleting a definition also removes its activations. Other active
guards can still block the same action.

## Enforcement

The plugin uses OpenCode's permission evaluation hook. A matching rule sets the decision to `deny` even when
ordinary permissions would allow the action. It does not ask the model to respect an instruction or decide whether
its own explanation justifies an exception. A blocked attempt does not open another approval prompt.

The plugin exposes no model tool, command, or RPC that enables, disables, or deletes guards. Management requests
come from the extension's user controls through its authenticated local service.

Two rule types are supported:

- A **command rule** matches an executable name, optional subcommand prefixes, and optional literal flags in a shell
  permission request. Subcommand alternatives use any-match semantics. If flags are specified, all of them must be present.
- A **permission rule** matches an exact permission action and optional resource patterns. It applies only when a tool
  requests that permission action. It is not a universal tool-name filter.

The command tester uses the enforcement matcher. A conservative result means the matcher could not interpret part
of the command and may block it. The tester never executes the sample command.

## Limits

These guards are not an operating-system security boundary. Shell matching cannot reliably detect operations hidden
inside arbitrary scripts, aliases, or other programs. A tool that does not request permission does not pass through
this hook. Another plugin registered later can change a permission decision.

The agent runs as your operating-system user. It could deliberately alter guard files or automate user controls.
The absence of a model-exposed management tool does not prevent those operating-system actions.

If the plugin cannot establish whether a request ended, it keeps the guard active. Every plugin instance reads the
same persisted completion facts. A valid bound-and-ended sequence from one instance can establish completion for
the others; the extension does not need to be open for a request guard to end.

If an existing store becomes unreadable or disappears, the plugin keeps the last valid copy. Invalid initial state
blocks supported mutating actions until the store is repaired. A store missing at the first read means no saved guards.

## Recover damaged guard data

If the service reports damaged guard data, use its recovery control and review the confirmation. Recovery resets
saved definitions and activations across every project. The service keeps a backup of the damaged file. This action
is available only through a confirmed user control; the model cannot request it through a guard-management tool.

Cancelling the confirmation keeps the existing state. A failed recovery is not a successful release. Wait for the
plugin to report the valid replacement state before treating the recovery as complete.

## Storage and permissions

Guard definitions and activations are stored globally in `~/.td-opencode-plugin/guards/store.json`. The extension's
local service serializes changes under a cross-process lock. The plugin reads this file; it writes separate lifecycle
facts and runtime snapshots. Guards do not modify permanent OpenCode configuration.

The plugin and the extension service must see the same guard directory. Separate hosts without a shared directory
do not share these definitions or activations.

The extension asks for Small Model access, session information, and a local service. The service runs with your full
user privileges, not inside the panel's sandbox. OpenChamber's approval dialog lists these permissions.

Do not include credentials in guard requests or sample commands. Guard requests are saved as your data. Live command
text and permission resources are not written to guard status reports or lifecycle facts.

An extension update or restart does not automatically release session-scoped guards. Pausing or removing the
extension does not remove the plugin's global store. Keep a working user control available to release activations.

## Check the active plugin

The extension and the OpenCode plugin are separate installs. Both need this feature's version. Installing only the
extension cannot add the enforcement hook to an older plugin. The guard controls show whether an enforcement
runtime was recorded for the current location; a missing or stale report is not proof that guards are enforced.

This feature is developed in worktree `.slim/worktrees/td-plugin-guards`. It is not a released update. The agent has
not changed your global OpenCode configuration to load that worktree.

## Try the worktree version

Use one `td-opencode-plugin` entry in your OpenCode configuration. Replace its package path with the absolute path
of this worktree. Keep your existing plugin options and every unrelated setting. Do not add a second copy of the plugin.

[`../examples/td-plugin-guards.jsonc`](../examples/td-plugin-guards.jsonc) shows the local entry. The example is not a
complete replacement for your configuration.

In OpenChamber desktop, open **Settings → Extensions** and add the worktree's `extension/` folder. If an installed
extension already uses the same ID, remove that extension entry before adding the worktree folder. This does not
delete the plugin's global guard store. Review the new model, session, and local-service permissions.

Open **TD-Plugin extension → Guards** in a session. Wait for **Enforced by the plugin**, enter a request, and select
**Generate**. Review the rules and test sample commands, then save the definition. Enable it with the scope you want.
Save alone leaves it inactive. Use **Release** to stop an activation.
