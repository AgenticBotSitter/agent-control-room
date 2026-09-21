# PostgreSQL setup preparation

I3 creates only a redacted preparation record for the `database_authority`
stage of a reviewed installation plan. It binds the plan digest, exact release
digest, migration-ledger digest, opaque target-identity digest, and observed
target state plus an opaque trusted observation digest. Verification receives
that observation separately, so a self-recalculated preparation digest cannot
turn a fresh target into a verified one or the reverse. It contains no database name, host, port, connection string,
password, path, SQL, or browser-controlled data.

Preparation is available only while the ordered installation plan's
`database_authority` stage is actively running. The stage input is a canonical
digest of the same release, ledger and opaque target identity, and verification
requires the trusted installation plan again. Recalculating an ordinary digest
therefore cannot retarget a reviewed preparation or skip earlier stages.

For a fresh target, the next owner operation is `owner_provision_database`;
for a provisioned empty target it is `apply_existing_migration_ledger`; for an
already verified target, it is `collect_existing_database_evidence`.
These name the existing PostgreSQL flow: `deploy/postgres/provision-database.sql`,
`deploy/postgres/apply-migrations.mjs`, `deploy/postgres/evidence.mjs`, the
committed migration ledger, and the existing `db/roles/` definitions. This
package adds no second SQL, migration, role, or connection path.

A broken target is refused. Any changed release, ledger, target identity, or
reviewed plan invalidates the preparation rather than allowing a stale replay.
The remaining effectful owner-attended wrapper must supply private target
configuration outside this record, run the existing provision/migration/evidence
tools, and record their sanitized results in the installation plan.
