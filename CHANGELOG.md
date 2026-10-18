# Changelog

All notable changes to this project are documented here.

## [1.0.8] - 2026-10-18

### Fixed

- Deleting a session restored into the **Ungrouped** bucket no longer leaves a
  ghost row in the sidebar. After the log is moved to the recycle bin, the plugin
  unregisters the exact live Session and idle Agent from the Host registries;
  `session/disposed` removes the row from the API/sidebar and releases the JSONL
  writer.
- Purging a deleted session, purging expired entries, and restoring an expired
  entry now clean up the same stale live/archive state when no durable log
  remains.
- A successful delete no longer depends on restarting DSH to make an ungrouped
  row disappear.

### Verified

- `node test/host.test.mjs` covers the reported flow: delete, restore, delete
  again while the restored session is live, plus archive/detach/flush rollback.
- `node test/trash.test.mjs` covers copy/restore/conflict/expiry/path and
  metadata validation.

## [1.0.0] - 2026-10-18

- Initial public release: delete confirmation, immediate removal, 7-day recycle
  bin, undo, restore, permanent delete, and running-turn refusal.
