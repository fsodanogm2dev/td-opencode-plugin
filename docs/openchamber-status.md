# OpenChamber status extension

The panel shows what the FueliX plugin configured and the result of its latest automatic model-discovery check.
The panel does not change configuration or run checks. The combined extension package also loads the plugin.

## What it shows

- The plugin version and the report's project directory.
- The model-list source, model counts by provider, and title models.
- The credential source, without the credential.
- The model refresh interval, non-chat model setting, authentication hooks, shell key scrubbing, and batch-tool registration.
- The latest discovery attempt, its outcome, and the latest successful check.
- Models added or removed by discovery in the current plugin run. The latest change stays available after an unchanged check.

Each setting under **What the plugin set up** includes a short explanation below its recorded value. These explain
the credential source, request authentication, automatic checks, model types, provider activation, shell key protection,
and batch tools.

The check calls FueliX's `/v1/models` endpoint. The separate `bun run doctor` command compares the live model list with
the curated catalog. Its results do not appear in this extension.

## Install

Use OpenChamber 2.7.0 or later on web or desktop. Mobile and VS Code do not load extensions.

### Combined package

In **Settings → Extensions**, add:

```text
https://github.com/fsodanogm2dev/td-opencode-plugin#v0.5.1
```

Approve file access to the reports and **Add a plugin to OpenCode**. OpenChamber loads the bundled plugin and the status
panel from one package. Updating the extension updates both components. The plugin uses its default options.

Remove an existing manual `td-opencode-plugin` entry from your OpenCode configuration before using the combined install.
If the status-only folder extension is installed, remove it first. Neither step removes your FueliX credential.

OpenChamber manages the bundled plugin through its own configuration; it does not write your `opencode.json`. Disabling
or removing the extension removes its managed plugin entry. This works when OpenChamber manages the OpenCode server.
When OpenChamber cannot reach that configuration, it can offer **Add to global config**. That action creates a manual
entry which you must remove yourself when you remove the extension. A remote OpenCode cannot load a local plugin folder.

Mobile and VS Code do not install this package. Sessions in isolated spaces use their own OpenCode and do not load the
host's bundled plugin. Enterprise mode allows bundled plugins only from administrator-approved repositories.

### Status-only panel with a standalone plugin

For custom plugin options, keep the standalone OpenCode plugin installation and add only the clone's `extension/`
folder. The standalone plugin must be version 0.4.0 or later to write reports. This folder does not install a plugin.

To rebuild the status-only panel during development:

```bash
cd extension
bun install
bun run build
bun run check
```

In OpenChamber, open **Settings → Extensions**, add the absolute path of the clone's `extension/` folder, and review the
file-access permission. Open the extension from the rail while viewing the project you want to inspect.

The built JavaScript ships with both packages. OpenChamber does not compile TypeScript when it installs them.

For a combined folder install from a clone, add the repository root, not `extension/`. To rebuild both components,
install dependencies at the root and in `extension/`, then run `bun run build` from the root.

## Reports and permissions

The plugin writes a JSON snapshot under `~/.td-opencode-plugin/status/`. Each project directory has a separate file,
named with the SHA-256 hash of the directory. A location without a project uses `global.json`.

The panel requests access to `~/.td-opencode-plugin/status/*.json`. The SDK file permission allows reading and writing
those files; this panel only reads them. The combined package also requests permission to load the OpenCode plugin,
which runs with your user's full access. The status-only folder requests no plugin permission. Neither package requests
a network integration, local service, session-control, or model-generation permission for the panel.

Reports contain no credentials, request headers, raw configuration, or arbitrary exception messages. Failure reasons
use fixed descriptions. Reports identify the directory and the time they were written.

Reporting is enabled by default. With a standalone plugin, set `options.fuelix.statusReport` to `false` to stop writing reports. This does not
remove reports that already exist. Removing the extension does not remove the plugin's reports.

## Interpreting the result

A report is a saved snapshot, not proof that the plugin is running. Check its recorded time. Several OpenCode instances
for the same project share a report path; the latest writer supplies the visible snapshot. The extension reads files
on the connected OpenChamber server. A plugin on another machine cannot supply them.

A new plugin run replaces the report. Earlier check times and model changes are not a history across restarts. If a
plugin stops during discovery, its saved snapshot can still say that a check was in progress.

**Reload report** reads the file again. It does not contact FueliX. The plugin checks at startup when a key is available
and then at `refreshMinutes` intervals. The default interval is 60 minutes; `0` disables periodic discovery.

A rejected or empty discovery result keeps the existing model list. A failed check is not a successful check with no
changes. A provider reload failure is reported separately; it must not be read as proof that new models were applied.

Initial registration from the catalog or cache is not a discovery addition. Model changes refer to models eligible for
registration under the current options, not every non-chat model returned by the API.

The report describes the plugin's registrations. Provider blocks in your OpenCode configuration can override them;
the report does not inspect or verify those overrides.

A missing report can mean the plugin is older, reporting is disabled, the plugin has not started for this project, or
the plugin and OpenChamber use different home directories. The extension cannot determine which condition applies.

## Development checks

From the repository root:

```bash
bun run build
bun run test
bun run typecheck
bun run extension:typecheck
bun run extension:test
bun run extension:check
```

Plugin tests use fake keys, fetch responses, clocks, and report writers. File-write tests use temporary directories.
Extension tests use fixture reports and a mocked host. Neither test path needs a live FueliX key.
