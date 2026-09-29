# Private recovery owner runner and settlement

**Status:** source-only contract and disposable tests. No live backup, restore,
filesystem, database, credential, service, or network operation is implemented
or authorized here.

## Reuse decision recorded before implementation

This package extends the **Backup and restore — Retain Control Room** row in
`INSTALLATION_REUSE_IMPLEMENTATION_MAP.md`. It adds no store, scheduler,
database, backup engine, restore engine, or recovery journal.

- `protected-data-recovery-preparation.ts` remains the authority for the exact
  installation-plan, topology, release, protected-data, database identity,
  schema, storage namespace, and recovery-stage bindings.
- `protected-data-recovery-owner-action.ts` remains the redacted hand-off to
  the existing PostgreSQL backup/restore scripts, retained Restic adapter,
  artifact inventory verifier, and combined readiness proof.
- `local-backup-restore-readiness.ts` remains the only combined proof format.
  It proves an exact database dump and artifact inventory were restored to a
  disposable target and explicitly forbids promotion, work, retry, and cleanup.
- `installation-plan-journal.ts` remains the only durable installation record.
  Recovery settlement appends one normal plan revision; it creates no receipt
  database or side journal.

## Added boundary

`private-recovery-owner-runner.ts` captures one installation-private owner
confirmation callback and one existing-rehearsal callback before awaiting
either. It accepts only the running recovery action, exact installation
binding, and an exact verified combined proof. Failure before the rehearsal
call is a refusal; cancellation, timeout, malformed output, or error after the
call may have started is uncertainty. The source supplies no production
callback and therefore cannot perform a backup or restore.

`recovery-action-transaction.ts` rebuilds the same action, requires the private
runner's exact terminal confirmation, verifies the complete combined proof
again, and appends its `proofDigest` as the existing recovery stage outcome.
Exact replay and concurrent identical confirmation converge through the
existing journal. Changed, stale, foreign-installation, competing, or
uncertain evidence refuses without repair or retry.

## Remaining production work

A separately reviewed owner-attended composition must privately supply the
existing backup/restore adapters and native custody. This package does not
qualify a real destination, repository, database, filesystem, credential, or
operator presence and must not be treated as live-install evidence.
