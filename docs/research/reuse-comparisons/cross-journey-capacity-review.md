# Independent joined-revision capacity review

2026-09-08. Source-only review at requested baseline77dfd3f plus the uncommitted joined research fixture/report. No tests, services, downloads, capacity changes or production edits performed. This review does not approve an implementation change.

## Finding

The observed conflict is a valid saturated-capacity refusal, but **not evidence that a new held-review release mechanism must be invented**. The joined fixture bypasses an already implemented reconciliation step. The immediate issue is test/application-composition coverage: add the existing legitimate release path to this ABS-origin journey, then test assignment. Do not increase concurrency, delete the seed lease or force parent completion.

## Where the active leases come from

1. `tests/native-task-fixture.ts:58–64` creates/claims its pre-existing `job:test` with `lease:test`, acquired at fixture instant and expiring at+300,000ms. This baseline record is inherited through `webNativeResultFixture` → `ownerReviewFixture` → `taskAssignmentFixture`. It is unrelated to the newly prepared ABS execution job, though on the same node.
2. `tests/helpers/task-assignment.ts:36–37` fixes route `maxConcurrentTasks:2`. `native-start-authority.ts:17–30` invokes the real assignment coordinator for the newly planned execution and prepares approval from its canonical job/attempt/lease. That parent execution contributes the second active lease.
3. The joined helper completes native output, ingests bytes and invokes verification/review directly. `x.verify()` and `x.review("changes_requested")` do **not** invoke `TaskQualityCoordinator.reconcile`. A rejected `x.complete()` properly cannot turn changes-requested quality into success. Both occupancy leases therefore remain active before child assignment.

`src/web/v1/task-assignment-coordinator.ts:530–532` counts all active leases for that tenant/node under its assignment transaction, then rejects at the route limit. Neither native terminal status nor a saved revision proposal independently releases occupancy. The new assertion `active >= maximum` proves saturation, not the exact two lease identities; those identities are established by source tracing and existing dedicated tests, not a newly observed query in this review.

## Existing legitimate release mechanism

- `src/persistence/native-task-completion.ts:109` exposes `releaseCapacity`. It validates exact completed native result/attempt/lease epoch and deadline evidence, emits an authenticated capacity receipt and transitions **only the source lease** to released. Its receipt explicitly says qualityAccepted:false and grantsExecutionAuthority:false. Job/attempt quality truth remains held.
- `src/web/v1/task-quality-coordinator.ts:137/169` (`reconcile`) invokes this release for eligible non-complete quality dispositions. `task-coordinator-lifecycle.ts:285–292` mounts the actual quality operation. This is the intended composition point missing from the joined fixture's direct verify/review calls.
- `tests/task-capacity-release.test.ts:64`, **“a planned revision fits the unchanged node capacity only after the source release”**, already tests exactly this two-slot setup: seed plus parent, initial refusal, actual quality reconciliation, source lease release with seed/job/attempt preserved, then child assignment at unchanged capacity.
- `tests/task-capacity-release.test.ts:108`, **“automatic pending release precedes change-request revision planning and assignment at unchanged capacity”**, exercises release while waiting for review before later changes-requested revision/assignment. The first test in that file also covers later accepted completion without rewriting the released lease. These are existing source-defined tests, not independently rerun evidence here.

## Next legitimate joined test

Keep the current refusal as precondition evidence. Capture the exact seed lease and source job/attempt/lease. Call the mounted actual `owner.quality.reconcile` on the same ABS run/target/content request. Assert changes_requested (or waiting_review when exercising that ordering), authentic capacity receipt, parent job/attempt unchanged, only its lease released, unrelated seed unchanged, active count2→1, no extra native calls/effects. Then invoke real child assignment at unchanged route2 and assert active count1→2, a fresh child attempt/lease with expected IDs/input digest, and no new native dispatch or approval authority. Replay both reconciliation and assignment through reconstructed coordinators.

This tests the already implemented held-review lifecycle without pretending a completed native process means reviewed task success. Whether the continuously running application reliably schedules this reconciliation after result arrival remains a separate continuous-worker integration question; this fixture's omission alone cannot answer that deployment wiring question.

## Reporting disposition

The current report fairly retains the failed positive assignment expectation and subsequent refusal evidence. Add the source-traced explanation and name the existing reconciliation path rather than leave “legitimate capacity release” unspecified. Successful assignment and revised execution are still distinct gates. No queue/library candidate is rejected, no policy is weakened and no revised task has executed as a result of this audit.

## Focused review of the reconciliation extension

2026-09-08. Source/report recheck, no independent rerun. The updated joined fixture now preserves saturated refusal and invokes the actual mounted `owner.quality.reconcile` against the same ABS run/target/content. It asserts changes-requested disposition and a capacity receipt, released source lease, unchanged parent job/attempt and unchanged seeded lease. Assignment then succeeds at the original route limit with a distinct current lease, one child attempt and no run. Reconstructed assignment returns the exact receipt; all prior run rows, parent state and synthetic effect count remain unchanged.

**The identified missing composition step is addressed.** This is legitimate reuse of existing release policy, not fabricated free capacity or acceptance of quality. Root reports1 pass/0 failures and1883.108042ms for this extension; source assertions support the bounded conclusion. Earlier generic release tests remain the stronger dedicated coverage of detailed receipt authentication and precise2→1→2 occupancy counts, not newly reproduced assertions in this joined test.

No blocking implementation/evidence defect found within this source-reviewed extension. The report's earlier phrase “successful revision assignment ... remains unproven” should be read as the historical refusal-only stage and changed to “was unproven at that stage” to avoid contradicting its subsequent successful extension. Its final remaining-work list correctly advances to fresh approval/dispatch and second result/review. Independent source recheck is complete; role/PG/provider/continuous-service qualification and child execution remain open.
