# Work-engine implementation direction

2026-09-08. Proposed conditional direction; root acceptance is recorded in the
decision register. This is not a declaration that the exhaustive RC1 comparison
or production acceptance has finished.

## Choose one queue: retain pg-boss 12.30.0

Keep the existing maintained queue and its actual Control Room submission/worker
adapters. Retain canonical task, approval, lease, result, review and uncertainty
authority outside queue bookkeeping. A completed queue phase can leave the logical
task waiting for review. No second workflow engine or custom queue is selected.

This is a continuity/adaptation-cost decision, not an asserted benchmark winner.
Actual CR same-session transaction/submission/worker integration is already present
and exercised. The joined native PostgreSQL review test and fresh-process readback
now demonstrate required short-phase behavior in both pg-boss and DBOS. With no
demonstrated required advantage from replacement, use the working existing seam.

## Strong alternatives, not false rejections

- DBOS 4.27.6: real same-session submission, durable workflow APIs, short-phase
  review and retained-result retrieval are viable. Its earlier capacity-one durable
  wait is not a reason to reject it: the equivalent short-phase test passes. Choosing
  it entails replacing queue adapters and mapping durable workflow ownership/version
  behavior to canonical state. Total migration cost is unmeasured. Reconsider for a
  named durable multi-step requirement that meaningfully removes existing work.
- Hatchet at 4be0bdc7b96c33579f134d859960d4345035cd40: public trigger and server
  implementation were inspected, including upstream idempotency tests. Its existing
  CR-outbox route remains viable. It does not directly share the caller SQL lease;
  remote run receipt/expiry/uncertainty mapping is additional adaptation. No actual
  Hatchet service comparison was run. Do not label it slower, unreliable or failed.
  Reconsider if a required distributed workflow capability justifies that adaptation.
- Custom queue: no identified gap justifies replacing maintained storage, polling
  or scheduling internals with original infrastructure. CR-specific canonical
  authority and bounded effects remain necessary regardless of queue vendor.

## Exact work and acceptance still owed

Keep pg-boss submission/pickup and bounded adapters; no queue replacement or
production deletion is selected. Integrate the selected pg driver separately.
Complete admission/precommit coupling with the actual canonical caller, duplicate
and changed-input reconciliation, worker crash/uncertain-start handling, review
continuations, occurrence replay, drain/restart and exact PG17 runtime privileges.
Queue retry or expired deduplication never grants permission to repeat an uncertain
native operation. Failed acceptance reopens this direction; do not suppress failures.

Existing source pins and package lock are the starting point, not a new advisory
scan or license audit. Preserve final dependency/license and deployment gates. No
new download, install, service, database role or GitHub action follows from selection.

Evidence: f1-pgboss-cr-review.md; f1-postgres-review.md;
f1-dbos-worker-review.md; f1-pgboss-worker-review.md;
f1-hatchet-review.md; f1-joined-review-queue-fit.md. Initial setup failures and
scope limitations remain in their receipts. Tests do not establish exactly-once
external effects. Required unperformed comparative tests remain visible in RC1;
choosing an implementation direction must not be reported as completing them.
