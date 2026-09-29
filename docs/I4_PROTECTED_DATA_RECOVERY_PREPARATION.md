# I4 protected data and recovery preparation

**Status:** source-only preparation. It performs no filesystem, database,
backup, restore, service, credential, network or worker effect.

This package extends the retained Control Room components named in the I4 row
of `INSTALLATION_REUSE_IMPLEMENTATION_MAP.md`. It does not add another storage
adapter or backup engine.

## Reused source

- `src/artifacts/v1/persistent-local-storage.ts` already owns the private,
  create-once result-byte store and its filesystem safety checks.
- `src/web/v1/private-artifact-storage.ts` already validates and binds the
  operator's protected root without publishing it.
- `src/artifacts/v1/artifact-backup-inventory.ts` already binds every retained
  result fingerprint and compares an expected inventory with a restored one.
- `src/harness/v1/local-backup-restore-readiness.ts` already joins an exact
  disposable PostgreSQL restore with the independently rechecked result
  inventory.
- `deploy/postgres/backup-database.mjs`, `restore-database.mjs`,
  `restore-identity.mjs`, and `evidence.mjs` remain the only database
  backup/restore/evidence tools.
- `scripts/backup/restic-retained-snapshot.ts` remains the optional
  operator-installed Restic adapter. This installer package does not bundle,
  invoke, configure or replace Restic.

## What this package adds

`protected-data-recovery-preparation.ts` gives the installation coordinator two
redacted records:

1. A protected-data preparation that recognizes whether the private data root
   is missing, needs verification, or has already been verified. It retains
   only opaque digests and never returns the path.
2. A recovery preparation that can request the existing owner-attended
   rehearsal or record an already verified disposable restore. The verified
   form independently checks the existing combined database-and-artifact proof
   against the release, topology, database identity, schema and private storage
   namespace selected by the installation plan.

Both records require their exact installation stage to be running. Their
operation names are instructions for a later owner-only wrapper; calling these
functions performs nothing. Recovery verification and operation selection also
require a separately supplied trusted observation, so a caller cannot relabel
an unproven rehearsal as verified. A changed plan, root binding, observation, database
identity, schema, inventory, or restore proof is refused.

The recovery stage input contains evidence that becomes known during earlier
stages. The coordinator therefore refreshes the still-not-started recovery
stage after the database stage passes, and again after the protected-data stage
passes if its observation changed. The existing installation-plan refresh keeps
the earlier passed stages and invalidates only the not-yet-started recovery and
later stages. It refuses this refresh if recovery is already running or
uncertain, so this sequencing cannot erase an attempted restore.

## Still required

The later owner-only installation wrapper must create or select the directory,
open the existing storage adapter, run the existing database and Restic tools,
and submit their sanitized evidence. Those effects remain separately gated and
are not authorized by this source package.
