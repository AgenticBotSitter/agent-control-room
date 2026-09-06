# Owner-requested revision planning: acceptance

2026-09-05. Reviewed production `0ced7d12232faec639761149bde69dfc86d013d3`;
integrated tests `3eb546d`. Base PR #332. Contract:
`CR14C_REVISION_PLANNING_CONTRACT.md`. Excluded draft PR #329 remains unaccepted.

## Delivered and connected

An owner can now create one durable follow-up execution plan from their exact recorded
change request. It verifies the original native result and actual bytes, original
execution plan, current project/session/permissions, review and complete finding set.
The separate proposed request/workflow/job preserves the original logical review
subject, exact predecessor/result identities, original task and requested changes.
A distinct signed v2 plan protects this relationship without changing v1 records,
database grants or schema. Complete-context prompts exceeding the existing native
bound are rejected, not silently truncated.

The operation is optionally mounted through the verified two-role startup and bounded
coordinator lifecycle as internal `revisions.plan`. It is not exposed to browsers or
HTTP. Concurrent calls, restarts and lost acknowledgements reconcile one proposed
bundle and audit. Original jobs, reservations, result evidence and checkpoints remain
unchanged. Existing executable readers explicitly refuse v2 plans until revised-result
submission is connected; planning never grants execution authority or starts an agent.

This is durable planning acceptance, not completion of the full revision journey.
Returned revised bytes, same-subject review targets, fresh quality checks, protected
read/review mapping, reservation turnover and runtime/browser activation remain.

## Independent work and correction

Root owned the contract and implementation. Two isolated agents authored restricted-role
backend tests and compiled-startup integration tests. An independent reviewer found a
post-commit acknowledgement gap: cancellation or a budget overrun after the actual
commit could still return success. Root added a final currentness fence after the
await. The reviewer independently reproduced both corrected cases: rejection retains
one durable proposed plan, and a later exact request returns that same plan as replay.
No remaining actionable production findings were reported at the corrected commit.

The independent final evidence review at `3eb546d` also found no actionable findings:
the corrected regressions would fail before the fix, old test files and command order
are preserved, and the two new files are registered exactly once in their suites.
Concurrent-call evidence uses serialized disposable PGlite; it does not establish live
multi-connection PostgreSQL contention behavior. That reviewer did not rerun root's
broader suites.

The final backend regression explicitly distinguishes committed-but-unacknowledged
work from rollback. It checks unchanged old evidence and one durable child/audit before
and after replay. The compiled agent corrected one fixture query from nonexistent
`id` to the actual plan table's `job_id`; no production fix or reduced assertion was
used for that fixture correction.

## Verification

- Agent-authored restricted-role regressions: 20 passed at the corrected production.
- Root integrated those tests and passed them with all eight CI inventory/runner
  regressions: 28 passed, zero failures/skips/cancellations.
- Existing planner, coordinator lifecycle and quality startup: 39 passed.
- Both application builds passed. All compiled private tests: 22 passed; rendered
  tests: four passed.
- Disposable migrations 0001–0054 passed, still 138 tables.
- Final integrated TypeScript, full ESLint and diff checks passed.
- All six actual default lanes passed at the final product/test inventory: 2,458 passed,
  two existing platform skips, zero failures/cancellations. The 266-file inventory has
  71 preparation files, 36 in each main lane and 51 post files. Two lanes ran concurrently
  on this Mac, one test file at a time within each lane.

| Lane | Passed | Existing skips | Local duration |
| --- | ---: | ---: | ---: |
| pre | 770 | 0 | 91.80 s |
| main-1 | 249 | 0 | 111.81 s |
| main-2 | 353 | 1 | 128.23 s |
| main-3 | 340 | 1 | 202.01 s |
| main-4 | 354 | 0 | 171.86 s |
| post | 392 | 0 | 63.50 s |

These are real restricted SQL, canonical stores, verified review/result evidence and
compiled HTTP owner-review tests with synthetic native transport. They are not a live
Hermes execution, physical PostgreSQL rehearsal or owner-attended browser test. No
provider call, credentials, installation, listener, service or deployment was used.

Prerequisite PR #332 head `0e46c2a` passed all jobs, including the final aggregate gate,
in GitHub run `34007915844`. Current-branch CI and dependency-order integration remain
required. No merge or deployment is claimed.

## Next block

Connect revised native-result registration/submission to the same logical review
subject while retaining the real producing job/run/artifact identity. Preserve exact
findings, profile limits, staged checkpoints and fresh review. Keep executable v2
readers disabled until that connection is accepted; then integrate the dependent
assignment/approval/read/review/quality paths as a coherent revision journey.
The current private-web role cannot read `control_native_review_plans` or
`control_task_execution_plans`; a web-facing lineage resolver must not assume those
privileges exist. Root must explicitly settle the authenticated read relationship and
corresponding role/preflight changes before implementing it. Existing automatic
verification and completion consume `inspectSubmitted`; its exact target reconstruction
is the central connection, not permission to loosen subject checks independently.
Root remains Astra Medium; bounded testing and independent review retain the assigned
agent settings. No owner action is required for this repository work. Native calls,
host/database setup, deployment and merges still require their scoped authority.
