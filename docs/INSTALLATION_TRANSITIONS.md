# Installation choices and safe transitions

Agent Control Room is one self-hosted product with two installation choices:

- **This computer**: the controller, web interface, and one or more workers run
  on one computer.
- **Several computers**: the same controller reaches enrolled workers on other
  computers.

These are not editions, forks, or separate databases. Each installation has
one PostgreSQL authority database, one existing scheduler, one task lifecycle,
and one result/review record. A browser or phone is simply another way to view
the controller; it is not another authority.

## What is available in source today

The source already has one signed controller-to-worker delivery packet, local
and remote delivery seams, durable receipt and result/review recovery rules,
and disposable tests proving the same lifecycle works through both routes. It
also has a read-only setup plan that lists the proofs required before workers
can be enabled. These are preparation and test results, not a claim that any
agent or remote computer is live.

The first local adapter being completed is a bounded Hermes Agent text task.
Codex and Claude Code have the same project/task/result/review contract but
still require their own installed-process qualifications. No adapter is made
available merely because its source code exists.

## The three choices that must stay separate

1. **Controller placement** — where the application and web interface run.
2. **Authority placement** — where the one PostgreSQL database and protected
   result storage run.
3. **Worker placement** — which computers have enrolled local or remote
   workers.

Adding a worker normally changes only item 3. Moving the controller may change
item 1 while leaving the database in place. Moving the database is a separate
maintenance operation. This separation prevents accidental synchronization or
two independent writers.

## Supported transition model

### Add or remove a computer

Control Room will create a reviewed transition record, pause new admission for
the affected routes, drain or mark uncertain active work, verify worker
compatibility, enroll or revoke the route, then commit one new installation
configuration. A removed worker's uncertain task is never silently restarted
on another computer. Remote disconnects use the existing receipt/result
recovery path rather than a guessed resend.

### Move the controller

The target must first pass the same release, protected-configuration, and
startup checks. Private configuration and protected result material are moved
through a separately verified procedure; credentials and local paths are never
copied through tasks or GitHub. The old controller is fenced before the target
can schedule or write. Workers reconnect through their ordinary enrollment and
receipt checks.

### Move the authority database

Database relocation is a planned cutover, never a live sync:

1. Preflight the target release, PostgreSQL compatibility, roles, storage,
   restricted access, and available capacity.
2. Stop new task admission and scheduler pickup; drain known work and leave
   uncertain work explicitly unresolved.
3. Fence the old controller and scheduler so they cannot resume writes after a
   restart.
4. Use the existing PostgreSQL export/restore and protected-artifact inventory
   tooling to make a consistent, bound snapshot and rollback checkpoint.
5. Restore only into an empty target, then verify schema, grants, canonical
   rows, queue state, artifact hashes, and the checkpoint.
6. Activate exactly one target controller/scheduler, then re-enroll or rebind
   workers using the ordinary delivery recovery rules.

Before the new target accepts writes, rollback can return to the fenced source
after stopping the target. Once the target accepts writes, a return requires a
fresh verified reverse migration so history is not lost.

## What remains to make transitions real

1. Bind every current and requested worker route into the reviewed topology
   record; record removals explicitly and invalidate old proof on any route
   change.
2. Add a canonical transition state machine for admission pause, drain,
   requalification, commit, failure, and rollback preparation.
3. Finish a supported local installation package: private configuration setup,
   protected data, launcher definitions, diagnostics, upgrade and uninstall
   instructions that preserve data.
4. Complete installed-process qualifications and private host bindings for
   each local adapter. Hermes Agent comes first, then Codex and Claude Code.
5. Add remote enrollment, compatibility, reconnect, revocation, and a
   controlled two-computer proof using the same delivery contract.
6. Build a source/target cutover coordinator around the existing verified
   PostgreSQL and artifact backup/restore tools, followed by interrupted-
   cutover and reverse-move acceptance tests.

The complete implementation order is in
[UNIFIED_TOPOLOGY_BUILD_PLAN.md](UNIFIED_TOPOLOGY_BUILD_PLAN.md). The current,
evidence-based status is in [BUILD_STATUS.md](BUILD_STATUS.md). Neither file
contains private installation settings or credentials.
