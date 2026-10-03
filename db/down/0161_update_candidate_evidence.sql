SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE OR REPLACE FUNCTION guard_update_candidate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state <> 'ready' OR NEW.version <> 1 OR NEW.decided_at IS NOT NULL THEN
    RAISE EXCEPTION 'update candidate must be published ready' USING ERRCODE = '23514';
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

ALTER TABLE control_update_candidates
  DROP CONSTRAINT ck_control_update_candidate_independent_reviews_array,
  DROP CONSTRAINT ck_control_update_candidate_risk_flags_array,
  DROP COLUMN independent_reviews,
  DROP COLUMN risk_flags;
