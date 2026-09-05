# CR14C — owned task coordinator lifecycle

Status: implementation candidate. Base: PR #296, `ecedfcaf2b6ff132181adf6bedfb25193372a5ed`.

## Product scope

`createTaskCoordinatorLifecycle` composes the real planning and assignment services behind bounded
operation admission and one owned control-plane database resource. Its only work surfaces are scoped
planning and assignment operations; database, integrity keys, planner reads/bindings and native
executors are not returned. Construction validates/copies configuration without SQL or opening a pool.
Failed synchronous construction leaves ownership with the caller. After success this lifecycle owns
closing the supplied resource exactly once; the caller must not keep using or close it independently.

Admission permits at most eight active operations and no wait queue. The supplied pool must already
implement bounded checkout/statements/transactions and termination, and must have passed the future
coordinator database role/schema preflight. This composition is not that preflight, a SQL sandbox, an
individual statement deadline, or proof that two wrapper objects represent different physical pools.
Production's existing single restricted-web bootstrap remains unchanged and cannot enable this block.

## Drain and uncertain saves

Close removes readiness and new admission immediately, then lets admitted operations drain for at most
30 seconds. It invalidates guarded query and precommit boundaries before closing the pool. Pool close
is called once and awaited for at most five seconds. Failure/stall or an expired drain reports fixed
uncertainty, never retries or falsely reports native cancellation. Late transaction callbacks cannot
issue more SQL or pass precommit through this wrapper. Already-sent COMMIT may have succeeded: the
caller retains the exact command and reconciles through existing canonical/planning uniqueness after
separate supervisor reconstruction. It must not create a new task in response to uncertainty.

Each transaction session is unusable after its callback returns. Successful completed operations do
not accumulate unresolved global shutdown subscribers. Underlying database termination remains the
supplied bounded pool's job; timeout reporting does not prove a physical connection or process stopped.
Tests can shorten, never extend, the admission/drain/cleanup ceilings.

## Combined application

`createPrivateTaskApplication` mounts these operations in a private web process with a separately
supplied restricted web resource. Scope mismatch, explicit operation overrides or the same client
object are refused before ownership transfer. Once coordinator construction succeeds, failed web
construction cleans both transferred resources. Readiness requires both pools and drops before close.
Shutdown starts web and coordinator drains together, awaits both outcomes, and preserves any cleanup
uncertainty. The web pool is never replaced by the coordinator pool and gains no privileges.

The private build exports an inert `taskApplication.js` factory. It does not install itself into the
ordinary bootstrap/compiled page-handler singleton, start a service, open a database, read credentials
or invoke a harness. Its real protected API composition is tested with supplied disposable resources.
Production role verification, bootstrap/supervisor mounting and compiled-page rendering through that
mount remain the next integration work, not enabled by this factory's existence.

## Acceptance and remaining work

Require actual SQL assignment/reconciliation and restricted-role web tests; bounded admission, normal
drain, stalled cleanup, precommit rollback, lost commit acknowledgement and late-callback tests;
independent review; registered regressions and separate private/Sites builds. Disposable PGlite and
injected close callbacks are not real PostgreSQL concurrency, socket termination or deployed evidence.

Continue on Astra Medium: production coordinator role/schema verification and bootstrap mounting,
then signed approval/local admission/dispatch and bounded revisions. No listener, provider/native
call, credential-store operation, deployment or merge is authorized by this block.
