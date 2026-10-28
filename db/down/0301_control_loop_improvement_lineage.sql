-- Refuse to discard any retained owner lineage, atomically.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_improvement_requests, control_loop_improvement_inputs,
  control_loop_improvement_run_links, control_loop_improvement_authorizations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_loop_improvement_requests)
    OR EXISTS (SELECT 1 FROM control_loop_improvement_inputs)
    OR EXISTS (SELECT 1 FROM control_loop_improvement_run_links)
    OR EXISTS (SELECT 1 FROM control_loop_improvement_authorizations) THEN
    RAISE EXCEPTION 'loop improvement lineage retained' USING ERRCODE='23514';
  END IF;
END $$;
-- 0302's journal depends on requests. Roll it back first when still installed,
-- with the same retained-data refusal as its own down migration. Never CASCADE.
DO $$ BEGIN
  IF to_regclass('public.control_loop_improvement_commands') IS NOT NULL THEN
    LOCK TABLE control_loop_improvement_commands IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM control_loop_improvement_commands) THEN
      RAISE EXCEPTION 'loop improvement commands retained' USING ERRCODE='23514';
    END IF;
    DROP TABLE control_loop_improvement_commands RESTRICT;
  END IF;
END $$;
DROP TABLE control_loop_improvement_authorizations RESTRICT;
DROP TABLE control_loop_improvement_run_links RESTRICT;
DROP TABLE control_loop_improvement_inputs RESTRICT;
DROP TABLE control_loop_improvement_requests RESTRICT;
DROP FUNCTION guard_control_loop_improvement_lineage_insert() RESTRICT;
COMMIT;
