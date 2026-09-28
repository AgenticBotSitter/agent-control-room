BEGIN;
LOCK TABLE control_completion_gate_records, control_agent_review_plans IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_agent_review_plans)
    OR EXISTS (SELECT 1 FROM control_completion_gate_records
      WHERE kind='review' AND payload->'reviewer'->>'actorType'='agent') THEN
    RAISE EXCEPTION '0097 down migration refused: agent review history exists';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer') THEN
    EXECUTE 'REVOKE SELECT ON control_agent_review_plans, control_completion_gate_records, control_completion_gate_integrity, control_harness_runs, control_attempts, control_task_execution_plans, pipeline_stage_runs FROM control_room_agent_reviewer';
    EXECUTE 'REVOKE UPDATE (web_lock) ON control_completion_gate_records FROM control_room_agent_reviewer';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION commit_agent_review(text,jsonb,jsonb,bytea) FROM control_room_agent_reviewer';
    EXECUTE 'REVOKE USAGE ON SCHEMA public FROM control_room_agent_reviewer';
  END IF;
END $$;
DROP TRIGGER control_completion_gate_agent_reviewer ON control_completion_gate_records;
DROP FUNCTION guard_agent_reviewer_gate_insert();
DROP FUNCTION commit_agent_review(text,jsonb,jsonb,bytea);
DROP FUNCTION agent_review_principals_independent(jsonb,jsonb,jsonb);
DROP FUNCTION agent_review_hmac_sha256(bytea,text);
DROP FUNCTION agent_review_canonical_jsonb(jsonb);
DROP TRIGGER control_agent_review_plans_binding ON control_agent_review_plans;
DROP FUNCTION guard_agent_review_plan_insert();
DROP TABLE control_agent_review_plans;
COMMIT;
