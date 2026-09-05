# CR14B database rehearsal — independent remediation re-review

Date: 2026-09-05. Independent reviewer: `cr13a_live290_review` (read-only subagent).
Disposition: **ACCEPTED — 0 High, 0 Medium, 0 Low remaining.**

- Accepted commit: `7c52ad3ea88255a9ec6faccadea69eb9af66162d`.
- Accepted tree: `7de613ba8be83ffea3292012bdda8e1e2fce3710`.
- Rejected parent: `8070faed08baa425ca88a3d2136b8dbfa22717da`.
- Cumulative base: `e327c3c7be75ef9489316e2f9fb561ada5929764`.

## Finding closure

1. The original B session is observed open and idle in transaction at 4.5s, then absent within a bounded
   5–7.5s interval. The check is only `idle_session_absence`; `idleTimeoutCause` is fixed to
   `unavailable_from_driver`. An unrelated disconnect in the interval remains explicitly indistinguishable.
2. `physicalConnectionAttempts` is fixed to `not_observed`. The contract distinguishes wrapper creation,
   client shutdown, logical reservation, initial driver target-selection revisits and actual backend absence.
3. The fixture now requires one current signal, zero missing/stale signals, one enrollment and no live-panel
   claim. The missing-signal regression stops before probe creation. The premature idle-close regression
   cannot record an idle-session observation.

Adjacent regression review found no new issue. The initial rejection remains preserved unchanged.

## Observed verification

- Exact commit/tree/parent verified; clean checkout.
- `node --import tsx --test tests/web-database-rehearsal.test.ts tests/web-rehearsal-probe.test.ts`: 18/18 passed.
- Cumulative `git diff --check`: passed.
- No reviewer edits, Git writes, builds, network, database connections, listeners, provider calls, credentials,
  native effects or deployment.

Acceptance is limited to the bounded implementation and evidence contract. It does not qualify real PostgreSQL
behavior, physical connection/session counts, operator cleanup, private-beta readiness or deployment.
