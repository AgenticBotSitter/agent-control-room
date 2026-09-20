# Unified installation completion audit

**Status:** Source work is substantially proven with disposable test data. No
installation is operational yet. This document is the handoff checklist for
turning the source work into an honest, owner-operated installation.

## What is proven in source

### One product, two setup choices

The same controller packet, task identity, result receipt, review record, and
correction lifecycle work through both the local and remote delivery test
routes. The route is not part of task authority, and the tests use one
temporary PostgreSQL-compatible database for each journey. There is no second
scheduler, synchronization process, or second writable task database.

A read-only setup planner now describes the same transition from “This
computer” to “Several computers.” It keeps the selected database and scheduler
fingerprints, treats a worker assigned to both routes as an error, and lists
the proofs that must still be completed. It cannot enable a worker, connect a
machine, or make any live change.

The private website also has a plan-bound readiness checklist. It can show a
non-secret proof outcome as not started, passed, failed, or unavailable, but
only accepts a passed result when an installer supplies a matching evidence
fingerprint. This makes missing or stale proof records visible rather than
mistakenly presenting them as a running worker.

### This computer

- A successful owner-attended, text-only local Hermes qualification has been
  observed for this installation. Its model, provider, account, command,
  workspace, session reference, and terminal content are intentionally not
  retained here. This proves one bounded response path only; it does not
  enable an automatic worker or authorize a real task.
- A local Hermes worker accepts only a controller-prepared task with the
  installation-owned policy check.
- Control Room rechecks the same canonical task, lease, authority, worker
  binding, plan, and review contract immediately before it can create the
  local run record or invoke Hermes. A task revoked or changed in that narrow
  handoff window is refused rather than launched.
- The accepted delivery is recorded before the worker can run. Restarting the
  application cannot silently run the same task again.
- A private stream-json runner bridge accepts bounded result lines, refuses an
  ambiguous two-result stream, and saves one finished result before returning
  it to the application.
- Saved result bytes are tied to their exact task delivery, cannot be read by
  a different task, and cannot be replaced by different later bytes.
- A restart can use those saved bytes to continue normal result publication
  and owner review without starting Hermes again.
- The normal operator assembly can carry the installation-owned local Hermes
  executor into the ordinary task queue without requiring a remote session
  transport. Configuration remains inert: it captures only the executor
  callback and cannot start Hermes while the configuration is being built. It
  also refuses that callback unless the local text check, runner-bridge check,
  and backup/restore proof have been recorded for the reviewed plan.

### Several computers

- Enrolled workers use the shared task-delivery packet.
- A connected but non-target worker cannot receive a task intended for another
  worker, including after reconnect.
- An incompatible or revoked worker cannot become ready or substitute for the
  intended worker.
- In the disposable two-worker journey, only the intended worker can report
  progress and a completed result. It creates one saved result and one normal
  pending-review record.
- Lost delivery replies and disconnects remain uncertain; the source does not
  automatically retry the task.

## Evidence run locally

The following source checks passed after the current unified packages:

1. TypeScript type check.
2. Application production build.
3. Local Hermes stream, result staging, restart-recovery, and task-planning
   tests.
4. Shared local/remote task-result-review and correction lifecycle tests.
5. Two-worker enrollment, targeting, reconnect, version refusal, revocation,
   result, and pending-review tests.

These are strong source evidence. They do **not** prove that a real Hermes
installation, a real database, a real remote computer, or a real backup
procedure has been operated successfully.

## What remains before enabling This computer

1. The owner supplies private settings that pin the existing local Hermes
   installation to the tested stream-json wrapper. The wrapper is already in
   Control Room source; it does not need a custom Hermes modification. Its
   executable location, login, model, provider, and workspace remain outside
   this repository and outside Control Room records.
2. Preserve the successful text-only, owner-attended Hermes qualification as
   a plan-bound setup proof when the installation configuration is assembled.
   It remains insufficient by itself to enable any real task.
   Record a distinct successful owner-attended check of the fixed-argument
   Control Room runner bridge before treating the local connector as ready.
   An effect-free runner preflight can be used first to catch an unusable
   selected program or work directory without calling Hermes.
3. The owner chooses an existing protected local result directory and provides
   the already-reviewed database configuration. The application must open both
   successfully without creating a second database.
4. A disposable backup-and-restore rehearsal verifies both the database and
   saved result bytes. It must not promote a restored copy automatically.
5. A real restart proof confirms the local runner stages a result, the process
   stops, and the result reaches pending review without a second Hermes run.
6. A persistent unprivileged supervisor and update/rollback procedure are
   selected and separately authorized.

## What remains before enabling Several computers

1. Choose one private controller host and one authoritative PostgreSQL
   database. This is an operator decision; the source does not provision either.
2. Connect one genuinely enrolled worker through the reviewed private
   transport. Do not expose a listener publicly or copy private keys into the
   repository.
3. Run a controlled two-computer proof covering delivery, result, review,
   disconnect, reconnect, revocation, and version mismatch.
4. Prove backup/restore, private access, unprivileged supervision, health
   checks, update, and rollback on disposable or approved operator-owned
   infrastructure.

## Rules that remain in force

- PostgreSQL is the sole global writer for each installation.
- Local files and remote artifact storage hold result bytes only; they never
  decide task ownership, approvals, scheduling, or completion.
- A reconnect may return evidence for the original packet. It may not create a
  replacement task or silently retry uncertain work.
- A worker result enters owner review; a worker cannot accept its own result.
- Qualification, installation, credentials, databases, DNS, persistent
  services, and production effects remain owner-authorized operations.
