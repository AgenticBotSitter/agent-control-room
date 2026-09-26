-- Owner-approved Mac-local quality reader hold-only locks (2026-09-25).
-- The coordinator reads authenticated durable result evidence under FOR UPDATE
-- before verification/completion. These columns can never change; they grant
-- row-lock ability, not review or result mutation authority.
ALTER TABLE control_native_artifact_receipts ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_native_artifact_receipts_coordinator_lock CHECK (coordinator_lock IS FALSE);
ALTER TABLE control_native_review_plans ADD COLUMN coordinator_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_native_review_plans_coordinator_lock CHECK (coordinator_lock IS FALSE);
