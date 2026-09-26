-- Inert locking support for the Mac-local result publisher (owner decision
-- 2026-09-25, docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md section 15).
-- createOwnerTrustedLocalCliPublishV1 -> HarnessRunStoreV1.create() and
-- publishDurableResultV1's ensureNeutralReviewPlan each take a
-- `SELECT ... FOR UPDATE` row lock before the row exists (or is replayed).
-- FOR UPDATE needs a column UPDATE privilege; only these immutable
-- false-valued lock columns are granted (db/roles/local_result_publisher_roles.sql),
-- matching every other *_lock column in this schema. The publisher role's grant
-- is scoped to exactly this column on each table, so it can never touch
-- control_harness_runs' real columns (state, payload, ...), and its CHECK
-- (publisher_lock IS FALSE) means even this column can never actually change.
-- control_native_review_plans is separately immutable end to end via its
-- existing append-only trigger (migration 0044).
ALTER TABLE control_harness_runs ADD COLUMN publisher_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_harness_runs_publisher_lock CHECK (publisher_lock IS FALSE);
ALTER TABLE control_native_review_plans ADD COLUMN publisher_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_native_review_plans_publisher_lock CHECK (publisher_lock IS FALSE);

-- The review-tray step (DurableResultReviewSubmissionServiceV1) runs under the
-- existing results login and also locks the plan and the artifact receipt with
-- SELECT ... FOR UPDATE. Same inert pattern (owner-approved 2026-09-25): a
-- CHECK-false column, UPDATE granted on it alone (db/roles/native_results_roles.sql).
-- No real column becomes writable.
ALTER TABLE control_native_review_plans ADD COLUMN results_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_native_review_plans_results_lock CHECK (results_lock IS FALSE);
ALTER TABLE control_native_artifact_receipts ADD COLUMN results_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_native_artifact_receipts_results_lock CHECK (results_lock IS FALSE);
