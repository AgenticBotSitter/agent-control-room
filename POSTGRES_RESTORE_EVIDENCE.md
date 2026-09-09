# Native PostgreSQL restore checkpoint

## Result

The disposable PostgreSQL 17 website-profile restore fixture passes through
migration 0066. This does not authorize production changes or qualify production
backup storage, signing custody, worker recovery or artifact/checkpoint pairing.

## Cause and fix

PostgreSQL's initial parsing of BETWEEN inside a conjunction and reparsing of
pg_dump output produced different catalog expression structure. The constraints
were equivalent, but the strict schema fingerprint correctly detected different
catalog text. Migration 0066 spells out the same inclusive bounds for delivery IDs
and article payload bytes. It preserves constraint names, regex and NULL behavior,
validates existing rows, and does not edit historical migrations. Fingerprint
verification remains exact; only its expected migrated-schema value changes.

## Reproduction

With already-reviewed PostgreSQL 17 binaries and prepared dependencies:

```sh
node --import tsx scripts/test-pg17-restore.ts /absolute/path/to/postgresql17/bin
```

The fixture creates its own empty temporary cluster, disables TCP listeners, uses
a private Unix socket, and removes only its owned temporary directory after server
shutdown. It does not accept an existing database target. Fixture authentication
is synthetic and socket-local, not a production authentication recommendation.

## Observed evidence

- Fresh schema and both successive dump/restore generations have exact digest
  `bb294bb80683f80afd269882e072b41a7b402a5509af800648c7cbaf179f0cfa`.
- All public table rows and relation/function ownership and effective ACL snapshots
  match. Database ACLs are reapplied separately using the existing template.
- Restricted web-role preflight and project readback pass after each restore.
- Ten delivery-ID equivalence cases and eleven article payload boundary cases pass,
  including multibyte byte limits, absent values and wrong JSON types.
- Changed bounds, a dropped constraint, excess web INSERT permission and missing
  owner identity are rejected; restored valid settings pass again.
- The fixture exits successfully and reports cleanup true.
- Compiled regression: 56 passed; article suite: 13 passed; full-source TypeScript
  checking passed after migration 0066.

Independent source review of the migration and original restore fixture reported
no concrete defect. Additional function ACL comparisons and explicit article
boundary cases were then added and passed in the native rerun.

## Still open

Production backup/restore verification, the full worker-role and recovery paths,
signed checkpoint and artifact consistency, and operator deployment acceptance
remain separate requirements. Actual browser visual/accessibility acceptance of
the article reader is also pending; fake-DOM tests are not that evidence.
