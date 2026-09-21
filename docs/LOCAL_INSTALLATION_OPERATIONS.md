# Local installation operations

This is the operating design for the **This computer** Control Room setup. It
uses the same application records as a several-computer installation. It does
not introduce a local-only task database, a second scheduler, or a separate
review process.

## What is permanent

One installation has one authoritative PostgreSQL database. It holds projects,
tasks, approvals, reviews, durable result receipts, and worker delivery state.
PostgreSQL remains the only global writer.

The local artifact directory holds result bytes only. It is not allowed to
hold task ownership, schedules, locks, approvals, or a replacement database.
The existing persistent local artifact adapter verifies its private directory
and every saved result binding again at startup. A missing, substituted, or
corrupt directory makes startup refuse rather than silently starting empty.

The local Hermes runner holds its executable location, existing login, selected
model, provider, and working directory privately. None of those values go in
the database, task packet, browser response, logs, or backup inventory.

The private website can show a read-only setup checklist. Each item is tied to
the exact reviewed installation plan and is only **passed** when the installer
has attached a non-secret evidence fingerprint. The checklist cannot run a
check, enable a worker, or treat a missing record as success. A completed
checklist means only that the next, separately authorized owner-enable step is
available.

## Normal start

1. The operator supplies the reviewed server-only configuration.
2. Control Room opens the one PostgreSQL database and checks its expected
   schema and restricted role.
3. It opens the existing private artifact directory through the accepted local
   storage adapter and verifies saved result bytes against database receipts.
4. It reads unfinished work. A task with an uncertain start, uncertain result,
   or incomplete cleanup stays visibly uncertain; it is not automatically
   rerun.
5. Only after those checks pass may the existing application host report ready.
   The local Hermes runner receives work only through the same controller
   delivery record used for a remote worker.

## Restart and recovery

Restarting Control Room does not mean restarting an agent task.

- A saved, completed result is read from its receipt and presented for normal
  review.
- A task that has a delivery receipt but no terminal result is unresolved. The
  owner can inspect it; the scheduler cannot create a duplicate task merely
  because the application restarted.
- A lost local or remote reply is also unresolved. Reconnecting a worker may
  provide a later receipt or result, but does not create a new task identity.
- A revoked or incompatible remote worker cannot reconnect into new work until
  it is deliberately re-enrolled with a compatible adapter version.

This is why the local runner has no automatic retry loop. The existing task
and review records decide what happens next.

## Backup and restore

Database recovery and result-byte recovery are separate checks:

1. PostgreSQL backup is made with the existing operator-owned PostgreSQL
   procedure.
2. The artifact backup inventory names the exact saved result receipts and
   byte identities without granting backup authority to workers.
3. Restore first targets disposable, empty destinations. It verifies database
   ownership, restricted access, required rows, schema identity, and the exact
   artifact inventory.
4. A failed restore destination is retained for diagnosis. It is not reused or
   promoted automatically.
5. Promoting a verified restore, changing a database, selecting an object
   storage provider, or configuring backup credentials remains an
   operator-authorized production operation.

Control Room does not invent another backup product. It composes the existing
PostgreSQL and artifact backup/restore procedures once their real operator
configuration and disposable restore evidence exist.

## What is ready versus what still needs proof

Ready in source:

- persistent local result-byte custody and restart validation;
- terminal-result staging and recovery composition: an installed local runner
  can preserve one finished terminal line before returning, so a restart can
  publish it without launching the task again;
- one-database application composition;
- local and remote worker delivery records that preserve uncertainty;
- a local Hermes text-only qualification launcher and a separate fixed-runner
  bridge qualification launcher. The first proves Hermes can answer; the
  second proves the exact Control Room runner can safely reach it.
- a protected website readiness checklist that distinguishes not started,
  passed, failed, and unavailable proof steps without displaying the underlying
  host, account, path, command output, or credentials.

Still requires owner-authorized evidence:

- real local PostgreSQL configuration and a disposable database restore;
- a selected private artifact backup location and a verified restore;
- a persistent unprivileged service supervisor;
- one separately authorized real, restricted Hermes text task through the
  already-qualified runner, including its terminal-stage callback, restart
  recovery, and owner review;
- a two-computer delivery and reconnect proof.
