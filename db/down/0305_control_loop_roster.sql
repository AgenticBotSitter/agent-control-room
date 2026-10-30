BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_roster_models, control_loop_roster_state IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_loop_roster_models) OR EXISTS (SELECT 1 FROM control_loop_roster_state) THEN
    RAISE EXCEPTION 'loop roster retained' USING ERRCODE='23514';
  END IF;
END $$;
DROP TABLE control_loop_roster_state RESTRICT;
DROP TABLE control_loop_roster_models RESTRICT;
COMMIT;
