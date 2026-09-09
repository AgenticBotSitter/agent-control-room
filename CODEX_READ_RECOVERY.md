# Exact-ID Codex read recovery

Status: bounded response projection, one-shot JSONL profile and owned connection lifecycle implemented; native transport, trusted admission,
runtime reconciliation and host qualification are not implemented or accepted.

`owned-read.ts` now composes the profile with a caller-owned connection attempt.
It reuses the owned-signing acquisition pattern: synchronous ownership before
readiness, one attempt, total operation deadline, cancellation and a separate
bounded cleanup wait. It rechecks the caller's synchronous admission callback
around waits and after cleanup. Failed or unfinished cleanup withholds the result.
No default native connection, endpoint, credentials or authority implementation
is supplied. The connector contract requires closing eventual readiness and I/O;
fake close callbacks cannot prove that a physical connection met that contract.

Official interface checked 2026-09-09:
[App Server stored thread read](https://learn.chatgpt.com/docs/app-server).
`thread/read` with `includeTurns: true` reads stored turns without resuming or
subscribing. It is distinct from resuming a thread and starting a new turn.
Version-specific protocol compatibility must still be pinned at qualification.

`src/harness/codex-v1/read-recovery.ts` creates a fixed read request for a previously
known thread and projects only its exact known turn status. It rejects foreign
thread IDs, duplicate turn IDs, missing turns, unrecognized statuses and oversized
responses. Absent exact turns remain `not_observed`, not failed or completed.
Transcript items, paths and token metadata are not returned. Usage remains unknown;
a stored completed status is not verified completion or verified cleanup.

This is the Control Room-specific identity/minimization adapter. The separate
`read-jsonl.ts` profile adapts the existing Control Room JSONL correlation pattern
with fixed initialization and a single thread/read request. It exposes no generic
request method, rejects server requests, correlates IDs, bounds frames/ignored
notifications and becomes unusable after an error or disconnect. It is not a
socket, process launcher or full JSON-RPC library. The narrower profile avoids
exporting qualification/broker authority just to inspect stored state. Reuse the
evaluated bounded transport when composing it. Do not widen the existing qualification
controller's method allowlist or use its resume operation for this purpose.

Remaining integration:

- Bind tenant/project/node/run and existing thread/turn IDs to current authenticated
  admission before acquiring a connection; unknown identity cannot use list/search
  to guess its way into another task.
- Pin supported app-server version and a separate initialized read-only session;
  enforce request-ID correlation, frame limits, cancellation and connection cleanup.
- Feed only the correlated result value to the projection, never arbitrary server
  notifications or an uncorrelated caller-supplied snapshot.
- Reconcile with canonical durable events/results without inventing missing usage,
  replaying execution, releasing capacity or claiming completion from this snapshot.
- Qualify disconnect, server restart, lost read acknowledgement and duplicate read
  using disposable data under explicit host scope. No automated native retry is
  authorized by this module.

Independent re-review of `798b38a` confirmed the reentrant cancellation correction
and passed all 10 then-current recovery checks. A subsequent lifecycle regression
adds scripted disconnect/lost acknowledgement, unexpected restart response ID and
duplicate initialization acknowledgement: each closes its one owned attempt,
returns no observation and refuses reuse. These are protocol simulations, not an
actual server restart or physical connection retirement. The focused suite now
passes 11 tests.

Run `pnpm test:codex-recovery` for the effect-free
projection and protocol checks. No credentials, native app-server process or provider call is
used by those tests. A separate owner-attended qualification stays separate.
