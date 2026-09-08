# Same collected-story revision child through fresh approval and completion

Research only; source base1449c64. This extends the existing joined borrowed-news
journey, not a disconnected generic revision fixture. No application behavior or
security contract changes, additional PGlite database, socket, real provider,
credentials, download, external service, GitHub or Git modification.

## Result

The same child produced from the collected article's reviewed parent result now
passes fresh approval, signed in-memory delivery, synthetic execution, its own
result intake, structure verification, independent-owner review and canonical
completion. Child job and attempt become succeeded; its lease becomes released.
Replay returns the same completion receipt and unchanged child states. The parent
remains in its previously reviewed/held state with its capacity released: this does
not silently accept or complete the parent's rejected result.

The original source article URL, collected story digest, prior result and requested
feedback remain in the child's persisted task input. Its actual v2 native review
plan equals the execution plan's complete revision context, with explicit assertions
for parent job/run/target/content/review and feedback digest references. Parent and
child have distinct job, attempt, lease, run, review target, artifact/content hash and
review identities; task planning, assignment and review services own those identities.

## Authority and service boundaries exercised

1. Existing coordinator refuses the parent signed approval packet for the child.
   Its original stored parent approval is unchanged before and after this attempt.
2. Existing `prepareNativeApproval` returns the child's current job/attempt/operation
   binding. Existing fixture `f.sign` uses only the existing synthetic test key to
   sign a fresh child-bound approval and recovery binding with distinct nonces.
   `storeNativeApproval` verifies/persists the packet through its actual authenticated
   service. No direct SQL approval insertion or bypassed signature check is used.
3. Existing enqueue/stage/transmit, bridge admission/receipt, handoff, run registration
   and signed snapshot services execute the same child in one existing database.
   The backend's run_222… ID is a deliberately distinct valid synthetic ID, not a
   second use of the parent's fixed fixture backend ID.
4. Actual revision-aware `bindReview/registerRevision` runs before child snapshot
   publication and binds its own v2 target to the predecessor review/context.
5. Actual result intake records new bytes, with article/digest/feedback text supplied
   by the fixture. Completion refuses before verification and again after structure
   verification but before this child's accepted owner review. The child's distinct
   review then permits actual canonical completion; replay preserves states/receipt.

The existing profile checks document headings/size, not factual research quality.
The accepted review is a synthetic authenticated owner operation, not a real owner's
review of agent work. No live agent/native protocol qualification is earned.

## Fixture adaptation and cleanup

Owned `research/reuse-comparisons/cross-journey-child-helper.ts` adapts existing
`tests/helpers/native-start-authority.ts` and `native-task-lifecycle.ts` wiring.
It receives the already-created database and assigned child through a fixture facade.
Its local initial clock is the current parent fixture clock: the old helper's fixed
initial instant predates the new child's lease and is not reused or moved backward.
Node policy/approval/lease constraints remain the same existing implementation.

The child local admission/execution/effect/run journals and bridge journal are
ephemeral in-memory SQLite stores. Cleanup callbacks are registered as each owned
resource is created; the parent fixture owns/closes the sole existing PGlite fixture.
Separate local journals mean the tested parent and child effect counters are each1:
this is explicitly **not** shared-journal fleet deduplication, restart recovery or
cross-host coordination evidence. Both test invocations reached terminal exit0.

## Commands, evidence and limits

Stage zero first reported ready_for_runtime_check, Node baseline and frozen pnpm
policy. `node --import tsx --test research/reuse-comparisons/cross-journey-revision.test.ts`
passed one joined test initially (~2.29s), then once more with root-requested explicit
v2-context, post-verification refusal, terminal-state and replay assertions (~2.31s).
No failing test invocation or domain workaround occurred. Two patch-assembly context
lookups needed correction while authoring the owned helper; they executed no test or
candidate code. Final edits after execution changed only helper comments/unused
imports and replaced the facade's broad type with the existing fixture return type.
Focused ESLint on both research files passed with no output.
[Retained output and scope](cross-journey-child-evidence.json).

This establishes a stronger E3 synthetic application composition: collected story
→ original task/result/review → same revision child → own approved execution/result/
review/completion. It does not establish live research usefulness, shared-node durable
dedup, real key custody, provider behavior, target deployment or overnight autonomy.
This joined fixture also does not exercise a candidate queue engine, persistent
worker loop or restarted shared node journal. Those existing gates remain unchanged.
Root and independent review retain acceptance
authority; this report does not self-approve or declare Control Room complete.
