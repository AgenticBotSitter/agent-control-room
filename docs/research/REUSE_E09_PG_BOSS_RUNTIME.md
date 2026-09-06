# E09 — owned pg-boss worker lifecycle

2026-09-06. Local implementation after `7fab4a2`. Reuses retained E01 pg-boss
12.30.0; no download, native PostgreSQL service, provider or agent activation.

## Implemented reuse

`src/persistence/pg-boss-native-task-runtime.ts` composes the original pg-boss
constructor and E05 worker into one explicitly started/stopped lifecycle. Its caller
supplies the pinned constructor and a dedicated, already-authorized/preflighted worker
SQL pool. Ownership transfers after configuration validation. Never pass the producer's
or private web application's shared pool.

- Fixed schema; no migrations/schema creation, scheduler, supervisor or LISTEN/NOTIFY.
- Register infrastructure-error handling before package start; discard upstream error
  details and expose only coarse health/error categories.
- Retain E05's canonical callback, queue invariants, continuous pickup and concurrency.
  Capture configuration/methods before asynchronous work. A locator is not permission.
- Shutdown/error immediately fences admission and aborts active delivery callbacks;
  then drain the worker group, stop the dedicated package and close its SQL port.
  Failure in one cleanup step does not skip subsequent steps.
- Each lifecycle operation is bounded (default/max five seconds; shorter test bounds).
  Timers plus elapsed-time checks detect late completion. They cannot interrupt a
  blocked JavaScript thread or prove an external agent stopped. Up to three cleanup
  phases consume separate bounds. The supplied SQL client must already bound its I/O.
- Repeated close returns the same promise. Drain/stop/pool failure stays uncertain;
  startup failure with uncertain cleanup gets a distinct fixed error.
- Late worker registration is fenced and retired, with no automatic replacement,
  restart or retry after uncertainty.

This is application composition around an existing engine, not another daemon manager,
poller or retry engine. The custom responsibility is canonical admission and resource
ownership; pg-boss supplies generic queue mechanisms. No second engine is justified.

## Verification

Stage zero reported ready. Final checks:

| Check | Observed result |
|---|---|
| Runtime, submission and worker unit suites | 42 pass, including 12 new runtime tests. |
| Actual pg-boss submission + worker integration suites | 28 pass, zero failed/skipped, about 26 seconds. |
| `tsc --noEmit --incremental false` | Pass. |
| Targeted ESLint on four changed source/test files | Pass after test-only alias correction. |
| `git diff --check` | Pass. |

Commands use existing Node/tsx and the E01 package:

```sh
node --import tsx --test tests/pg-boss-native-task-runtime.test.ts tests/pg-boss-native-task-worker.test.ts tests/pg-boss-native-task-submission.test.ts
CR_REUSE_EVAL_ROOT=/private/tmp/control-room-reuse-eval.4GX1mK node --import tsx --test scripts/research/pg-boss-submission-integration.test.mjs scripts/research/pg-boss-worker-integration.test.mjs
```

Unit cases cover ownership/options, callback capture, bad configuration, constructor/
start/queue failures, fault before readiness, fault aborting a handler, stop/pool errors,
bounded uncooperative drain, timed-out start, late registration and combined startup/
cleanup failure. No failed cleanup is reported as a clean stop.

Two new actual-package tests exercise continuous pickup/owned shutdown and an
infrastructure fault aborting an active callback. Late delivered output becomes
unresolved operational failure with zero retry; subsequently enqueued work stays
unclaimed. Worker startup emits no CREATE/ALTER/DROP. Producer remains usable after
the worker's logical SQL port closes.

Seven existing canonical delivery cases now run through this owned runtime rather
than a pre-started admin worker. One synthetic staging/send with an absent receipt
remains unresolved. Expired/revoked owner approval, disposed pins, retired node,
completed project and tampered packet still reject delivery. Submission/replay and
transaction cases also pass.

PGlite uses one in-memory engine: distinct logical SQL ports model ownership here,
not real PostgreSQL pool isolation or restricted worker-role privileges. Canonical
tests use synthetic owner identity and an in-memory signed node session; no live fleet
or authenticated native result is claimed. No full repository suite/build or new
independent review was run in this block.

Initial lint found a `this` alias in a test constructor; replaced with an instance
collection. No product check weakened. Initial lifecycle/package tests passed; final
reruns include cleanup refinements and canonical runtime composition.

## Remaining adoption work

The module is opt-in, not mounted in private application startup. pg-boss is still the
isolated evaluated package, not an application dependency/production service. Remaining:
validate worker/producer roles and provision the queue separately; resolve current
canonical identity without queued browser credentials; supply dedicated bounded pools;
define supervisor/scheduler ownership, durable held/receipt recovery, upgrade/cutover
and crash/restore. Use OS service managers for process supervision. E02 permission was
spent; native database/live-agent acceptance requires its own scoped authorization.

Runtime unit tests are in the default test script. Dependencies and lockfile unchanged.
All test processes exited, fixtures closed, and retained downloads are unchanged.
