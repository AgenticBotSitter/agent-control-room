# Revised native execution: verified implementation inventory

2026-09-05, source head `df2395f4e0e0c5cb3ddea8a13b21e24ac2f9db5e`.
Read-only agent inventory, with root checking the key submission/planner/store/reader
constraints. This is preparation for the next block, not a new normative design,
implemented revision route, migration approval or live-effect authorization. PR #329
is excluded from this source and from this inventory.

## Why a second ordinary job is not yet a revision

| Existing connection | Verified constraint |
| --- | --- |
| `NativeResultSubmissionService.inspectSubmitted` / `submit` | Reconstruct an exact target whose subject is the executing job, root is the native plan target, and revision number is zero. |
| `NativeResultSubmissionService.register` | Derives the target from tenant/job; only exact replay of the immutable prior job plan is accepted; an existing subject target prevents new registration. |
| Completion Gate `registerTarget` / `recordRevision` | Initial registration is revision zero. A revision keeps the same subject, root, kind and acceptance profile; it changes the exact result, increments within the limit, resolves the prior findings and has one successor. |
| Migration 0044 | Native review plan primary key is tenant/run, unique tenant/job; records are append-only. |
| `TaskExecutionPlanner.plan`, migration 0045 | One immutable execution plan per source proposal, one deterministic child request/workflow/job bundle. Replanning the source reconciles that bundle, not a new revision. |
| `TaskExecutionPlanner.bindReview` | Binds review to the planned child's actual native job, project and input digest. |
| `WebTaskService.results` | Reads artifacts for the requested job and review history for that same subject. It does not join a logical original task to different execution jobs. |
| Owner review / verification services | Require the target's subject to equal the requested job ID. |

Actual result receipts/manifests remain bound to their producing job, attempt, run,
node and workflow. Reassigning those receipts to an old job would break evidence;
merely changing the new target's subject would fail current readback and review checks.

## Root decisions the next block must settle

1. Define an explicit durable logical-task/revision/execution relationship while
   preserving the unchanged revision-zero path and actual producer identities.
2. Define one revision plan per exact predecessor/change request, concurrent replay
   behavior, revision limits and immutable feedback/input/profile binding.
3. Define how the old execution, reservation and new execution relate without false
   success, replaying an uncertain native attempt or inheriting old execution approval.
4. Connect returned bytes to the next same-subject target through staged checkpoint
   publication and fresh review/verification, not inherited acceptance.
5. Adapt protected file/history/review reads to the verified relationship without
   broadening cross-project access or guessing relationships from content hashes.
6. Define parent workflow/request outcomes explicitly. The separate pending upstream
   completion draft must not be treated as accepted or assumed to support revisions.

These are implementation acceptance questions, not questions the owner must solve as
a software engineer. Root owns the contract; workers may implement bounded settled
parts and independent tests after that contract is frozen.

## Regression sets to preserve and extend

- `native-result-submission.test.ts`: exact job-subject identity, concurrent durable
  replay, unavailable/tampered plan/profile/time/bytes refusal.
- `task-execution-planner.test.ts`: immutable source, distinct child, single concurrent
  plan/bundle/audit, lost-response reconciliation and bound child review.
- `native-task-lifecycle-integration.test.ts`: actual native run/result/read/review linkage.
- `completion-gate-contract.test.ts`: same-subject bounded lineage, findings, immutable
  history, supersession and exact replay.
- `native-quality-completion.test.ts`: a replaced initial target cannot complete the job.
- `web-task-result-browser.test.tsx`: truthful recorded revision display, including
  omitted history, without inventing a received replacement file/run.
- Coordinator quality sweep tests: exact validation, scope, interruption, replay and
  completion exclusion must survive the addition of a distinct revision path.
