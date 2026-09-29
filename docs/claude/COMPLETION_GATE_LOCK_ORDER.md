# Completion-gate lock order (audit, 2026-09-29)

Every completion-gate write takes the tenant's `control_completion_gate_integrity`
row `FOR UPDATE` (`CompletionGateStoreV1.lockAndVerifyTenantState`,
`src/completion-gate/v1/store.ts:511-518`). `getRecord` and `snapshot` take the
same write lock. So in practice every service transaction that looks at the gate
also locks it. A deadlock needs two transactions where one holds that row and
waits for another row, while the other holds that row's lock and waits for the
gate.

## Canonical order

The codebase already uses one order everywhere except the owner-web writers
fixed here. Assignment, quality inspection, native/durable/Codex submission and
the planner all lock parent rows before the gate:

1. The acting web identity, session and grants (the `WebSessionAuthority`
   prologue; only authenticated web transactions).
2. `tenants` — `FOR KEY SHARE`, or `FOR UPDATE` in assignment and bootstrap.
3. Project and project-head rows.
4. `job → attempt → lease → run → artifact receipt → review plan`.
5. `control_completion_gate_integrity` (`FOR UPDATE`).
6. Gate records, then child inserts (review commands, transition events,
   outbox), then the audit chain head.

**Rule:** after step 5, a transaction may only lock step-6 rows, or parent rows
it already holds in an equal or stronger mode. An INSERT takes a foreign-key
key-share on each parent row it references. So any parent it references must
already be locked before the gate.

**Why not "gate first":** the brief proposed taking the gate before any other
row. That order is safe only if *every* gate transaction switches to it,
including about 20 assignment transactions (`tenant FOR UPDATE → head → job
FOR UPDATE → gate`) and the web read pages (`project/head FOR SHARE → gate`).
Switching only some of them creates new cycles. For example, an assignment
changed to take the gate before `control_manual_project_heads FOR UPDATE`
deadlocks with an unchanged task page that holds the head `FOR SHARE` and waits
for the gate. The existing parents-first order needs only the violators fixed.

## Writers (file:line) — before the gate / after the gate

| Transaction | Before the gate | After the gate | Status |
| --- | --- | --- | --- |
| Owner accept / request changes — `WebTaskReviewService.record`, `src/web/v1/task-review-service.ts:202-270` | identity FU, session, grants FS (prologue) → tenant KS (:207) → **job KS (:210, new)** → project FS (:124) | target record FU, gate records, verification (:250), audit (:255, :269), `INSERT control_web_task_review_commands` (:266: FK key-share on identity, project, **job**, artifact manifest, target/review records) | **Fixed.** Before the fix the job key-share happened only at the INSERT after the gate: the observed 40P01/503 cycle. |
| Owner verification — `WebTaskVerificationService.record`, `src/web/v1/task-verification-service.ts:158-190` | prologue → **tenant KS (:162, new)** → project FS | gate records (:183), audit INSERT (:184, tenant FK) | **Fixed (latent).** Without the tenant lock, the audit INSERT's tenant key-share waited on assignment's tenant FOR UPDATE, which waits on the gate. |
| Owner planning — `TaskExecutionPlanner.plan`, `src/web/v1/task-execution-planner.ts:736-806` | prologue → **tenant KS (:740, new)** → project FS → source job FU → profile gate read (:793) | canonical request/workflow/job inserts (:797), plan insert, audit (:801), all tenant FK | **Fixed (latent)**, same tenant cycle. |
| Owner revision — `TaskExecutionPlanner.revise`, `src/web/v1/task-execution-planner.ts:918-…` | prologue → **tenant KS (:922, new)** → project FS → revision inspection (run/job or tenant/job/attempt/lease/run/receipt/plan) → gate | new plan rows, canonical inserts, audit | **Fixed (latent)**, same tenant cycle. |
| Mac-local quality inspection (sweep, reconcile, verify, capacity release, complete) — `DurableLocalResultInspectionServiceV1.inspectSubmitted`, `src/completion-gate/v1/durable-local-result-inspection.ts:104-188`, wrapped by `TaskQualityCoordinator.scopeIn` (`src/web/v1/task-quality-coordinator.ts:95-100`) | tenant KS → project FS → job FU (:114) → attempt FU → lease FU → run FU → receipt/plan FU → gate (:187-188) | verification records, lease/job/attempt transitions (already held), transition/outbox/audit inserts (tenant held) | Compliant. This was the other side of the CI deadlock. |
| Native inspection / submission — `NativeResultSubmissionService.bound/inspectSubmitted/register/registerRevision/submit`, `src/completion-gate/v1/native-result-submission.ts:40-190` | run FU (:41) → job FU (:46) → gate (:53, :74) | review-plan insert (:128, :155), target/revision, audit (:184, tenant FK) | Job/run order compliant. **Latent tenant cycle** in `submit`/`register` (see follow-ups). |
| Native verification — `NativeResultVerificationService.verify`, `src/completion-gate/v1/native-result-verification.ts:47-78` | inspection as above | verification records (:73), audit (:74) | Compliant when run through the quality coordinator (tenant KS first). The reproduction test uses it directly. |
| Native completion — `NativeTaskCompletionService.releaseCapacity/complete`, `src/persistence/native-task-completion.ts:121-245` | inspection (:126, :175) | job/attempt/lease FU (:56), transitions/outbox (:84-88), audit | Compliant: the job row is locked before the gate by the inspection, and the tenant by `scopeIn`. |
| Durable review submission — `DurableResultReviewSubmissionServiceV1.submit`, `src/completion-gate/v1/durable-result-review-submission.ts:97-115` | receipt FU (:77) → plan FU (:68) → gate (:60, :105) | target record, audit (:106, tenant FK) | **Latent tenant cycle** (see follow-ups). |
| Codex inspection — `src/completion-gate/v1/codex-result-inspection.ts:46-83` | run FU → job FU (:68) → gate (:79, :83) | none | Compliant. |
| Codex review submission — `submitReview`, `src/artifacts/v1/codex-results.ts:460-505` | run FU (:462) → plan insert (:484) → gate | target/revision, audit (tenant FK) | **Latent tenant cycle** (see follow-ups). |
| Result coordinator — `TaskResultCoordinator.run`, `src/web/v1/task-result-coordinator.ts:52-68` | run+job FU, project FS (:60) → predecessor run/job FU (:66) → planner/submission → gate | as native submission | Job order compliant. **Latent tenant cycle** via native submission. |
| Assignment — `src/web/v1/task-assignment-coordinator.ts` (e.g. :326-330, :714-719, :853-858) | tenant FU → project head FU → job FU → `planner.readInSession` → profile gate read | lease/attempt rows, transitions, audit (tenant held) | Compliant. It is the tenant-FOR-UPDATE partner in every latent tenant cycle. |
| Saved-plan reads — `readSavedTaskPlansInSessionV1`, `src/web/v1/task-execution-planner.ts:342-347` | source job FOR UPDATE → gate read | none | Compliant. |
| Gate store's own methods — `src/completion-gate/v1/store.ts:178-273` | gate first | gate records | Compliant. **Exception:** `requestApproval`/`decideApproval` (:254-273) lock effect+job FU, identity FU and role grants FU *after* the gate. They have no caller in `src/` today, so this is a latent cycle to fix before wiring them. |
| Scheduled planning — `src/services/v1/scheduled-task-assignment.ts:319-344, :96` | schedule+project FU, occurrence, admission, proposal job FU → `acceptedContextInSession` gate | planner inserts | Parent-first. Not wired in production `src/`. |
| Idea projection — `src/idea-lab/v1/canonical-result-projection.ts:55-63` | receipt read → gate | idea rows | Compliant (no parent locked after the gate). |

FU = `FOR UPDATE`, FS = `FOR SHARE`, KS = `FOR KEY SHARE`.

## Follow-ups not fixed here (need an inert-lock grant decision)

These transactions run as `control_room_native_results` and insert
`audit_events` rows after the gate. An audit row takes a tenant key-share. They
never lock the tenant first, so each one can deadlock with task assignment
(`tenant FOR UPDATE → … → gate`):

- `DurableResultReviewSubmissionServiceV1.submit`
- `NativeResultSubmissionService.submit` / `register`
- the Codex `submitReview`
- `TaskResultCoordinator` via those services

The fix is the same `SELECT id FROM tenants WHERE id=$1 FOR KEY SHARE` first.
But that role has no tenant lock privilege today. It needs `GRANT UPDATE
(coordinator_lock) ON tenants TO control_room_native_results` (inert,
CHECK-false column, preflight map update). That is a grant decision, so it is
left for the lead.

A bounded retry of 40P01/40001 at the transaction boundary was **not** added.
The root-cause fix removes the observed cycle. A retry would also need the
staged rollback-checkpoint object rebuilt per attempt, so it would be its own
reviewed change.
