BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_update_candidates, control_loop_update_candidate_decisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_loop_update_candidates) OR EXISTS (SELECT 1 FROM control_loop_update_candidate_decisions) THEN
    RAISE EXCEPTION 'loop candidates retained' USING ERRCODE='23514';
  END IF;
END $$;
DROP TABLE control_loop_update_candidate_decisions RESTRICT;
DROP TABLE control_loop_update_candidates RESTRICT;
DROP FUNCTION guard_control_loop_update_candidate_decision_insert() RESTRICT;
DROP FUNCTION guard_control_loop_update_candidate_insert() RESTRICT;
COMMIT;
