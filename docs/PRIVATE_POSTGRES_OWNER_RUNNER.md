# Private PostgreSQL owner runner

## What this package is

This is the process-private runner beneath the already accepted, durable
database setup transaction. It validates one exact prepared request and calls
only injected adapters for Control Room's existing PostgreSQL provisioning,
migration, and evidence tools. It does not contain credentials, connection
details, process discovery, networking, or SQL execution code.

## Reuse decision

The runner **reuses** the existing reviewed PostgreSQL tools and contracts:

- `deploy/postgres/provision-database.sql`
- `deploy/postgres/apply-migrations.mjs`
- `deploy/postgres/evidence.mjs`
- `deploy/postgres/migration-ledger.json`
- the production role and grant scripts under `db/roles/`
- the existing append-only installation-plan transaction

No donor database framework or alternate migration system is adopted. This is
a small Control Room-specific safety connector because release identity,
owner-attended confirmation, exact migration-ledger binding, least-privilege
evidence, uncertain effects, and durable installation receipts are part of
Control Room's authority boundary.

## Safety behavior

- The release and all 87 migration-ledger entries must match exactly.
- The database roles, memberships, table permissions, sequence permissions,
  migration history, required rows, and restricted-login proof must match the
  reviewed production scripts exactly.
- Extra role membership, public access, grant options, malformed permissions,
  unknown roles, or excessive application permissions refuse.
- Provisioning and migration return intermediate evidence only. They cannot
  mark the installation stage complete.
- Only a final exact evidence collection can return the terminal confirmation
  consumed by the durable setup transaction.
- A malformed or lost reply after an effect might have started is uncertain,
  never a safe refusal or automatic retry.
- Cancellation and cleanup are bounded, and public errors contain no private
  configuration or database detail.

## What remains

The production adapters, private configuration loader, and one owner-attended
live rehearsal remain separate gated work. This package neither contacts a
database nor creates one by itself.
