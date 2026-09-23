# Private recovery rehearsal adapter

This package fills the sequencing and evidence comparison beneath
`PrivateRecoveryOwnerRuntimeV1.runExistingBackupRestoreRehearsal`. It does not
install or run a database, create a target, execute PostgreSQL tools or publish
readiness by itself. All tests use disposable in-memory tool doubles.

`createPrivateRecoveryRehearsalAdapterV1` takes the already prepared recovery
request, the existing runner binding/owner-attendance callback, and private
tool-session ports. Its returned runtime fits the existing owner runner and
installation recovery stage. There is still one authority database and one
recovery evidence format.

The adapter captures the binding and port before asynchronous work; accepts
one attempt; verifies separate, held, empty restore destinations; runs one
backup; reobserves destination custody; restores only that dump and protected
artifact inventory; compares every database restore identity field; checks
restricted application and scheduler login behavior; then retires the session
before returning the existing local backup/restore proof. An interrupted
operation, substituted evidence or uncertain retirement yields no proof and
does not authorize retry.

## Existing code reused

- `deploy/postgres/restore-identity.mjs`: exact schema, role, membership, ACL,
  required-row, migration-ledger and database-owner comparisons.
- `src/artifacts/v1/artifact-backup-inventory.ts`: exact protected-result
  inventory and restored-byte verification.
- `src/harness/v1/local-backup-restore-readiness.ts`: the existing combined
  database/artifact proof consumed by installation readiness.
- `src/installer/v1/private-recovery-owner-runner.ts`: binding, owner-attendance
  check, bounded control and terminal confirmation.

## Private host contract still to supply

The `open` port acquires custody and read-only observations. It must be bounded,
must honor the supplied abort signal, and must retire custody on acquisition
failure. A successfully opened session retains the exact source, backup set,
PostgreSQL binaries/modules, credentials and disposable destination internally;
none are serialized to the browser or returned in evidence.

The source is quiesced for this first installation rehearsal so protected
artifacts and the database snapshot represent one accepted installation. The
host delegates database backup to the reviewed `backup-database.mjs` exported
snapshot procedure and restore to the reviewed `restore-database.mjs`, with
the same required-table set for both. Evidence must come from actual restored
rows and roles; echoing backup metadata does not satisfy the port contract.
Protected artifacts use the retained storage/backup implementation and exact
inventory; the host must hash restored bytes.

The restore tool can create roles and memberships. Therefore a different empty
database on the live shared cluster alone is insufficient for this adapter:
`clusterRolesIsolated` must attest separate disposable cluster role state.
The adapter refuses before backup if this is unproven. No cluster or role is
created automatically by this package.

The restricted-login check uses the restored application/scheduler logins to
prove allowed reads and refused forbidden writes/privilege escalation. The
`close` port retires outstanding processes and connections, releases holds,
and accounts for the disposable target, while preserving the backup and source.
It receives a fresh cleanup signal even when work was cancelled. Its returned
`retired` value must reflect observed retirement, never merely a kill request.

Remaining live prerequisites are the reviewed native tool/session host, private
source credentials, protected backup destination, an isolated empty disposable
restore target, actual restricted logins, and owner-attended execution through
the existing runner. No live recovery proof exists from these source tests.
