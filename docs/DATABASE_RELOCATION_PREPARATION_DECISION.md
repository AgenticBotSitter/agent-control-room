# Database-relocation preparation decision

**Decision:** prepare a source-only, evidence-bound cutover plan around the
existing PostgreSQL migration verifier, artifact-backup inventory, restore
verification, and independently retained rollback checkpoint. Do not add a
database-copy service, replication system, synchronization layer, backup
engine, or a second writer.

## Reuse decision

Control Room already contains the relevant tested building blocks:

- `deploy/postgres/apply-migrations.mjs` verifies ordered PostgreSQL schema
  setup and restricted roles;
- `artifact-backup-inventory.ts` creates an exact result-byte inventory and
  verifies a restored copy without making a restore happen; and
- `rollback-checkpoint.ts` requires the rollback anchor to live outside the
  database being protected.

The reviewed Restic package is retained as an operator-run snapshot transport,
not an application component. The evaluated agent, desktop, session, and
remote-control projects have no safe fit for one-authority database cutover;
their schedulers, database stores, credentials, and remote management would
conflict with this product's authority boundaries.

## Narrow source package

The new contract may bind these already-produced facts into one reviewed
cutover plan:

1. source and target authority fingerprints;
2. the same release/schema identity and restricted-role proof;
3. an exact artifact inventory and independently retained rollback checkpoint;
4. a source-admission fence and an explicitly **clean** drain. A recorded
   uncertainty, failed transition, or rollback path cannot mark a relocation
   ready; it must remain visible for owner resolution before a fresh preflight;
   and
5. the rule that exactly one target may be marked ready for a later,
   separately authorized activation.

It must remain a plan and verification record. It must not export data, create
or restore a database, access backup credentials, fence a live service, start
a scheduler, choose a target, or activate either controller.

## What later operator work still owns

An owner-authorized maintenance run will produce the actual dump, artifact
copy, external rollback checkpoint, empty-target restore, role/schema checks,
and one-controller activation. A failed or interrupted attempt stays visible
as failed or uncertain. It is never repaired by a guessed retry or an automatic
reverse move.
