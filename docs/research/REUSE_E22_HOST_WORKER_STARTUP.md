# E22 — explicit host/worker startup and offline evidence

2026-09-06. Local opt-in implementation, not deployment acceptance.

## Implementation

Private task startup accepts an explicit queueWorker configuration and a trusted
startNativeWorker factory, normally bound to createNativeQueueWorkerBootstrap.start.
It requires prepared queue submission and managed sessions, validates the sixth
database identity against all five application logins on the same primary, and rejects
invalid topology or a missing factory before opening any pool.

After application preflights and producer preparation, startup passes the real
application.queueDelivery callback and captured login inventory to the worker factory.
It installs the joint lifecycle view only when application and worker are both ready.
Worker readiness failure gates browser requests; shutdown drains/closes the worker
before application services and producer/pools. Existing configurations remain unchanged.
There is no default worker factory, package loading, listener or deployment activation.

Startup waits at most 30 seconds for the worker factory. Abandonment aborts retained
delivery calls, refuses later calls and closes a late-returning worker. Factory rejection
without a cleanup handle remains uncertain. Returned cleanup is acquired before reading
the status getter. Cleanup failures do not skip remaining application cleanup or cause
a second startup attempt.

## Evidence and limits

The startup tests cover success, factory rejection, unavailable worker, install failure,
close failure, malformed status, throwing status getter and late completion after timeout.
They verify full login inventory, single cleanup, worker-before-pool ordering and no
installation on failure. These tests use actual application preflights with a minimal
queue ACL fixture and fake producer/worker factories: they are not actual-package
whole-host or six independent physical-pool evidence.

The separate actual-package scripts pass 45 checks. A new offline-node scenario observes
one pickup, zero transmission intents and the retained canonical queue intent. After a
signed reconnect and another polling interval, no dispatch occurs and the operational
job remains failed. This is a demonstrated recovery gap, not an offline delivery pass.

43 startup/lifecycle regression checks passed before the additional getter case;
all 10 focused startup checks passed after that addition. Typecheck, targeted lint
and whitespace checks passed on the final code.

## Next acceptance work

Do not enable production worker startup yet. Compose the actual verified worker and
producer with the full application under exact roles, complete queue schema acceptance,
then run the separately authorized real PostgreSQL and owner/browser/native journey.
Automatic offline recovery needs an explicit never-sent versus possibly-started decision,
current canonical approval checks, and upstream queue primitives rather than a new poller.
No generic retry, retargeting, browser identity fabrication or approval renewal was added.

No acquisitions, live agent/provider calls, credentials, persistent services or GitHub
publication. Existing temporary package acquisition only; PGlite fixtures close after tests.
