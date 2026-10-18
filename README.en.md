# Session Trash · Delete sessions in DeepSeek Harness

[中文](README.md) · [Changelog](CHANGELOG.md) · [Publishing](docs/PUBLISHING.md)

A community plugin for DeepSeek Harness (DSH) that adds a real **Delete conversation** action: confirm once, the session leaves the sidebar immediately, and a copy stays in a local recycle bin for **7 days** with undo/restore. After the retention window the copy is purged.

> Not an official DeepSeek project. DSH's native Archive action is unchanged: archive hides a session, delete moves its log.

![Session Trash icon](icon.svg)

## Features

- **Delete conversation** in every session's `...` menu, with a confirmation dialog.
- **Immediate removal** from the sidebar, including sessions in the **Ungrouped** bucket.
- **7-day recycle bin** at `$DSH_HOME/session-trash/`; the log is copied before the original is removed.
- **Undo / restore** from the post-delete toast or the sidebar recycle-bin button.
- **Delete permanently** from the recycle bin without waiting for expiry.
- **Only a genuinely running turn is refused**, immediately and without cancelling it. Idle resident sessions can be deleted.
- **Fail-safe**: archive, workspace detach, flush, and copy failures abort before touching the original log and roll back the archive marker.
- **Same toast position/style** as DSH's archive notice, using the shared `Toast` primitive.

## Install

### npm (recommended, once released)

```sh
dsh plugin --profile web add dsh-plugin-delete-session
```

Fully quit and reopen DSH after installation (the Host half is an ESM module; a page refresh does not reload it), then press `Ctrl+Shift+R`.

### From GitHub source

```sh
dsh plugin --profile web add github:yycf1/dsh-plugin-delete-session
```

This is plain JavaScript; no build script is required. Restart DSH after installation.

### Browse inside DSH

This repository also publishes a DSH plugin-market index:

```text
https://yycf1.github.io/dsh-plugin-delete-session/index.json
```

Open **Settings → Plugins → Experimental plugins → Custom plugin market**, add the index URL, then install from **Discover**. The plugin is also submitted to DSH Plugin Hub (dsh-plugin.org).

## Usage

1. Open the `...` menu of a session and choose **Delete conversation**.
2. Confirm. The row disappears and a toast with **Undo** appears.
3. Click **Undo**, or open the recycle-bin button at the bottom of the sidebar to **Restore** any unexpired copy.
4. Use **Delete permanently** in the recycle bin to skip the remaining window.

The global content-addressed attachment store is shared and is not deleted.

## Configuration

The default `cordis.patch.yml` row is:

```yaml
- insert:
    - id: dsh-plugin-delete-session
      name: 'dsh-plugin-delete-session'
      config:
        retentionDays: 7
```

| Field | Default | Meaning |
|---|---|---|
| `retentionDays` | `7` | Recycle-bin retention (1–3650 days). |
| `trashRoot` | `$DSH_HOME/session-trash` | Recycle-bin directory. |
| `sessionsRoot` | persistence `root`, else `$DSH_HOME/sessions` | Session-log root. |
| `projectionCacheDir` | `$DSH_HOME/storages/session_projcache/sessions` | Projection-cache directory. |
| `homeDir` | `$DSH_HOME`, else `~/.dsh` | Base data directory when paths are omitted. |
| `purgeIntervalMs` | `3600000` | Expiry sweep interval (minimum 60 s). |

Override the row `config` in the profile patch to change retention. A patch replaces the complete row config, so repeat any other fields you need.

## How it works

Delete sequence:

1. Refuse immediately if the Agent's status is `running`.
2. Archive with `{ stopActivity: true }` to stop background work and hide the row.
3. Re-check the running state to close the race.
4. Detach the session from its workspace account.
5. Flush session persistence.
6. Copy the log directory, projection cache, and `meta.json` into the recycle bin.
7. Remove the original files.
8. Unregister the deleted live Session/Agent from the Host registries. `session/disposed` makes the sidebar/API remove the row and releases the JSONL writer.

Restore copies the log back, replaces the derived projection cache, unarchives, and reattaches the session to its original workspace. It refuses to overwrite an existing destination and rolls back a partial copy.

An hourly sweep (also run at startup) purges expired entries and stale archive markers whose log and trash copy are both gone.

## Safety and limitations

- **Internal DSH APIs**: `ctx.sessions.retireScope`, `sessions.detachEntered`, `agents.detachEntered`, and the `Toast` primitive. A DSH upgrade may require an update. Tested with DSH `0.2.1-rc.2`.
- **The idle Agent's underlying scope** remains until the process exits because DSH exposes no public Agent-close API. Its registrations are removed, so it is unreachable from the sidebar/session API and writes no more logs. Restart releases it.
- **Single-process assumption**: recycle-bin mutations are serialized inside one DSH process. Do not run multiple DSH instances sharing the same `$DSH_HOME`.
- **Windows first**: developed and tested primarily on Windows; other platforms have not had full GUI verification.
- A running turn is not cancelled by delete. Stop it first.
- A restored session returns to the front of its workspace, not its previous manual position.
- No Agent tool is registered; models cannot delete sessions on their own.

## Development

Plain ESM, no build step:

```sh
node --check index.js
node --check client.js
node test/host.test.mjs
node test/trash.test.mjs
```

## Compatibility

- DSH: `>=0.2.1-rc.2 <0.3.0`
- Platform: Windows verified; macOS/Linux not fully verified
- Runtime: DSH Desktop or a DSH profile with the Web UI

## License

[MIT](LICENSE) © 2026 yycf1

## Disclaimer

Community project, not affiliated with DeepSeek AI. Deleting moves local session files; test on a small session first and keep the recycle bin until you are sure.
