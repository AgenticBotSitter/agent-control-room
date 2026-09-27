# Database backup and verified restore

A database backup counts as verified only after it has been restored into a new disposable PostgreSQL 17 cluster and checked there. Creating a dump alone is not a successful backup check.

These commands are operator tools. They do not upload a backup, alter the source database, promote a restored database, or contact any non-local service. Keep backup directories on owner-controlled storage with mode `0700`.

## Create a bound backup

Choose an empty absolute output directory and a read-capable PostgreSQL connection for the `control_room` database. If the connection contains a password, obtain it from the protected secret store and avoid saving it in shell history.

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

## Emergency cleanup

If the verifier is killed before its normal cleanup can run, inspect first:

```sh
node scripts/dev/cleanup-test-postgres.mjs --dry-run
```

Then run the same command without `--dry-run` only after confirming the listed clusters are disposable. The cleanup command refuses unmarked non-temporary clusters and removes only unattached shared-memory segments tied to a selected postmaster.
