# Installation-transition persistence decision

**Decision:** retain the existing Control Room transition state machine and
canonical PostgreSQL patterns. Add a small, signed, append-only transition
record store and an installation-owned admission-fence reader. Do not adopt a
workflow engine, deployment manager, migration tool, queue, or remote-control
application.

## Why this is a small Control Room connector

The reviewed outside projects in [SINGLE_MACHINE_REUSE_AUDIT.md](SINGLE_MACHINE_REUSE_AUDIT.md)
cover agent sessions, local process presentation, and optional observation.
None can prove that one specific Control Room worker route is paused while the
same PostgreSQL task, receipt, result, review, and correction records remain
authoritative. Importing their schedulers, databases, session stores, or
credential handling would create a second authority.

Control Room already has the pieces this needs:

- `installation-transition.ts` supplies the reviewed, revision-checked state
  machine;
- `installation-topology.ts` supplies the complete before/after route binding;
- the existing PostgreSQL migrations and HMAC-backed evidence stores supply
  append-only storage and tamper checks; and
- existing task admission remains the only place that can later decide whether
  work is eligible.

## Narrow scope

The package may persist and reread a reviewed transition, and may answer the
single question: **is new admission for this affected worker currently
paused?** It must not start or stop a worker, change a route, enroll or revoke
a worker, move data, alter a scheduler, or activate a database. Those remain
separately authorized installation operations.

Every revision is bound to its tenant in addition to its transition record.
Copying a signed revision into another tenant therefore fails verification;
the coordinator role alone can read or append the raw journal.

## Acceptance evidence

Tests must prove exact replay, changed-record refusal, stale-revision refusal,
tamper refusal, and that an affected worker is blocked only after the durable
pause stage and remains blocked through drain/proof/failure preparation. A
committed or rolled-back record may remove the temporary fence, but cannot by
itself enable a route.
