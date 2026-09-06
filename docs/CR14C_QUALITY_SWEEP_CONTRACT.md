# Saved-result quality reconciliation sweep

Root contract, 2026-09-05. Base `87d84d81fee554181a07d5a362c3c1376663800e`
(PR #331, using PR #330's amended CI). PR #329's pending product is excluded.

## Product connection

Extend the existing optional trusted coordinator quality operation with
`sweep({projectId, afterRunId?}, AbortSignal)`. It discovers saved native results
and invokes the accepted exact-result quality reconciliation. No caller supplies
target digests or guesses which run is ready. The same verified two-pool bootstrap
must expose this operation. It remains internal, never a browser/node/MCP command.

This is one explicit reconciliation tick, not an automatically started daemon, new
queue, durable event acknowledgement, native dispatch or production activation.
Runtime scheduling of ticks remains separate. Owner reviews, structural checks and
canonical native job completion retain their existing meanings and permissions.

## Fixed execution contract

- Strict request: project ID and optional exclusive run-ID cursor only. Capture it
  synchronously before lifecycle admission, as with existing exact reconciliation.
- Bound tenant/workspace come from immutable coordinator scope. Verify project scope
  in a transaction, then select at most six candidate run/job pairs in C-collated
  run-ID order, after the supplied cursor. Candidate rows must join native run,
  canonical job, immutable native review plan and stored artifact receipt with exact
  tenant/project/job/run equality. Runs are succeeded; jobs are leased/running.
- Process at most five candidates sequentially. Return the last processed run ID
  as `nextRunId` only when a sixth candidate was observed; otherwise return null.
  Callers must wrap to the start on a later cycle so earlier IDs/new reviews can be
  revisited. This is traversal, not exactly-once event consumption or a saved cursor.
- Candidate indexes are hints, not trusted result or acceptance evidence. For each,
  use `NativeResultSubmissionService.inspectSubmitted` to verify its real binding,
  profile, target and bounded stored bytes. Derive the exact quality request from
  that context and call the existing coordinator reconciliation, which revalidates it.
- Reuse the current ten-second monotonic operation budget across the whole sweep,
  signal checks and supplied lifecycle/currentness checks before/after awaits and
  at precommit. Existing per-result reconciliation keeps its own bound too.
- Each success item is `{runId,jobId,status:'reconciled',result}` with the existing
  exact reconciliation result. A per-candidate failure is
  `{runId,jobId,status:'unavailable',requiresReconciliation:true}` with no raw error.
  Continue only if signal/time/lifecycle remain current; these failures throw.
  Earlier results may already have committed if the overall sweep later rejects.
- One failed candidate cannot silently disappear or claim no write. No automatic
  provider retry, new attempt, false completion, review/verification bypass, or
  external checkpoint repair follows failure. No retries inside a sweep.
- Return scope/project, items, nextRunId and literal grantsApproval/ExecutionAuthority
  false. Successful jobs drop out of future discovery. Explicit exact-result replay
  remains available through the existing reconciliation operation.

## Scope and proof

No migrations, roles/grants, acceptance rules, queue claims, planner/native authority,
HTTP routes, credentials, dependencies, listeners, services or deployment changes.
Root owns implementation and integration. Bounded agents author separate regression
and compiled-factory tests; independent review checks the frozen implementation.

Acceptance uses actual restricted-role disposable SQL for saved-result discovery,
waiting-review then real owner-review/completion, completed-job exclusion, missing
bytes/failure disclosure, capture/cancel/drain/time boundaries and project scoping.
Pagination/continuation tests must distinguish real SQL selection evidence from
synthetic candidate-order tests. Preserve all existing tests and both build profiles.
No result here accepts upstream workflow completion, revision execution or a live fleet.
