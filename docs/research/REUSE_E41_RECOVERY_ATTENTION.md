# E41 — owner recovery attention summary

2026-09-06. Local implementation; no listeners, provider calls or deployment.

The private navigation now links to /needs-me. Its first section reads current-process
recovery observations through GET /api/v1/needs-me. Trusted task composition supplies
the read-only source only when native queue recovery is configured. It is not accepted
as a caller-injected web override. Tenant/workspace scope is validated and the source
method is captured before serving requests.

The existing connection inventory authority is reused: current authenticated session,
tenant-wide owner connections.read grant, and transaction freshness checks. The source
is read inside that authorization transaction. Missing configuration returns unavailable,
not an empty queue. Queries and writes are rejected; responses are no-store. No retry,
recovery, dispatch, provider, key or SQL capability reaches the browser.

The session manager aggregates at most 32 configured nodes without disclosing their raw
identities. It reports held-item counts, limited discovery checks, uncertain checks,
running/not-attempted/unavailable observations. Closed sessions no longer contribute
their prior completion counts. This is deliberately labeled a process-local snapshot:
reconnect/restart can replace observations, zero is not an all-clear, and held is not
necessarily failed. Canonical task-specific attention remains unfinished.

The client uses an explicit GET with same-origin credentials, no cache/redirect, a
10-second overall deadline and 4 KiB response limit. Strict parsing rejects extra
fields, inconsistent totals and authority claims. Refresh hides the preceding snapshot;
errors do not retain a stale all-clear. The page offers project navigation, not retries.

Verification: initial 19 combined session/connection/attention checks pass; the expanded
attention/private-process suite passes 10 checks. Additional held/limited/closed-session
coverage runs separately. All three source AND compiled full-host task journeys pass
with the new endpoint reading the actual composed session manager. VPS build and all
35 compiled regressions pass. TypeScript and targeted lint pass after fixing an initial
React synchronous-effect state-update lint error. New web attention tests are added to
the existing posttest command. No dependencies downloaded or lockfile changed.

No interactive browser clicking or live agent evidence is claimed. Next inbox work:
durable authorized task-level review/approval/uncertain items with direct project/task
links and pagination; do not relabel this aggregate as the complete Needs Me product.
The broader first-live-task, fleet, Idea Lab, ABS and daily-operation milestones remain.
