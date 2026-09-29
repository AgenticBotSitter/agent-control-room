# Transition admission-fence decision

**Decision:** mount the existing transition-journal reader as an
installation-owned check inside the existing assignment and delivery
coordinator. Do not create a new queue, worker controller, route manager, or
browser operation.

## Reuse

The transition journal already supplies the only required fact: whether a
specific affected worker must remain paused. The assignment coordinator already
owns the moment a plan becomes a lease, and the existing Hermes, Claude, and
Codex delivery paths already recheck the lease immediately before delivery.
Those are the only safe places to apply the fence.

External scheduler, session, desktop, and remote-control donors were rejected
for this purpose in `SINGLE_MACHINE_REUSE_AUDIT.md`: they would own worker
selection, session state, routes, credentials, or retry behavior and therefore
conflict with Control Room's one-authority lifecycle.

## Boundary

The private installation assembly may capture one reader and its integrity key
after configuration validation. The browser, a task template, a worker, and a
queue item cannot name a transition, choose a worker, provide a key, or bypass
the reader. A reader failure or paused result refuses new admission and delivery
with the normal generic conflict outcome.

Planning remains possible: a plan names an adapter, not a specific worker. A
plan is not a lease or permission to run. The fence applies when the existing
coordinator has selected the specific worker for a new lease, and again at
each delivery boundary. Existing receipt/result recovery stays readable; it is
never turned into a new run merely because a transition is in progress.

## Non-effects

This source package must not change a route, start or stop a worker, drain a
queue, revoke an enrollment, activate a database, or move data. It merely
prevents the existing coordinator from admitting or delivering new work to a
worker that the durable transition journal says is paused.
