# CR14C — verified task startup acceptance

Date: 2026-09-05. Independently accepted repository/disposable integration; not deployed.

Product commit: `147dfc5fb0e93cb4c230c59161ebd0919371a776`.
Product tree: `79af63730e9b3204f623e53e4fc331a60a407023`.
Base: `f84f22b251ac3f1e0a29588e342191386f1edf66` / PR #298.
Contract: `CR14C_VERIFIED_TASK_STARTUP_CONTRACT.md`.

## Delivered

Explicit one-attempt startup now independently verifies a restricted web pool and task-coordinator
pool against the same private PG17 database before mounting their combined application into the
compiled runtime. The actual built application saves a proposal, prepares it, assigns it, renders its
task page and revokes access on logout in disposable tests. Assignment still does not start an agent.

Configuration snapshots precede opening, duplicate supplied resources are refused, acquired resources
close once on failure, stalled/failed cleanup remains uncertain, and readiness depends on both pools.
The original single-web bootstrap remains separate. No migration, privilege widening or live effect.

## Independent review

Reviewer `cr14c_startup_review` inspected the exact immutable product/base and reported no actionable
findings. It independently ran `web-task-startup`, `web-startup`, `task-coordinator-lifecycle` and
`web-coordinator-database`: **44 passed**, zero failures/skips, exit 0. It inspected compiled-test source
and build entry changes but did not build artifacts. Final acceptance/integration remains with Codex.

## Observed verification

- Stage-zero dependency preparation check: ready; native readiness/attempt not run.
- TypeScript, full ESLint and changed-file final ESLint: pass. Whitespace check: pass.
- Focused CR14C: final **262 passed**; earlier run before three additional edge-case tests: 259 passed.
- Full registered lifecycle: pretest **769 passed**; main **839 passed**, two existing platform skips
  (841 total); posttest **392 passed**. Main included all 12 new startup tests.
- Private Node build: pass. All **16 compiled artifact tests passed**, including two new startup checks.
- Separate Sites build: pass. All **four rendered route checks passed**.
- Disposable migration verification: 0001–0046, **132 tables**; schema/roles unchanged by this block.

All commands used installed direct Node tools, without installs or downloads. The compiled startup
fixture uses actual restricted LOGIN identities in serialized transactions on one disposable PGlite
backend. Only its known database TEMP metadata limitation is injected. This is not evidence of real
PostgreSQL connections, cross-session concurrency, database ACL setup, socket cancellation or deployment.

The first compiled-test draft was corrected to use the existing command-key header, `/plan` endpoint
and `expectedInputDigest` body before execution; no product API was changed to accommodate the test.
No failed runtime/native attempt occurred. Provider calls, credentials, listeners and live SQL: zero.

## Remaining

Signed owner approval, local admission/dispatch and bounded revision submission remain CR14C work.
Real database setup and first live pilot await separately scoped authority. Continue on Astra Medium.
Publication is not a merge or live startup; current-head CI and dependency-order integration remain required.
