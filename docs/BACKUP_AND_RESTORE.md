# Database backup and verified restore

A database backup counts as verified only after it has been restored into a new disposable PostgreSQL 17 cluster and checked there. Creating a dump alone is not a successful backup check.

These commands are operator tools. They do not upload a backup, alter the source database or promote a restored database. They contact the explicitly supplied source database, which may be remote; restore verification contacts only its local disposable cluster. Keep backup directories on owner-controlled storage with mode `0700`.

Every backup carries the same three files, whoever made it: the scheduled nightly job, `scripts/ops/backup-database.mjs`, and `scripts/mac-local/database-upgrade-vps-step.mjs` all write `database.dump`, `metadata.json` and `manifest.json`. A scheduled backup is verifiable by exactly the command below.

## Create a bound backup

Choose a fresh, absent absolute output directory beneath an existing private parent and a read-capable PostgreSQL connection for the `control_room` database. The tool creates the generation with mode `0700` before connecting or writing. An existing output, even an empty one, is refused without changing its files. After a failed attempt, use a fresh output for the retry. If the connection contains a password, obtain it from the protected secret store and avoid saving it in shell history.

```sh
node scripts/ops/backup-database.mjs \
  --source "postgresql://BACKUP_LOGIN@DATABASE_HOST:5432/control_room" \
  --out /absolute/private/path/control-room-backup-YYYYMMDD \
  --pg-bin /absolute/path/to/postgresql-17/bin
```

The directory contains:

- `database.dump`: PostgreSQL custom-format dump;
- `metadata.json`: the existing snapshot-bound restore identity (ledger, rows, roles, memberships, grants and owners); and
- `manifest.json`: SHA-256 digests of both files, creation time, migration-ledger head and required-table list.

No password or connection string is written to the manifest. The command performs no upload.

## Verify by disposable restore

Select one unused port from the task's disposable range. The verifier creates its data directory under the system temporary directory, listens only on a private Unix socket, restores into a fresh `control_room` database, and removes the cluster in a `finally` cleanup.

```sh
node scripts/ops/verify-database-backup.mjs \
  --backup /absolute/private/path/control-room-backup-YYYYMMDD \
  --port 15620 \
  --pg-bin /absolute/path/to/postgresql-17/bin
```

`PASS` means all of the following were observed in the restored database:

- dump and metadata hashes match the outer manifest;
- the migration ledger and its head match;
- required-table row counts and row hashes match;
- restored objects are owned by `control_room_schema_owner`; and
- the five Mac-local restricted roles have exactly the reviewed direct grants.

Any mismatch prints `FAIL`, destroys the disposable cluster, and leaves the source and backup unchanged. Do not promote or overwrite a database as part of verification. Investigate a failed backup as a recovery incident and create a new backup only after the cause is understood.

## Restoring, and recovering from an interrupted restore

The restore library uses the refusal codes below. The operator CLI reports the bounded code `restore_execution_failed` rather than raw exception text, which can contain connection credentials. `deploy/postgres/restore-database.mjs` refuses, in this order, before it changes anything:

- `restore_refused_damaged_dump`: the dump or metadata no longer matches the manifest the backup was written with. The bytes were altered after the backup was made. Investigate the disk; do not restore this backup.
- `restore_refused_required_tables_mismatch:<tables>`: you passed `--required-tables` and the list is not the one this backup recorded. The restore tool reads the list from the backup, so passing a different one cannot succeed; the refusal names the list the backup recorded. Run without the flag.
- `restore_refused_unrecorded_role_authority:<login>:<role>`: the cluster holds a `control_room_*` role that this backup did not record, and it is a member of — or holds — a role the backup DID record. That role exercises recorded authority inside the restored database, so the restore refuses and names both. Remove the extra role (or restore on a cluster without it) and run again.
- `restore_refused_missing_recorded_role:<role>`: a role this backup recorded does not exist on the cluster. Provision the target first, as below.
- `restore_refused_nonempty_target:<database>`: the target already holds tables in any non-system schema — including `control_room_queue`, not only `public`.
- `restore_refused_unrelated_target_object:<schema>.<table>` (only with `--retry-into-half-restored`): the target holds an object this backup's dump does not create. Not cleaned, refused by name.
- `restore_refused_target_object_not_owned:<schema or schema.object>` (only with `--retry-into-half-restored`): this login may not drop something the dump will create. Grant ownership, or restore into a target the restoring login owns.

A role the update added since the backup is NOT a refusal on its own. The restore identity compares the roles and memberships the backup recorded — that is every `control_room_*` role the source held — so the documented rollback works on a cluster an update has added a login to. Added roles are reported in the result as `restore_warning_role_added_since_backup:<roles>`, and a membership wiring one of them into a recorded role is the refusal above.

### Restoring, and recovering from an interrupted restore

The second refusal is the important one to read carefully. `pg_restore` is not transactional, so a restore that is interrupted — a killed process, a full disk, a dropped connection — leaves the target holding whatever it had already created. The same command then refuses that target, correctly: it cannot tell an interrupted restore's leftovers from a database somebody cares about.

**What to do, safest first:** identify the database in your `--target` argument. If that database was created for the restore that failed, drop it and restore again into a fresh one. Nothing else in this toolchain drops a database for you, and nothing should: you decide whether the target is disposable. A target you did not create for this restore is not yours to empty — take a new backup instead.

**Or retry into the half-restored target, by name.** If the target was created for this restore and you know it, add `--retry-into-half-restored`:

```sh
node deploy/postgres/restore-database.mjs --backup /absolute/private/path/control-room-backup-YYYYMMDD \
  --target "<the disposable conn>" --confirm-target "<the same disposable conn>" \
  --pg-bin /absolute/path/to/postgresql-17/bin --retry-into-half-restored
```

That reads the dump's own table of contents and drops exactly what the dump will recreate — nothing else, and `public` is emptied rather than dropped. It refuses before dropping anything if the target holds an object the dump does not name, or anything this login may not drop. `pg_restore --clean --if-exists` is not a substitute: on this schema it fails with `cannot drop inherited constraint`, because PostgreSQL will not drop an inherited constraint the way `pg_restore` asks.

### Bot keys after a restore

A restore brings back credential rows, so it would otherwise reverse the owner's own decisions made since the backup: a bot the owner removed would authenticate again, and a bot that renewed or joined since would lose access with no explanation. Neither is acceptable, so every restore **retires every bot credential the restored database holds** and writes the owner one item in "Needs me" naming the machines.

`retired`, not `revoked`: `revoked` records that the owner removed the bot, and the owner removed none of these — their key stopped working, and the bot re-keys itself the way it renews. The credential rows are history and stay.

The cost is one re-key per machine after every restore. That is the price of a restore never silently handing access back to something the owner removed, and it is why the owner is told rather than left to discover it as locked-out bots.

### Restoring a nightly backup

The nightly backup binds six required tables. Restore it with no `--required-tables` flag at all:

```sh
node deploy/postgres/restore-database.mjs --backup /absolute/private/path/to/nightly-generation \
  --target "<the disposable conn>" --confirm-target "<the same disposable conn>" \
  --pg-bin /absolute/path/to/postgresql-17/bin
```

The tool reads the table list from the backup it is restoring. Passing a different one is refused before the target is touched — see the refusal list above.

A backup with no `manifest.json` is still restorable. The manifest is what proves the bytes, and losing it is one of the situations this tool is for; the restore identity check after the restore still has to pass.

### Choosing a different port range

The verifier accepts `15620` to `15649` and refuses anything else, so a run restricted to a different assigned block needs that block stated:

```sh
node scripts/ops/verify-database-backup.mjs \
  --backup /absolute/private/path/control-room-backup-YYYYMMDD \
  --port 58675 \
  --port-range 58675-58679 \
  --pg-bin /absolute/path/to/postgresql-17/bin
```

Set `CONTROL_ROOM_BACKUP_VERIFY_PORT_RANGE=MIN-MAX` instead to change the accepted range for a shell without changing the command. Without either, the accepted range is `15620-15649` exactly as documented above.

A range is two decimal integers `MIN-MAX` with `MIN` at or above `1024`, `MAX` at or below `65535`, `MAX` not below `MIN`, and no more than 1024 ports in it. Anything else prints `FAIL` with `database_backup_verification_port_range_refused` and no cluster is started. A refused range is not replaced by the default, so a mistyped value cannot quietly put a cluster back on a port the run is not allowed to use.

## Emergency cleanup

If the verifier is killed before its normal cleanup can run, inspect first:

```sh
node scripts/dev/cleanup-test-postgres.mjs --dry-run
```

Then run the same command without `--dry-run` only after confirming the listed clusters are disposable. The cleanup command refuses unmarked non-temporary clusters and removes only unattached shared-memory segments tied to a selected postmaster.
