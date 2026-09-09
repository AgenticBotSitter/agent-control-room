# Exact-ID Codex read recovery

Status: bounded response projection implemented; transport, trusted admission,
runtime reconciliation and host qualification are not implemented or accepted.

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

This is the Control Room-specific identity/minimization adapter, not a replacement
JSON-RPC implementation. Reuse the evaluated bounded transport when exporting and
composing its separate read-only profile. Do not widen the existing qualification
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

Run `node --import tsx --test tests/codex-read-recovery.test.ts` for the effect-free
projection checks. No credentials, native app-server process or provider call is
used by those tests. A separate owner-attended qualification stays separate.
