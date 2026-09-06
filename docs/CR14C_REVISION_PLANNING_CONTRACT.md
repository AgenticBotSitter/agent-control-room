# Bounded revised-execution planning

Root contract, 2026-09-05. Base `0e46c2a42282a50cee046bfa50e60cd9169f00b0`, PR #332.
The full revision journey remains the objective. This first implementation creates its
real durable execution bundle; returned revised bytes/review and browser commands are
subsequent connections, not implied by a successful planning response.

## Identity and immutable evidence

Keep every existing revision-zero/v1 plan and receipt unchanged. Add a strict v2
execution-plan variant to the existing append-only `control_task_execution_plans`:
its source job is the previous native execution, not the original inert proposal.
The existing tenant/source-job uniqueness serializes one successor plan; its child
request/workflow/job remain distinct deterministic proposed records. No schema or
role changes are needed. Use a separate v2 HMAC purpose.

The v2 revision context retains the original logical review subject and root target,
predecessor job/run/target/content identities, exact owner change review and finding
identities/digests, next revision number, original task prompt and source-plan digest.
Actual producer/run/artifact identities are never reassigned to the original job.

## Planning operation

`TaskExecutionPlanner.revise(identity, projectId, sourceJobId, request, signal)`;
request is strict `{runId,targetId,targetDigest,contentHash,reviewId,feedback}`.
All IDs/digests use existing bounds. Feedback follows the existing nonempty bounded
change-request text contract. Capture request/identity synchronously before admission.

Require current owner `tasks.plan`, `tasks.read`, `tasks.results.read` and
`tasks.reviews.record` permission for the project. Use current session/grant locks,
locked project scope and native run/job locks. Verify the prior immutable execution
plan, actual saved native result/binding/profile/bytes and Completion Gate snapshot.
The requested review must be this owner's exact Completion Gate change request for
that target and profile. Supplied feedback must hash to its finding statement.
For this supported owner-feedback path, require the complete current finding set to
match that review's finding IDs; do not silently discard other review findings.

A new plan requires an active project, current `changes_requested` target below its
profile's revision limit, matching fixed template/profile, and a still leased/running
predecessor job. The new template's authority must be current; never inherit a prior
approval, lease or native idempotency key. Existing exact historical replay remains
non-executing and must preserve one child bundle/audit after a lost acknowledgement.

Construct the next bounded native prompt from the original task, actual preceding
result text and exact verified feedback as labeled JSON data. Preserve the fixed
server instructions. Enforce the existing 4,000-character native prompt bound on the
complete representation; reject oversize instead of dropping findings or truncating
the document. Native tools and artifact references are not invented as a fallback.

Use one owner-authorized transaction for the proposed child request/workflow/job,
immutable v2 plan and sanitized audit. Do not alter the predecessor, its lease,
Completion Gate, checkpoints or native state. Signal/currentness and a ten-second
monotonic budget fence the operation and precommit; no provider or automatic retry.

## Explicit integration limit

Expose optional internal `revisions.plan` only when trusted startup explicitly sets
`revisionPlanning:true` alongside the existing checked quality/result configuration.
Absent configuration exposes no new capability. Verified two-role startup and bounded
coordinator admission/drain own it; no new browser, HTTP, MCP or node command.

Until revised-result submission is implemented and accepted, existing executable
planner readers and `bindReview` reject v2 plans rather than treating them as ordinary
revision-zero tasks. Receipts say `startsWork:false`, `grantsExecutionAuthority:false`
and `executionAvailability:'revision_submission_not_connected'`. Planning is useful
durable progress, not revision execution acceptance or permission to launch a task.
The next block must replace this explicit boundary with the verified same-subject
revision/result path before activating execution. Parent workflow/request outcomes,
reservation turnover, browser presentation and live runtime still require integration.

## Proof and delegation

Root owns contract, implementation and final integration. Isolated agents author
restricted-role backend and compiled-startup regressions; independent review examines
the frozen change. Preserve all initial-plan and completion tests, no reduced checks.
Prove real proposed children, exact source/result/feedback lineage, concurrent and
lost-reply replay, unchanged old job/lease/checkpoints/native effect count, malformed
or stale input refusal, missing bytes, scope/owner/expiry/cancel/drain failures and
v2 execution-reader refusal. Synthetic fixture execution is not live Hermes proof.
No new grants, migration, installation, credential use, provider/native calls,
listener, services, deployment, merge or acceptance of excluded draft PR #329.
