# E11 — effective worker permission preflight

2026-09-06. Local implementation; no native service or deployment.

The owned pg-boss runtime checks effective database permissions before creating
the package client. Missing permissions, excess access, malformed results and query
errors prevent startup and close the owned SQL port. Errors contain no raw SQL or
database details. Existing lifecycle time limits bound this check.

The read-only query checks fixed worker-role membership, dangerous role flags,
membership administration, schema/object ownership, database CREATE and replication
parameter SET, exact queue table/column grants, grant options, and non-system
function/sequence access. It rejects access to unrelated application relations.
This is a startup snapshot, not continuous protection against administrator changes.

## Evidence

- 43 queue unit checks pass, including malformed/failed preflight refusal before
  package construction and owned-pool cleanup.
- 32 combined actual pg-boss 12.30.0/PGlite checks pass. Owned-runtime and canonical
  approval/transmission fixtures now use SET LOCAL ROLE per worker statement.
- Negative tests reject missing DELETE, queue column UPDATE, private column SELECT,
  SELECT grant option, PUBLIC function execution and unexpected role membership.
  Restoring each grant restores acceptance.
- Full TypeScript check, targeted ESLint and whitespace validation pass.

First combined run: 25 passed and seven canonical delivery tests failed at startup.
Those fixtures loaded migrations without existing application-role preparation;
public trigger functions retained PUBLIC execution. Applying the existing
task_coordinator_roles.sql before worker-role preparation resolved this without
exempting functions or weakening the check. The PUBLIC function negative test
preserves coverage of this failure.

## Remaining boundaries

This does not prove real PostgreSQL pooling, LOGIN/session identity, TLS, database
identity, configured SQL timeouts, schema version/fingerprint or recovery behavior.
Those remain deployment requirements; SET ROLE is only the local test mechanism.
Application startup remains unwired; pg-boss is supplied from the retained isolated
evaluation package. No dependency or lockfile change, provider call, download,
PostgreSQL server or production grant.

Next: compose producer/worker provisioning and startup with existing application
database checks, including its schema allowlist, then validate the full adapter on
real PostgreSQL under separately scoped authority. This check does not replace that
acceptance.
