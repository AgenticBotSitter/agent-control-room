# Scheduled task dispatch

The scheduled-task dispatch service (`ScheduledTaskDispatchServiceV1`) is the bridge between a materialized occurrence and canonical admission. It derives the admission input from stored rows and delegates the entire commit decision to `ScheduledTaskAdmissionServiceV1`. It is not a scheduler and holds no execution authority: recurrence stays with `calculateScheduleOccurrencesV1`, the durable record stays with `ScheduleOccurrenceStore`, and admission remains the only service that creates canonical work.

## Dispatch contract

Dispatch of one occurrence runs the preflight checks that admission cannot infer from its strict input, then calls `admit`:

1. The schedule must exist, be `active`, and target a job.
2. The occurrence must exist, be pending or have a prior admission, target the same job, and carry the definition digest recorded when it was materialized. A schedule whose current definition digest differs refuses `definition_changed`; the stale occurrence stays pending and visible. Dispatch never re-materializes or repairs.
3. The source chain — job, its workflow, the workflow's request — must parse as canonical records, else `source_unavailable`.
4. The outbox row for `schedule.occurrence.created` must already be delivered; admission re-verifies this inside its transaction (`outbox_not_delivered` otherwise).
5. The occurrence must not be scheduled in the future (`occurrence_not_due`), measured against the injected clock.

A refusal maps onto one vocabulary (`invalid_dispatch`, `occurrence_unknown`, `occurrence_cancelled`, `occurrence_conflict`, `occurrence_not_due`, `definition_changed`, `schedule_not_active`, `target_not_admissible`, `source_unavailable`, `recovery_window_expired`, `outbox_not_delivered`, `admission_refused`); admission refusals map without inventing new outcomes.

## Replay boundary

A paused schedule permits acknowledgement replay of a prior admission, but not a new proposal. Changed definitions, source content or context still refuse: the packet requires stale/changed-content refusal, so dispatch does not manufacture an old input from a receipt to bypass that requirement. Such drift requires operator reconciliation; the wrapper does not promise recovery across changed content.

A `dispatched` occurrence with an existing admission and unchanged definition/source/context replays: admission returns the same immutable receipt and the outcome is reported with `replayed: true`. Replay works both for concurrent racing callers (admission serializes on the occurrence row inside its transaction) and for the crash window after a receipt commit but before delivery acknowledgement, which `ScheduleOccurrenceStore.acknowledgeDelivery` settles on replay. One admission, one canonical task — concurrent or repeated dispatch cannot create a second task.

## Batch dispatch

`dispatchDue` drives a schedule's due pending occurrences in `scheduled_for` order, bounded by an explicit `limit` (1–100, default 25). Refusals are reported per occurrence and never abort the batch; a refused occurrence keeps its durable state so a later tick or operator can resolve it.

## Restart reconciliation

`ScheduledTaskRecoveryServiceV1.reconcileOnRestart` covers exactly the window a process can die in: after outbox delivery, before admission. It scans a schedule's occurrences (keyset pagination via `nextCursor`/`after`, limit 1–200) and classifies each:

- `recovered` — pending and delivered; re-driven through ordinary dispatch (`replayed: true` if a receipt committed before a crash, otherwise false). Subsequent scans classify the acknowledged occurrence as settled.
- `awaitingDelivery` — not yet delivered by the outbox; left for the normal path.
- `settled` — cancelled, or dispatched with an existing admission.
- `orphaned` — dispatched with no admission. This is an integrity contradiction; it is reported, never repaired or re-admitted.
- `refused` — dispatch refused (stale definition, expired recovery window, missing source). Reported with the safe code; state is untouched.

Reconciliation delegates writes to canonical admission and acknowledgement; it never marks success by itself or repairs a contradiction. Admission's recovery window (bounded by the schedule's `idempotencyWindowSeconds`) still applies to recovered occurrences — an old delivered-but-unadmitted occurrence refuses as `recovery_window_expired` rather than waking stale work.

## Limits and authority

These are opt-in services for an existing delivery consumer or restart hook; this packet does not install a recurring process or wire production scheduling. Both services create only inert proposals, never assignments, leases, providers or native work. Non-empty reusable contexts are caller supplied and digest-bound; their freshness and capability eligibility remain the existing planner/assignment gates, not a promise made by dispatch. Automatic batch/recovery currently use empty context and fail closed on an existing non-empty binding rather than silently replacing it. Callers needing non-empty recovery must supply the exact original context through `dispatchOne`.

Follow recovery `nextCursor` until absent, and begin a fresh scan on a later tick to revisit refused or awaiting-delivery rows. Dispatch batches report refusals rather than skip them permanently; operators must resolve a full batch of refused oldest rows before later rows can advance. PGlite concurrency tests exercise transactional replay but do not establish independent-connection PostgreSQL MVCC behavior.

## Verification

`node --import tsx --test --test-concurrency=1 tests/scheduled-task-dispatch.test.ts tests/scheduled-task-recovery-integration.test.ts` covers exactly-one-admission under concurrency, replay, stale definition, not-due, unknown/cancelled/undelivered/inactive/malformed refusals, batch ordering, source-bundle drift refusal, crash-window recovery, pagination, orphan reporting and cancellation. The lane is registered in `package.json` (`pnpm test:calendar`).
