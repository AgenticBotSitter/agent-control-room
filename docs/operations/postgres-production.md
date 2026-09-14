# PostgreSQL production package (#63)

Effect-free, test-proven tooling for a dedicated Control Room database on
PostgreSQL 17. Nothing here touches a live database unless the operator supplies
an explicit connection: without `--target`/`--source` every tool prints its plan
and exits 0.

## Layout

| Path | Purpose |
| --- | --- |
| `deploy/postgres/migration-ledger.json` | Immutable filename/order/sha256 manifest for all 76 `db/migrations/*.sql` files plus the three provisioned role files. Regenerate with `pnpm db:ledger` after any reviewed migration change; verify with `pnpm db:verify`. |
| `deploy/postgres/provision-database.sql` | Superuser-run `CREATE DATABASE` template. Database name and owner come from psql variables (`-v dbname=… -v owner=…`). |
| `db/roles/production_provision.sql` | Schema-owner group plus `control_room_migrator` / `control_room_app` / `control_room_scheduler` logins. Passwords arrive only as psql variables sourced from the operator's secret store; runs shorter than 24 characters fail closed. Complements `db/roles/production_roles.sql` (NOLOGIN groups + grants, re-applied after every migration batch). |
| `db/setup/production_migration_ledger.sql` | `control_room_schema_migrations` ledger-table DDL. The only production schema object owned by this package; `db/migrations/*.sql` contents are read-only inputs. |
| `deploy/postgres/apply-migrations.mjs` | Ordered applier. One transaction per file plus its ledger row, with pre/post schema digests. Refuses altered, missing, reordered, gap and unknown-row states. Optional logins only from `CONTROL_ROOM_MIGRATOR_PASSWORD` / `CONTROL_ROOM_APP_PASSWORD` / `CONTROL_ROOM_SCHEDULER_PASSWORD` env (never argv); otherwise it prints the exact `psql` command for the operator. |
| `deploy/postgres/backup-database.mjs` | `pg_dump --format=custom` plus `metadata.json` binding release, ledger digest, role snapshot, schema digest and required-row hashes into the database-restore identity consumed by #60/#61. Source is read-only; accepts an optional `#65` artifact-set digest input (shape-validated, never generated here). |
| `deploy/postgres/restore-database.mjs` | `pg_restore --no-owner` into an explicit target only: `--target` must equal `--confirm-target`, non-empty targets are refused (empty explicitly first — a second restore starts from `DROP SCHEMA public`), and the restored identity is verified field by field. **Rollback is restore from a prior backup set**: same command, same check, no separate path. |
| `deploy/postgres/evidence.mjs`, `restore-identity.mjs` | Shared evidence collection and identity computation/verification. |

## Operator flows

Fresh install:

```sh
psql -v dbname="control_room" -v owner="control_room_schema_owner" \
  -f deploy/postgres/provision-database.sql "dbname=postgres user=postgres"
node deploy/postgres/apply-migrations.mjs --target "host=/var/run/postgresql dbname=control_room user=postgres"
```

Upgrade (pending suffix only; tampered history fails closed, never skips):

```sh
pnpm db:verify
node deploy/postgres/apply-migrations.mjs --target "<conn>"
```

Backup and disposable restore (never overwrites a live target by default):

```sh
node deploy/postgres/backup-database.mjs --source "<conn>" --out /srv/backups/cr-<date> \
  --pg-bin /usr/lib/postgresql/17/bin --ledger-digest sha256:<ledger> --required-tables tenants,workspaces
node deploy/postgres/restore-database.mjs --backup /srv/backups/cr-<date> \
  --target "<disposable conn>" --confirm-target "<same disposable conn>" \
  --pg-bin /usr/lib/postgresql/17/bin --required-tables tenants,workspaces
```

## Boundaries

- The schedule-admission service role (`control_room_schedule_admissions`,
  issue #120) holds only SELECT+INSERT on `control_scheduled_task_admissions`
  and SELECT on its referenced source/destination/occurrence tables. No
  UPDATE/DELETE (the table is append-only), and the read-only web role never
  gains that INSERT.
- No production database, credential, service restart or real backup is authorized
  by the tooling alone; shared schema/permission decisions stay lead-owned.
- Restored clusters never carry roles (`pg_restore --no-owner` skips cluster
  globals): the recorded owner is recreated as NOLOGIN and objects are re-owned
  deterministically, then `production_roles.sql` grants are re-applied. The
  identity check verifies restored *content* (rows, schema, ACLs), not
  cluster-local role state.
- Test cleanup and retention are bounded: tests use disposable `initdb` clusters
  and `mkdtemp` roots removed in `t.after`/global teardown; no broad deletion.
