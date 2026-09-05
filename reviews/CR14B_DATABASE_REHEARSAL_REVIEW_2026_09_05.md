# CR14B database rehearsal — initial independent review

Date: 2026-09-05. Independent reviewer: `cr13a_live290_review` (read-only subagent).
Disposition: **REJECTED — 0 High, 1 Medium, 2 Low.** Preserve this result after correction.

- Base: `e327c3c7be75ef9489316e2f9fb561ada5929764`.
- Reviewed commit: `8070faed08baa425ca88a3d2136b8dbfa22717da`.
- Tree: `704b1f8ec6887d555da3549b668e9a73d85b8bdb`.
- Scope: the 11-path rehearsal diff: fixed operator workload, native probe, packet/deadline/cleanup/evidence,
  separate VPS entry, tests and contract. No broader runtime acceptance or live qualification.

## Findings

1. **Medium — idle close does not establish timeout cause.**
   `src/web/v1/private-rehearsal-checks.ts:89-94` labels a 5.5s wait, closed client and absent backend as
   `idle_transaction_timeout`. postgres.js discards an idle ErrorResponse when no query is active. An unrelated
   disconnect can therefore satisfy the check. Narrow it to observed idle-session absence, explicitly leave
   cause unavailable, and require an intermediate still-open observation. The architect independently noticed
   this limitation and supplied it to the reviewer; review confirmed it as blocking evidence overstatement.
2. **Low — resource-creation counts are not physical attempts.**
   `src/web/v1/private-database-rehearsal.ts:49,115-118` counts owned client wrappers. Initial target-session
   selection in postgres.js can revisit an unsuitable endpoint. The contract qualified closed counts but not
   created counts. Explicitly state physical connection attempts are unobserved and not represented by these
   counters; do not equate one reservation with one physical connection attempt.
3. **Low — the signal fixture can be missing or stale.**
   `src/web/v1/private-database-rehearsal.ts:182-188` requires an enrollment and configured telemetry but not
   an actual current signal. Require one current signal and zero missing/stale signals to satisfy the fixture
   contract. A configured source alone is not evidence of a usable signal.

## Observed review checks and limits

- Exact HEAD/tree/base and changed paths verified; checkout was clean during initial review.
- `node --import tsx --test tests/web-database-rehearsal.test.ts tests/web-rehearsal-probe.test.ts`: 16/16 passed.
- `git diff --check`: passed.
- Inspected installed postgres.js reservation, idle error/close and target-session selection behavior.
- Early-stop cleanup: owned closes are individually bounded and all-settled; no separate finding for this
  unmounted fixed workload. This does not establish physical socket/backend absence.
- Reviewer made no edits, Git mutations, installs, builds, browser actions or native effects. No database,
  listener, provider, credential, host integration or deployment was attempted.

Passing the existing tests did not close the three findings. A later immutable correction needs re-review.
