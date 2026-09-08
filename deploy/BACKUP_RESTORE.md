# Dedicated-database backup and restore acceptance

This is an operator procedure for later, separately authorized execution. It does
not authorize provisioning, shared-primary relocation, production SQL, backup
downloads, live authentication, or deleting a target. The current shared primary's
storage persistence must be established before production deployment. A logical
backup does not make container-overlay storage durable.

## Preparation

Record the exact immutable release and deployment source inventory. Privately
identify the dedicated source database, schema owner, restricted web login, backup
identity, archive destination, and a different empty disposable restore database.
All must be in the approved private execution namespace. Never infer a target from
an ambient PGDATABASE, default username, or connection URL in a pasted command.

Use PostgreSQL 17 client tools compatible with the primary. Keep authentication in
the approved private password/service-file mechanism, outside Git and command-line
arguments. Restrict archive and configuration directories to their operator. Use a
new unique archive path in an exclusively controlled directory; do not overwrite an
existing backup. Establish free disk and backup resource limits first.

## Create and inspect

Use the existing `pg_dump` tool, custom format, for the **whole dedicated database**.
Do not filter tables/schemas, remove ownership/ACLs, or introduce a custom backup
format. Select host, port, database and username explicitly; use `--no-password`
to fail rather than prompt when the protected authentication is unavailable.

Record the command exit code and review warnings privately. Record archive size
and SHA-256 without printing contents. Inspect the archive with `pg_restore --list`;
keep its object names and full diagnostics private. Neither a hash nor a successful
list operation proves restoration works. Only restore archives from the approved
trusted source; restoring a dump executes SQL from that source.

Preserve Control Room's reviewed role definitions, exact grants, configuration and
integrity keys separately through the approved encrypted backup mechanism. A
database dump does not include cluster roles. Do not export the shared primary's
entire role/password inventory merely to back up this application.

## Restore into the disposable target

Verify source and destination are different and the destination is empty. Create
the target only under separate provisioning authority, with the reviewed schema
owner. Reuse already reviewed role identities on the same primary; do not recreate
or alter cluster-wide roles for a disposable database. On a separate rehearsal
primary, establish only the needed reviewed roles first.

Use `pg_restore --single-transaction --exit-on-error --no-password` with an explicit
destination database and approved connection identity. Do **not** use `--create`,
`--clean`, `--no-owner`, `--no-acl`, or parallel jobs. A failure is a failed restore,
not permission to replay into a partially populated target or relax permissions.
Restore database-level privileges separately using the reviewed dedicated-database
procedure; the archive alone is not proof of correct database ACLs.

## Prove the restored database is usable without starting the website

Prepare a protected operator settings file whose database target is the disposable
restore, never the source. Preserve the approved issuer/owner/workspace binding;
do not invent an identity to satisfy preflight. With separate authorization for
this read-only connection, run:

```text
node /APPROVED/RELEASE/scripts/check-private-vps-database.mjs --configuration /APPROVED/RELEASE/deploy/operator-config.mjs
```

Set `CONTROL_ROOM_SETTINGS_FILE` privately to that restore-specific file. This
command reuses production schema, effective grants, ownership restrictions and
owner/workspace checks, then closes the pool. It does not fetch login keys, install
the application, bind a listener, start agents, or migrate data. It deliberately
reports `backupVerified:false` and `productionReady:false`: its scope is narrower.
Here read-only describes the performed queries, not a read-only PostgreSQL session
or a sandbox for executable operator configuration. Production preflight checks
that the target is a writable primary with the restricted application privileges.

Separately verify required restored rows and signed application records against
the captured source evidence. Compare from a consistent source snapshot or an
approved period with Control Room writers quiesced; unrelated websites need not
stop. Verify protected integrity/configuration material can be recovered. Confirm
the encrypted off-host copy is retrievable and hash-matches, under separately
approved transfer authority. A same-disk archive alone is not disaster recovery.

## Report and cleanup

Return only release/inventory reference, sanitized pass/fail checks, tool exit
codes, archive hash/size when approved, connection cleanup, and remaining blockers.
Keep database names, identities, table contents, credentials and raw diagnostics
in the private operator channel. The owner approves cleanup of the exact disposable
target after evidence review; no wildcard deletion, role removal, or automatic
restore over the live database. Retain the approved backup under its retention
policy even after deleting the rehearsal target.

Upstream tool behavior: [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
and [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html).
Control Room's target isolation, acceptance and authority requirements above are
project requirements, not claims that these tools enforce them automatically.
