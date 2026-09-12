# Joined queue/canonical review comparison

2026-09-08. Both actual queue libraries now execute the same canonical review
callback against their own fresh PostgreSQL18.4 fixture, sharing its main database.
No new downloads; existing approved comparison distribution and packages reused.

Commands (both exit 0, clusterStopped:true and cleanup:true):

```
node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO review-native
node --import tsx research/reuse-comparisons/f1-postgres-run.mjs /private/tmp/cr-compare-f1.9x5bSO review-native dbos
```

Both returned pendingReview:true, releasedCapacity:true,
reconstructedExactReceipts:true, additionalNativeCalls:0, sameDatabase:true,
queueConcurrency:1 and independentProbeWhileReviewPending:true. Each used one
native canonical database and one separate PGlite trust-support fixture. These are
transcribed terminal observations, not retained raw process-log files.

The queue callback invokes the actual TaskQualityCoordinator against existing
fixture results. Its stored output is waiting_review, not completed task authority.
One independent probe executes afterward at concurrency one before owner review.
The logical task remains unfinished. Coordinator reconstruction preserves exact
capacity/result lineage; synthetic owner review later enables exact completion,
and another reconstruction replays the same receipt. Native call count is unchanged.

DBOS uses the same short-phase pattern, not a durable recv wait. Consequently the
older observation that a durable waiter occupies capacity one does not discriminate
against DBOS for this integration. Both candidates fit this joined responsibility.

Limits: probe work is not a second canonical agent job; task admission occurred
before queue submission, so this experiment does not prove atomic admission/enqueue.
Existing transaction evidence is separate. Reconstruction is in-process and queue
workers were not crashed; native uncertainty, process restart, repeated queue
submission and Hatchet lost-ack/dedup-expiry remain untested here. The output's
older wording 'DBOS/Hatchet parity not tested here' refers to full candidate parity:
short-phase pg-boss/DBOS behavior is now compared, not all recovery semantics.

No speed/RSS winner is inferred. Candidate pins are pg-boss12.30.0 (existing app
dependency) and DBOS4.27.6 (checked by the DBOS helper). Production roles, deployment,
full dependency notices and independent review of this new seam remain separate.
This evidence supports retaining both viable candidates; not a final engine winner.

## Independent review and fresh-process readback

Independent compare_ui review found no material blocker at the stated scope and
accepted that short-phase review-capacity uncertainty is closed for both candidates.
Root accepts the finding and its limits. Clarification: DBOS fixture provisioning
uses internal ensureSystemDatabase; the workflow, queue and result operations under
comparison are public APIs. Fixture setup is not a selected production migrator.

A subsequent extension spawns a new read-only client process for the exact saved
phase ID. Its connection checks transaction_read_only=on. It neither starts a
worker nor enqueues work, and uses actual pg-boss getJobById or DBOSClient retained
workflow getResult. Parent compares the full returned result to the initial queue
result and verifies callback count remains two (review phase and unrelated probe).

Both commands above were run once with this extension, each exit 0 and returning
freshProcessExactResultRead:true in addition to the earlier fields. Each retained
clusterStopped:true and cleanup:true. This proves fresh-process retrieval of the
same committed result. The original worker remains alive during the readback;
do not label this a worker crash or database-restart test. No live agent or extra
downloads. Review of this extension remains separate from the preceding review.
