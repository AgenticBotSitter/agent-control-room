BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_improvement_commands IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_loop_improvement_commands) THEN
    RAISE EXCEPTION 'loop improvement commands retained' USING ERRCODE='23514';
  END IF;
END $$;
DROP TABLE control_loop_improvement_commands RESTRICT;
COMMIT;
