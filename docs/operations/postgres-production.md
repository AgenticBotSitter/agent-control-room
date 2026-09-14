# PostgreSQL production package (#63)

Effect-free, test-proven tooling for a dedicated Control Room database on
PostgreSQL 17. Nothing here touches a live database unless the operator supplies
an explicit connection: without its connection flags (`--target`/`--source`,
or `--bootstrap-target`/`--migrate-target` for the migration applier) every
tool prints its plan and exits 0.

## Layout

| Path | Purpose |
| --- | --- |
| `deploy/postgres/migration-ledger.json` | Immutable filename/order/sha256 manifest for all 76 `db/migrations/*.sql` files plus the three provisioned role files. Regenerate with `pnpm db:ledger` after any reviewed migration change; verify with `pnpm db:verify`. |
| `deploy/postgres/provision-database.sql` | Superuser-run `CREATE DATABASE` template. Database name and owner come from psql variables (`-v dbname=… -v owner=…`). |
| `db/roles/production_provision.sql` | Self-sufficient logins: creates the schema-owner, application and schedule-admissions groups it depends on, then the `control_room_migrator` / `control_room_app` / `control_room_scheduler` logins. Passwords arrive only as psql variables sourced from the operator's secret store; runs shorter than 24 characters fail closed. Complements `db/roles/production_roles.sql` (remaining NOLOGIN groups + table grants, re-applied after every migration batch). |
| `db/setup/production_migration_ledger.sql` | `control_room_schema_migrations` ledger-table DDL. The only production schema object owned by this package; `db/migrations/*.sql` contents are read-only inputs. |
| `deploy/postgres/apply-migrations.mjs` | Ordered applier with two-phase connections: `--bootstrap-target` (superuser: creates roles, ledger table, grants) and `--migrate-target` (restricted migrator login running each migration under `SET ROLE`). One transaction per file plus its ledger row, with pre/post schema digests. Refuses altered, missing, reordered, gap and unknown-row states, partial flag pairs, and the removed single `--target` form. Optional logins only from `CONTROL_ROOM_MIGRATOR_PASSWORD` / `CONTROL_ROOM_APP_PASSWORD` / `CONTROL_ROOM_SCHEDULER_PASSWORD` env (never argv); otherwise it prints the exact `psql` command for the operator. |
| `deploy/postgres/backup-database.mjs` | `pg_dump --format=custom` plus `metadata.json` binding release, ledger digest, role snapshot, schema digest and required-row hashes into the database-restore identity consumed by #60/#61. Source is read-only; accepts an optional `#65` artifact-set digest input (shape-validated, never generated here). |
| `deploy/postgres/restore-database.mjs` | `pg_restore --no-owner` into an explicit target only: `--target` must equal `--confirm-target`, non-empty targets are refused (empty explicitly first — a second restore starts from `DROP SCHEMA public`). The operator provisions the target logins first (`production_provision.sql`); restore reconciles the recorded memberships (fail closed on a missing login) and the restored identity is verified field by field from the target's observed state. **Rollback is restore from a prior backup set**: same command, same check, no separate path. |
| `deploy/postgres/evidence.mjs`, `restore-identity.mjs` | Shared evidence collection and identity computation/verification. |

## Operator flows

Fresh install (two-phase connections: bootstrap superuser provisions roles, restricted migrator applies schema):

```sh
psql -v dbname="control_room" -v owner="control_room_schema_owner" \
  -f deploy/postgres/provision-database.sql "dbname=postgres user=postgres"
export MIGRATOR_PASSWORD APP_PASSWORD SCHEDULER_PASSWORD  # from the secret store
psql -v migrator_password="$MIGRATOR_PASSWORD" -v app_password="$APP_PASSWORD" \
  -v scheduler_password="$SCHEDULER_PASSWORD" \
  -f db/roles/production_provision.sql "dbname=control_room user=postgres"
node deploy/postgres/apply-migrations.mjs \
  --bootstrap-target "host=/var/run/postgresql dbname=control_room user=postgres" \
  --migrate-target "host=/var/run/postgresql dbname=control_room user=control_room_migrator password=$MIGRATOR_PASSWORD"
```

Upgrade (pending suffix only; tampered history fails closed, never skips):

```sh
pnpm db:verify
node deploy/postgres/apply-migrations.mjs \
  --bootstrap-target "<superuser conn>" \
  --migrate-target "<migrator conn for the same database>"
```
Without either connection flag the applier prints its plan and exits 0. The old
single `--target` form never worked (the applier always required both phase
connections) and is now refused with a loud error pointing at the two flags.

Backup and disposable restore (never overwrites a live target by default):

```sh
node deploy/postgres/backup-database.mjs --source "<conn>" --out /srv/backups/cr-<date> \
  --pg-bin /usr/lib/postgresql/17/bin --ledger-digest sha256:<ledger> --required-tables tenants,workspaces
node deploy/postgres/restore-database.mjs --backup /srv/backups/cr-<date> \
  --target "<disposable conn>" --confirm-target "<same disposable conn>" \
  --pg-bin /usr/lib/postgresql/17/bin --required-tables tenants,workspaces
```
Provision the target logins first (same `production_provision.sql` command as
fresh install, pointed at the target database) — restore reconciles the
recorded memberships and refuses a missing login.

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
  deterministically, then `production_roles.sql` grants are re-applied and the
  recorded memberships are reconciled (missing logins fail closed — provision
  the target first). The identity check verifies restored *content* (rows,
  schema, ACLs) **and** the target-observed role model: every sensitive role
  attribute (including replication and row-security bypass) plus memberships
  and administration rights, compared field by field.
- Test cleanup and retention are bounded: tests use disposable `initdb` clusters
  and `mkdtemp` roots removed in `t.after`/global teardown; no broad deletion.
