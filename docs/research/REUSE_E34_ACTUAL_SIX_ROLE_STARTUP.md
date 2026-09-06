# E34 — actual six-role startup composition

2026-09-06. Local disposable PGlite; no native service/provider/listener.

The actual-package worker suite now starts the full configured application with web,
coordinator, results, evidence, managed-session and queue-worker LOGIN identities. Unlike
the older host-lifecycle fixture's minimal queue tables and fake worker, this uses actual
pg-boss 12.30.0 schema, producer preparation, worker identity/permission preflight, worker
runtime registration and explicitly configured canonical recovery callbacks together.

The shared managed-startup fixture was extracted without changing its setup behavior.
The existing 27 managed-startup tests pass after extraction. The new combined test passes
against both source and compiled task bootstrap. It proves all five application logins
are supplied to the distinct worker startup, worker readiness precedes installation,
managed connection and recovery ports are exposed, and repeated close shuts each of six
owned logical pools once with worker shutdown before application pool shutdown.

Typecheck, targeted ESLint and whitespace checks pass. An unused type import left by
fixture extraction was removed after lint reported it; no production code changed here.

Important limit: this fixture begins with historical simulated completed work and the
new queue is empty. It proves actual idle host startup/shutdown, not a new task's delivery
through that host. Existing connected queue-to-review tests still cover delivery in a
separate composition. Do not combine those claims into full-host journey acceptance.
All identities share one serialized PGlite engine; physical PostgreSQL pool/concurrency
behavior remains unproven here. The compiled variant injects source queue adapters.

Next: fresh signed task through this complete host, including offline recovery and result
review, then interactive browser acceptance. No new acquisition, production permission,
credential access, GitHub write or deployment.
