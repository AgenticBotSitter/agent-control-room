BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_providers, control_loop_provider_models, control_loop_provider_state IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM control_loop_providers) OR EXISTS(SELECT 1 FROM control_loop_provider_models) OR EXISTS(SELECT 1 FROM control_loop_provider_state) THEN
  RAISE EXCEPTION 'loop providers retained' USING ERRCODE='23514';
 END IF;
END $$;
DROP TABLE control_loop_provider_models RESTRICT;
DROP TABLE control_loop_providers RESTRICT;
DROP TABLE control_loop_provider_state RESTRICT;
COMMIT;
