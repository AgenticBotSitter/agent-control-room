# Build status

**As of 2026-09-28**, describing `main` at commit `28279049`. The most recent completed CI
run on `main` before this was written is green; a run at that exact commit had not finished
when this file was last updated.

This file is the short, current answer. The long decision history it replaces is kept in
[CR3 decision log](CR3_DECISION_LOG.md), the
[final security contract](CR5C_FINAL_SECURITY_CONTRACT.md), and the
[macOS-to-multi-computer plan](LOCAL_TO_MULTI_SYSTEM_EXECUTION_PLAN.md). Read this file
first, and treat it as wrong if it claims more than its own evidence supports.

One vocabulary note, used throughout: **exercised** means an automated journey drives the
real production composition against a disposable PostgreSQL cluster and fake worker
executables. **Owner-accepted** means a person ran it on their own machine and agreed it
works. The two are not interchangeable, and nothing in this repository turns the first
into the second.

## What works

- **The Mac-local owner application.** One project → task → result → review → revision
  lifecycle over one PostgreSQL authority database, served to the owner's browser. It is
  exercised end to end in CI. `ci: Server build tests`.
- **Three local agent harnesses in one lifecycle.** A bounded local route for each of the
  three supported agent CLIs composes into a single restricted task lifecycle with one
  shared receipt, result and review path. `test: tests/mac-local-restricted-three-agent-task-composition.test.ts::composes Hermes, Claude, and managed Codex into one restricted task lifecycle`.
- **Owner review, verification and linked revisions.** Review is the owner's decision; a
  result can be verified, revised and re-reviewed while other work continues.
  `ci: Full Mac-local rehearsal`.
- **A read-only Session Watch.** A route showing running, stalled and blocked sessions with
  honest unavailable fields. It is read-only by construction: the browser read is GET-only,
  emits no command body, and the service issues no update or delete. `test: tests/session-watch.test.tsx::session watch browser read is GET-only and exposes no command body`.
- **Phone-width and accessibility work on the main branch.** The owner-page stylesheets are
  guarded against the common narrow-viewport overflow: the metric grid uses
  `minmax(0, 1fr)` tracks, collapses to one column below 620px, and the interpolated metric
  caption is allowed to break at any character rather than forcing page-wide horizontal
  scroll at 360px. This is a property of the shipped stylesheets, asserted by test — not a
  walk of live routes at phone width, which is still in flight. `test: tests/mac-local-accessibility.test.tsx::the interpolated metric caption can wrap instead of overflowing a 360px viewport`, `ci: Component lanes`.
- **An isolated coding-worktree library, deliberately not wired in.** The primitives,
  bounded diff evidence and owner-only rendering are merged and tested, but the owner
  composition has no approved project-to-repository mapping or recorded base revision, so
  no owner task can call it. Its presence is not a coding workflow.
  `test: tests/agent-coding-worktrees.test.ts::terminal cleanup removes a clean evidence-bound worktree`.

### CI gates

The repository's active ruleset requires one check, **Full suite (merge gate)**, which in
turn depends on every lane below, so all of them gate a pull request.

- **PR evidence claims** — a `src/**` or `db/**` change must carry a `## Evidence`
  section whose every claim resolves to a real test name, CI job, or command output. Doc-only
  changes are exempt. `docs/PR_CLAIMS_EVIDENCE.md`, `test: tests/check-pr-claims.test.mjs`.
- **New migration safety** — shipped migrations are immutable; new ones are linted.
  `test: tests/migration-change-check.test.mjs`.
- **Test hygiene and quarantine** — a quarantine entry needs an issue, an owner, and a
  14-day expiry. **The quarantine is currently empty**, so no test is presently exempt
  from the merge gate. `docs/FLAKY_TESTS.md`, `test: tests/test-quarantine.test.mjs`.
- **Test-lane coverage** — no test file may be unreachable from CI. `cmd: node scripts/check-test-lane-coverage.mjs` →
  *all 515 test files are reachable from GitHub Actions*.
- **Private-name rejection** — the check rejects configured private terms from the tree. It
  is wired to a repository secret, so with no list configured it reports
  *private-name check skipped* and passes rather than rejecting anything.
  `test: tests/private-name-guard.test.mjs`, `cmd: node scripts/check-private-names.mjs`.
- **Full Mac-local rehearsal** and **Owner browser journey** — real disposable
  PostgreSQL 17, the built production application, and a real browser.
- **A shared attack-test kit** (`tests/support/attack-kit/`) supplies real-PostgreSQL,
  concurrency, isolation, and guard-mutation harnesses instead of hand-rolled ones.
  `cmd: pnpm run test:attack-kit`, `ci: Component lanes`.
- **Database privilege probes in the rehearsal lane.** The full Mac-local rehearsal now
  runs the PG17 negative privilege probes against the real cluster, and the lane fails if
  any of them reports a skip — so a probe that silently stops proving a refusal fails the
  build. `ci: Full Mac-local rehearsal`.

## In flight

Grouped by area. Numbers are pull requests. Every row is open and unmerged at the commit
above, except the last, which is called out.

| Area | What is being built | PRs |
| --- | --- | --- |
| Self-hosting pipeline | Proposal-only intake through authenticated unattended advance, as a seven-slice stack | #378, #383, #387, #388, #389, #392, #396 |
| Phase 1 hardening | Recoverable, observable task host; per-run CPU and memory limits; ownership leases and disjoint scope; activity timeline and lifecycle events | #391, #410, #411, #403, #409 |
| Owner surfaces | Universal Action Inbox; truthful usage and cost; public roadmap; pre-assignment recommendation | #406, #412, #364, #326 |
| Per-task evidence | Complete model-choice evidence | #408 |
| Reliability | Disposable-cluster leak in the Mac-local journey lane; deflake owner browser review readiness; affected-test preconditions; declared guard-mutation CI check; multi-client load harness | #431, #422, #418, #416, #426 |
| Recovery and hand-off | Structured blocker recovery and hand-off (draft) | #415 |
| Phone width at route level | Ten owner routes walked at phone width plus an origin-refusal guard. **Closed, not on `main`:** #404 was merged into the `hermes/demo-look` feature branch, and its browser spec is not in `main`. Reopening this against `main` is outstanding | #404 |

The merged [multi-agent pipeline design](MULTI_AGENT_PIPELINES_DESIGN.md) is the
specification these slices implement. All of it is source and disposable-test evidence:
none of it makes a supported release. See the
[support matrix](SUPPORT_MATRIX.md) for the per-environment boundary.

## Open risks

1. **Disposable database clusters leak and can exhaust machine-wide shared memory.** The
   test lanes start real PostgreSQL 17 clusters. This machine has a small, fixed ceiling on
   shared-memory segments, and a cluster whose data directory lives outside the worktree is
   invisible to the cleanup helpers, so one interrupted run can starve every other job. The
   journey lane is being fixed; until it lands, treat a failed or cancelled lane as possible
   leftover state. `cmd: ipcs -m` lists the live segments. The reaper is
   `scripts/dev/cleanup-test-postgres.mjs`, documented in
   [backup and restore](BACKUP_AND_RESTORE.md). Open pull request #431 adds a teardown that
   stops the postmaster, proves it is gone, then removes the directory — on the exit path
   and on SIGINT/SIGTERM.
2. **Rehearsal and browser-journey tests are still being de-flaked.** They depend on timing,
   load, and a real database and browser, so they fail intermittently under parallel load. A
   targeted browser fix and a journey-lane fix are open. Nothing is currently quarantined, so
   these failures are real merge blockers today. Open pull request #422 adds a focused guard
   for the owner-review readiness race. `docs/FLAKY_TESTS.md`.
3. **The review backlog is the critical path.** Twenty-five pull requests are open, two of
   them drafts, and five issues sit in review. The self-hosting stack is seven slices deep,
   each chained to the one before it. That is a lot of merge-order coupling on one critical
   path, and it needs a deliberate batch-merge decision or re-sequencing before it can move.
   The slice that adds authenticated unattended advance is the one that most needs an
   independent security reviewer, and it is last in the chain.
4. **Installed worker processes are not owner-qualified.** Every local adapter is
   source-backed and exercised with fake executables. No installed agent process has been
   qualified on a real machine, so no agent is enabled by anything in this file.
   `docs/SUPPORT_MATRIX.md`.
5. **There is no supported release.** No downloadable release, no owner-accepted
   installation, and the owner guide is still a draft. `cmd: node scripts/check-readme-status.mjs`
   keeps the public README's claims honest.

## Next

1. **Land the review backlog.** Merge the open pull requests in dependency order: the
   reliability fixes that unblock the shared Mac first, then Phase 1 hardening, then the
   stack. Re-sequence the seven-deep stack before it goes further.
2. **The self-hosting pipeline, slices S1 to S7.** Proposal-only intake, owner review of
   proposed batches, exact queue admission gates, inert linear runs, guarded agent checker
   reviews, retained build-workspace publication, and authenticated unattended advance. The
   design is merged; the slices are not.
   `docs/MULTI_AGENT_PIPELINES_DESIGN.md`.
3. **Overnight runs where agents open pull requests and a human merges.** The lower-risk
   end of the unattended spectrum: no automatic merge and no agent self-approval, so an
   overnight run produces reviewable pull requests rather than unreviewed writes. The choice
   between that and a more autonomous relay is still the owner's.
   `docs/BUILD_RELAY_PLAN.md`.
