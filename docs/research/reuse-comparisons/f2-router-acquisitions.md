# F2 router acquisition and cleanup ledger

- Before download: filesystem had approximately140GiB available.
- Owned root: `/private/tmp/control-room-f2router.a5mj7Z`.
- Permission: targeted public source reads only, maximum5MiB; no installs.
- Pin: `553df1c691fe8bf7747e50da22f1342984495ae0`.
- Initial inspection fetched `_message_router.py`, `_goal.py`, `models.py` at root:
  31,243bytes total, same hashes as their structured copies in JSON receipt.
- Structured source fetch: seven successful files, 402,249bytes. An attempted
  `generated/base.py` returned404; no corresponding file/import was fabricated.
- Aggregate downloaded file bytes:433,492; final owned directory allocation436KiB.
- Public GitHub contents metadata inspected but not retained. No archives/media.
- Seven source hashes retained in `f2-router-acquisitions.json`; verified before
  any upstream import. Python bytecode writes disabled; no runtime cache retained.
- Only own research harnesses, sanitized receipts and report retained in repository.
- Exact-root cleanup is recorded after execution below.
- Cleanup completed: removed exact owned root after both suites finished; absence
  verified. No installed dependencies/services created or removed. Re-download of
  pinned public files is required to rerun the upstream suite.

## Reviewer correction re-acquisition

- Disk check again:140GiB available. Fresh owned root
  `/private/tmp/control-room-f2router.99evMt`.
- Same exact seven source files/URLs/hashes as original structured receipt;
  402,249bytes downloaded,404KiB final allocation, below1MiB download cap.
- Initial restricted-network fetch failed ENOTFOUND before any file acquisition;
  scoped public-network retry succeeded. No package/dependency install.
- Six guard tests under optimized Python plus13router and6direct checks passed;
  actual command/stdout/exit receipts saved. Negative fixtures restored original
  source bytes before actual imports. No bytecode written or service started.
- Cleanup complete: exact owned recheck root removed after terminal success and
  retained receipts; absence verified. No application dependencies changed.
