# CR14B private startup — independent initial review

Date: 2026-09-04. Mode: independent review under standing owner review authorization.
Reviewer: independent `cr13a_live290_review` agent; architect implemented the product and recorded this report.

- Immutable base: `39afa0f13c3309021e2a8cc2ee126cbdbd1bdb59`.
- Reviewed candidate: `007eeb1473504a1dab4394f8b2d1d0b045a8b1c9`.
- Candidate tree: `5511fac1c9e27918769992a8009c66ba05058347`.
- Initial disposition: **REJECTED: 0 High, 1 Medium, 0 Low**. Preserve this result after remediation.

## Medium — fast transaction uncertainty did not consistently quarantine the pool

At the reviewed candidate, `src/web/v1/bounded-database.ts:84` through its failure handler treated a fast
COMMIT rejection like an ordinary callback failure. Because `began` remained true, it could issue ROLLBACK
and leave the pool available, although `private-postgres.ts` reported the driver failure as outcome-uncertain.
A commit may already have completed. Rollback was not evidence that it had been undone, and continued pool
admission contradicted the contract. If ROLLBACK itself failed, the wrapper started closing in the background
but returned the original callback error rather than terminal uncertainty.

Required correction: fence COMMIT before issuing it, no ROLLBACK after that point, quarantine fast uncertainty
as well as deadlines, override failed rollback with terminal uncertainty, await bounded shared termination,
and add independent fast COMMIT/rollback/statement-failure regressions. Do not retry or infer rollback.

## Other observations

The reviewer found explicit import-inert/one-attempt startup, read-only role/schema/binding preflight,
constant-false lock support, irreversible session revocation, restricted role grants, bounded drain and
separate draft setup/rehearsal/pilot gates. Disabling prepared caching was correctly applied at both the
driver options and per-statement calls; the injected factory was trusted composition, not request input.

The reviewer passed 84/84 `test:cr14b` tests and 5/5 actual compiled private tests with `node --import tsx`.
An earlier optional compiled-test invocation omitted `--import tsx` and failed before tests on TypeScript
loader resolution; this was a reviewer invocation error, not product evidence. The working tree and cumulative
whitespace checks were clean. No source/Git writes, build, listener, real database connection, credential,
native/provider call or deployment was performed by the reviewer. Disposable/injected evidence is not live proof.

Follow-up disposition belongs in `CR14B_PRIVATE_STARTUP_REREVIEW.md`; this initial rejection is not erased.
