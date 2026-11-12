# Plugin status view

The TD-Plugin extension's status view shows what the FueliX plugin configured and the result of its latest automatic
model-discovery check. This view does not change configuration or run checks. The extension's guard controls are
described in [`guards.md`](guards.md).

## What it shows

- The plugin version and the report's project directory.
- The model-list source, model counts by provider, and title models.
- The credential source, without the credential.
- The model refresh interval, non-chat model setting, authentication hooks, shell key scrubbing, and batch-tool registration.
- The latest discovery attempt, its outcome, and the latest successful check.
- Models added or removed by discovery in the current plugin run. The latest change stays available after an unchanged check.

The check calls FueliX's `/v1/models` endpoint. The separate `bun run doctor` command compares the live model list with
the curated catalog. Its results do not appear in this extension.

## Install

Use OpenChamber 2.7.0 or later on web or desktop. Mobile and VS Code do not load extensions.

The plugin and the extension are separate installs. The extension does not install or update the plugin. The plugin
must use a version that writes status reports; release 0.3.1 does not include this feature.

From a clone, install the extension's development dependencies and build it:

```bash
cd extension
bun install
bun run build
bun run check
```

In OpenChamber, open **Settings → Extensions**, add the absolute path of the clone's `extension/` folder, and review its
permissions. Open **TD-Plugin extension** from the rail while viewing the project you want to inspect.

The built JavaScript ships with the extension. OpenChamber does not compile TypeScript when it installs the folder.

## Reports and permissions

The plugin writes a JSON snapshot under `~/.td-opencode-plugin/status/`. Each project directory has a separate file,
named with the SHA-256 hash of the directory. A location without a project uses `global.json`.

The status view requests file access only to `~/.td-opencode-plugin/status/*.json`. The SDK file permission allows reading
and writing those files; this view only reads them. Guard management also requires session information, Small Model
access, and an authenticated local service with full user privileges. See [`guards.md`](guards.md).

Reports contain no credentials, request headers, raw configuration, or arbitrary exception messages. Failure reasons
use fixed descriptions. Reports identify the directory and the time they were written.

Reporting is enabled by default. Set `options.fuelix.statusReport` to `false` to stop writing reports. This does not
remove reports that already exist. Removing the extension does not remove the plugin's reports.
Guard runtime snapshots are separate; this option does not disable them.

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
bun test
bun run typecheck
bun run extension:typecheck
bun run extension:test
bun run extension:build
bun run extension:check
```

Plugin tests use fake keys, fetch responses, clocks, and report writers. File-write tests use temporary directories.
Extension tests use fixture reports and a mocked host. Neither test path needs a live FueliX key.
