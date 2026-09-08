# Joined ABS result-to-revision evidence

2026-09-08; source baseline a8e67a8. Research-only integration, no application edits.

## Decision-changing result

The existing collector, ordinary task services, native-result intake and revision
planner can preserve **one ABS source lineage into a linked owner-requested revision**.
No replacement collector or new revision engine is needed to close this specific
link. The previous ABS journey stopped after accepted completion; separate generic
revision tests did not prove this exact source/result relationship. The new joined
fixture now closes that narrow missing comparison-baseline seam.

Actual fixture: `research/reuse-comparisons/cross-journey-revision.test.ts`, derived
from current `tests/abs-research-native-journey.test.ts`. It keeps borrowed discovery,
protected article/task reads, actual planner, assignment and signed in-process
delivery/result handling. The final path instead requests changes and calls actual
`createTaskCoordinatorLifecycle` revision planning against the **same database**.

Checks prove:

- Original article URL/story digest are retained in the ordinary task instructions.
- Planned native task is distinct from original source job and binds its exact draft.
- Returned artifact bytes match the synthetic output and protected read rejects
  missing authentication.
- Structural verification plus changes-requested owner review cannot complete parent.
- Revision child has distinct ID and binds exact source job, run, target ID/digest,
  result content hash and review ID. Its prompt retains original article/story lineage,
  previous result and exact feedback.
- Proposed revision creates no attempts/leases and grants no execution authority.
- A reconstructed coordinator replays the same child; exactly one child audit exists.
- Re-ingesting the original result preserves its receipt; synthetic execution effect
  counter remains one throughout. That counter is not a measured real provider call.

One joined test initially passed. Independent source review requested explicit
run/target/digest tuple assertions; these were added and the corrected test passed
again: one test, zero failures,1979.743542ms runner duration.
[Direct corrected output](cross-journey-revision-evidence.json) retains the SQLite
experimental warning. Stage-zero reported ready_for_runtime_check; no native readiness
or credential operation followed. Focused ESLint and diff checks passed.

## Real versus synthetic boundaries

Actual Control Center modules, web/task/collection/revision services, canonical SQL
stores, signatures and result/review code execute. PostgreSQL behavior is PGlite,
not target PG17. DNS/HTTP article responses, telemetry/capabilities, owner keys and
Hermes responses are synthetic; bridge traffic is exchanged through in-memory arrays,
not sockets. Journals, artifacts and checkpoints use existing disposable fixture
stores; reconstruction is a new coordinator over the same open database, not database
process restart or disk restoration. Quality rules verify document headings/size,
not truth, sources or business usefulness.

The revision call here is a direct actual coordinator service call. It does not
replace the separate restricted-role/protected-revision-HTTP tests, nor claim this
joined test ran under those two restricted startup roles. Native fixture inserts
and qualification seams remain as documented in its helpers. Cleanup uses fixture
close hooks; both test processes exited. No downloads or persistent services.

## What remains and what can be reused

Reuse this exact fixture as the baseline when comparing queue/native transport changes;
do not repeat it unchanged simply for more test counts. Preserve source→execution→
revision identities even if candidate queues and native session IDs differ.
The actual queue worker/client swap must cross these same services before replacing
current infrastructure. Existing generic tests already cover lost revision-plan
acknowledgment, cancellation, restricted HTTP and changed feedback; reuse them at
their exact scope rather than write duplicates.

Still open: the revision's fresh assignment/approval/dispatch, actual second result
and review; joined restart/restore and late/uncertain-result behavior; actual native
SDK/queue contenders through this journey; real PG17 roles/concurrency; browser and
provider-qualified workflow. A proposed child is **not** a completed revised task.
The initial accepted-completion test remains unchanged alongside this changes-requested
branch. Do not complete the parent first to force revision: the current revision
contract expects its held changes-requested context.

Production deletion: zero. The recommendation is to reuse current domain linkage,
not retain every custom transport or certify all RC1–RC4/RC7 comparisons complete.
