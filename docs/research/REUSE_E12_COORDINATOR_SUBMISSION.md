# E12 — owned coordinator queue submission

2026-09-06, local source integration only.

The existing task coordinator lifecycle accepts an optional, already-prepared
NativeTaskSubmission port and exposes scoped `submission.enqueue` only when supplied.
Approval configuration is mandatory. The port method and caller identity are captured
before asynchronous admission. Enqueue uses the existing guarded canonical transaction,
admission limit, precommit checks, drain and uncertain-close handling.

The private application factory exposes the operation to trusted server composition,
not to the HTTP router. Saving approval alone still does not start work. Ordinary
construction without the optional port has the same operations as before.

Resource contract: bootstrap owns the prepared submission adapter; coordinator owns
its checked database lifecycle. Bootstrap must drain the coordinator before closing
the submission adapter. No new pool, package loading, listener or native dispatch is
created by this synchronous composition. Operational worker ownership remains E09/E11.

## Evidence

- 20 actual pg-boss submission/canonical delivery checks pass on PGlite. Default
  enqueue now goes through the owned coordinator; explicit fault-injection coordinator
  cases remain direct to preserve their transaction instrumentation.
- 28 lifecycle/startup checks pass. New cases prove snapshotting, admitted enqueue
  drain, rejection after close begins, and canonical intent/audit rollback on submission
  failure. Configuration rejects a submission port without approval preparation.
- Full TypeScript check and targeted ESLint pass; no dependency changes or downloads.

## Remaining work

PrivateTaskStartupConfiguration does not yet enable the queue. Its strict database
preflight still requires a reviewed queue-schema/coordinator-grant extension, real-PG
acceptance and explicit producer/worker lifecycle composition. A browser submit route
and current-authority worker routing also remain. Do not call the private app deployed
or the live agent path connected based on this server-side composition evidence.
