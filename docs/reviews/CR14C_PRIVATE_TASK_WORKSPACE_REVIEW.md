# CR14C private task workspace — initial independent review

**Disposition:** REJECTED pending two corrections. Preserve this original result.
**Reviewer:** independent `cr14c_private_task_review`; no implementation or edits.
**Candidate:** `7444c4210cce4f8fc6057e3693fa604954b1db25`.
**Tree:** `47304c67a7b9fef29d93aab911cd036e8d7636c0`.
**Base:** `7020280c8525052fe76bb1e1ab635d3b4359a72f`.
All 32 changed paths were inspected; the candidate remained unchanged during review.

1. **Medium — unsuccessful reconciliation discards an earlier uncertain save.**
   `src/web/v1/task-browser-client.ts:51` clears pending on every 4xx, even after an earlier lost response.
   A later denial cannot establish whether that original save committed. Losing its key and changed-save
   hold can permit duplicate work. Preserve uncertain identity until positively reconciled, distinguishing
   a first-attempt definitive rejection from a later denied check.
2. **Medium — unavailable native progress can appear currently active.**
   `private-app/app/task-panels.tsx:46` prefers native state over disconnected harness state;
   `src/web/v1/task-service.ts:159` marks stale only by timestamp. A fresh running snapshot with offline/
   expired availability can say Agent working while its contrary availability is hidden in collapsed history.
   Show availability prominently and label retained state as previously reported. The Last received label
   also displays node observation time, not measured server receipt time; use an observation label.

Independent checks: stage zero ready (exit 0); seven authorized task/role/preparation test files **57 passed**,
zero failed/skipped (exit 0); TypeScript and cumulative whitespace checks exit 0. These passing checks did
not cover the two identified combinations. Root's broader results remain separately attributed.

No edits, builds, browser, network, credentials, native/provider calls, real databases, services, deployment
or publication. Atomic non-running proposal semantics and evidence/authority separation held in reviewed
scope. Live dispatch/artifact/review/browser acceptance remains unfinished, not accepted by these tests.
