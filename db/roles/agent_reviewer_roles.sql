-- OFFLINE OPERATOR SETUP ONLY. One private LOGIN may inherit only this
-- narrowly scoped group role. It cannot plan, assign, run, approve or alter.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer') THEN
    CREATE ROLE control_room_agent_reviewer NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE control_room_agent_reviewer NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM control_room_agent_reviewer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM control_room_agent_reviewer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM control_room_agent_reviewer;
GRANT USAGE ON SCHEMA public TO control_room_agent_reviewer;
-- Exact review commit set: inspect the immutable plan and call the single
-- authenticated server-side commit boundary. No raw table write is granted.
GRANT SELECT ON control_agent_review_plans, control_completion_gate_records,
  control_completion_gate_integrity, control_harness_runs, control_attempts, control_task_execution_plans,
  pipeline_stage_runs TO control_room_agent_reviewer;
GRANT UPDATE (web_lock) ON control_completion_gate_records TO control_room_agent_reviewer;
GRANT EXECUTE ON FUNCTION commit_agent_review(text,jsonb,jsonb,bytea) TO control_room_agent_reviewer;
COMMIT;
