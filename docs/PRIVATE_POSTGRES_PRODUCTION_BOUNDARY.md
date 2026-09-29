# Private PostgreSQL production boundary

## Decision

Reuse the existing Control Room PostgreSQL owner adapter, owner runner,
migration ledger, SQL, and evidence collector. Build only the missing
Control Room-specific custody and child-process boundary. No donor database
manager, migration authority, scheduler, credential store, or deployment
system is adopted.

This boundary is unique to Control Room's installation authority: it must bind
one reviewed release and one owner-confirmed operation to the sole PostgreSQL
authority database. Existing third-party process wrappers cannot replace that
security contract without also importing a competing configuration and
authority model.

## Source-only guarantees

- Configuration is owner-only, no-follow, digest-bound, ACL-verified, and
  rechecked for every operation.
- Executables, the fixed owner tool host, reviewed PostgreSQL modules, all
  migration-ledger SQL, setup SQL, and the fixed `pg` dependency closure are
  captured into one private staged release before use.
- Protected ancestor and staged-file identities remain checked through spawn
  and cleanup. A detected replacement is preserved rather than deleted.
- `psql` starts with startup files disabled and a replacement environment.
  Secrets are not placed in argv, results, errors, or the inherited process
  environment.
- The child host exposes only the fixed migration and evidence operations.
  Import failure after the entry marker is uncertain, not a safe retry.
- Cancellation, deadlines, output limits, pipe errors, unconfirmed exit, and
  failed cleanup can never become success. Failed custody or deletion remains
  latched for the lifetime of the boundary.

## What this does not prove

The accepted tests use disposable files and controlled child processes. They
do not provision a database, load a production password, qualify the native
ACL verifier, or prove a particular host's PostgreSQL executable. Those remain
separate owner-attended qualifications. The boundary must not be described as
live until those exact checks pass.
