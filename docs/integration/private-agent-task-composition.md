# Private agent-task server composition

Issue #66. Modules: `src/web/v1/private-task-startup.ts` (composition factory),
`src/web/v1/private-task-worker-application.ts` (joint application/worker view),
`src/web/v1/private-startup.ts` (website-only bootstrap and read-only database check).
Tests: `tests/private-agent-task-composition.test.ts` and the compiled lane in
`tests/vps-built-task-startup.test.mjs`, with fakes in
`tests/helpers/private-agent-task-composition.ts`.

## What it is

One factory, `createPrivateTaskBootstrap`, that assembles the already-built database,
queue, worker, result, review, evidence, session and recovery components into a single
owned application lifecycle. It is integration wiring, not a framework: every component
is constructed by its own canonical factory and this module only decides ordering,
ownership and refusal.

Construction is inert. `createPrivateTaskBootstrap(...)` opens nothing; the explicit
`start(configuration, signal)` call is the first possible pool effect. A bootstrap
accepts exactly one `start` — a second attempt refuses with
`private_task_startup_already_attempted`, so a failed or drained lifecycle is the
supervisor's problem, not a silent in-process retry.

## Start order

1. `validatePrivateTaskStartupConfiguration` captures and freezes the whole
   configuration before any resource exists (see the fail-closed rules below).
2. Injected dependencies are checked against the captured configuration: artifact
   storage, native submission producer, queue worker and news factories must each be
   present when their component is configured, otherwise
   `private_task_startup_config_invalid`.
3. Artifact storage opens, then pools open one at a time in a fixed order — web,
   coordinator, result, evidence, session, idea creation, idea runtime, news
   coordinator, news ingestion. Each pool passes its own preflight
   (`verifyPrivateDatabase`, `verifyTaskCoordinatorDatabase`, `verifyNativeResultDatabase`,
   `verifyNativeEvidenceDatabase`, `verifyNativeSessionDatabase`,
   `verifyIdeaCreationDatabase`, `verifyIdeaRuntimeDatabase`, the two news verifiers)
   before the next pool opens, and no two pools may share a client.
4. The native submission producer is prepared against the coordinator pool, bounded by
   a 5s timeout.
5. `createPrivateTaskApplication` composes the web process and the task coordinator
   lifecycle over the owned pools.
6. When `queueWorker` is configured, the queue worker starts with `deliver` bound to
   `application.queueDelivery` and `verifyRecovery` bound to
   `application.queueRecovery.verify`, both joined to the startup abort signal.
7. `composePrivateTaskWorkerApplication` installs the joint view, and only then does
   `dependencies.install(...)` run. The returned runtime exposes `isReady`, `close` and
   the trusted server-only operations (`queueDelivery`, `queueRecovery`, `submission`,
   `quality`, `revisions`, `results`, `evidence`, `nativeHttp`, `connections`,
   `artifactStorage`). It exposes no SQL client, key material or queue input.

No step opens a listener, provisions SQL, reads a credential store or contacts a
provider. Listener binding belongs to `createPrivateTaskHost`, one layer up.

## Fail-closed rules

- Website-only keys (`planning`, `assignment`, `approvals`, `submission`,
  `queueAttention`, `revisions`, `ideaCreation`, `newsCollections`) inside the web
  profile refuse in `validatePrivateStartupConfiguration`.
- Every component role must share one host/port/database with the coordinator role and
  use a pairwise-distinct login. A reused login refuses.
- Dependency chains refuse before acquisition: recovery needs the native queue, the
  native queue needs approvals, the queue worker needs the queue plus sessions, sessions
  need evidence and a delivery-receipt-capable approval store, evidence needs quality
  and the result role, Codex needs queue plus sessions plus matching routes and
  negotiated features, Codex result return needs the complete composition plus artifact
  storage, native HTTP peers must all be configured session nodes.
- Checkpoint writes are denied at capture time: planning keeps `read` and replaces
  `initialize`/`advance` with a throwing `private_task_checkpoint_write_denied`.
- Every refusal past validation is `private_task_startup_prerequisites_failed`, or
  `private_task_startup_cleanup_uncertain` when any owned component's cleanup did not
  provably finish.

## Ownership and cleanup

Every returned resource is owned the moment the factory returns it, before its result
is inspected. Each owned close is memoized and bounded (5s for pools, producers and
the idea runtime; 30s for worker and news factories), so a failure before or after
ownership transfers to the combined application never double-closes a pool and never
leaves an unowned handle. A factory that rejects without returning a cleanup handle
marks the startup uncertain rather than claiming a clean failure. Cancellation through
the caller's `AbortSignal` is honoured between every step and by late-returning
factories, whose result is closed immediately on arrival.

Partial-start cleanup closes, in order: workers, the application, the submission
producer, the idea runtime, news handles, then every acquired pool — all settled, so
one failure cannot skip another component's drain.

## Drain

`composePrivateTaskWorkerApplication` is the joint host view. `close()` is idempotent
and drains workers first, so in-flight deliveries keep the application and session
services they need, then closes the application. New browser requests are refused with
`503` and `cache-control: no-store` from the moment close begins. Any unresolved
component close surfaces as `private_task_worker_cleanup_uncertain`.

## Readiness, disconnect and reconnect

`isReady()` is a live probe, not a latched flag. It is false unless the composition is
not closing, every acquired pool reports available, the session manager and native HTTP
host are available, and every worker still reports `accepting`. Losing any single pool
therefore fails closed for new work immediately — the installed application answers
`503` — and restoring the same pool makes the composition serve again without a
restart. The coordinator only latches permanently at close.

## Restart

Restart is a new composition over the same durable database: new pools, a new producer,
a new worker, no shared process state. Durable state is restored by reading it, not by
recreating it, and the no-duplicate-execution fence is canonical rather than
queue-metadata-based. Two independent layers refuse:

First, `NativeQueueAuthority` admits a queue locator only when the durable queue intent
matches it — same packet digest, same derived `queueId`, an active approving identity
with current owner grants, and a deadline that has not passed. A locator with a
mismatched packet digest is refused as `access_denied` and never reaches the canonical
service at all.

Second, for an admitted locator the canonical fences decide:

- `requireNeverStaged` refuses recovery or recovered-pickup verification for any
  attempt that already has a delivery envelope, transmission intent, delivery receipt
  or harness run.
- `recoverNeverStagedQueueDelivery` derives its ordinal from the durable
  `native.queue.unsent_recovered` audit sequence and is bounded by
  `MAX_NATIVE_UNSENT_RECOVERIES`.
- `verifyRecoveredQueueDelivery` requires the audit sequence to match the claimed
  retry ordinal exactly, so a restarted worker replaying a job cannot skip, invent or
  reuse a recovery.

A recovering producer that would happily re-send is not enough to get a second
execution: the canonical fence, not the producer, decides.

## Test coverage

| Behaviour | Test |
| --- | --- |
| Success: acquire, ready, drain, close each resource exactly once | "agent-tasks composition acquires, becomes ready, drains and closes every owned resource exactly once" |
| Disconnect / reconnect of every owned pool | "a disconnect on any owned pool closes the composition to new work and a reconnect restores it" |
| Restart restores durable state, refuses duplicate execution | "a restarted composition restores durable delivery state and refuses to execute the same attempt twice" |
| Dependency refusal before any resource or listener | "configuration and host mismatches refuse before any resource or listener opens", the Codex result-return matrix, and the operator refusal matrix |
| Partial-start cleanup | "each database acquisition failure closes only resources already returned", "submission failures, timeout and an aborted late return leave no producer, worker or listener alive", "worker and listener failures, timeouts and abort drain every acquired component", "cleanup failures remain explicit while every other owned component is still drained" |
| Compiled VPS lane over the same composition | `tests/vps-built-task-startup.test.mjs`: "compiled composition wires the full agent-task lifecycle, survives a pool disconnect and refuses duplicate execution after restart" |

## Limitations (honest)

- The composition tests run against one disposable PGlite backend with real LOGIN
  session identities. They prove SQL privilege separation and durable-row behaviour,
  not physically independent PostgreSQL connections or concurrency.
- The queue is a synthetic pg-boss double; the queue schema permission gate result is
  injected rather than installed. No listener is bound, no provider is called, no
  credential is read and no database is provisioned.
- The compiled lane exercises the compiled startup and host bundle
  (`dist-vps/server/taskBootstrap.js`, `dist-vps/server/taskHost.js`). The queue-worker
  bootstrap used by the fixture is still the TypeScript source, because no compiled
  export of it exists in `dist-vps`.
- The restart tests cover the already-delivered attempt the lifecycle fixture creates,
  so they prove refusal of a duplicate execution. A never-staged attempt's successful
  recovery-ordinal progression is covered by the dedicated queue-recovery suites, not
  here.
- `isReady()` observes some pools through more than one clause (for example the result
  pool is reported by both the coordinator lifecycle and the native HTTP host's own
  readiness probe). Removing a single redundant clause therefore does not change
  observable behaviour, and no test — old or new — can distinguish it.
