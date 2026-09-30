-- Candidate publisher evidence. These fields are immutable with the rest of a
-- candidate and contain no repository path or runner credential.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_update_candidates
  ADD COLUMN risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN independent_reviews jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT ck_control_update_candidate_risk_flags_array
    CHECK (jsonb_typeof(risk_flags) = 'array') NOT VALID,
  ADD CONSTRAINT ck_control_update_candidate_independent_reviews_array
    CHECK (jsonb_typeof(independent_reviews) = 'array') NOT VALID;

ALTER TABLE control_update_candidates
  ALTER COLUMN risk_flags DROP DEFAULT,
  ALTER COLUMN independent_reviews DROP DEFAULT;

CREATE OR REPLACE FUNCTION guard_update_candidate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state <> 'ready' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'update candidate must be published ready' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.test_results) = 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.test_results) result
      WHERE result->>'status' IS DISTINCT FROM 'passed'
        OR result->>'candidateRevision' IS DISTINCT FROM NEW.candidate_revision
        OR (result->>'evidenceDigest' ~ '^sha256:[a-f0-9]{64}$') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'update candidate tests have not passed' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.risk_flags) > 0 AND jsonb_array_length(NEW.independent_reviews) = 0 THEN
    RAISE EXCEPTION 'update candidate needs independent review' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_improvement_requests request
      JOIN pipeline_runs run ON run.tenant_id=request.tenant_id AND run.id=request.pipeline_run_id
        AND run.project_id=request.project_id AND run.state='succeeded'
      JOIN pipeline_stage_runs stage ON stage.tenant_id=run.tenant_id AND stage.pipeline_run_id=run.id
        AND stage.project_id=run.project_id AND stage.stage_kind='signoff' AND stage.state='succeeded'
        AND stage.worker_id=NEW.lead_worker_id
      WHERE request.tenant_id=NEW.tenant_id AND request.id=NEW.improvement_request_id
        AND request.project_id=NEW.project_id AND request.pipeline_run_id=NEW.pipeline_run_id
        AND request.lead_worker_id=NEW.lead_worker_id) THEN
    RAISE EXCEPTION 'update candidate has no signed-off pipeline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_update_candidate_insert() FROM PUBLIC;
