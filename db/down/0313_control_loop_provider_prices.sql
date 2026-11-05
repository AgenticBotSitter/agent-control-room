BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_provider_prices, control_loop_provider_fetches IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM control_loop_provider_prices) OR EXISTS(SELECT 1 FROM control_loop_provider_fetches) THEN
  RAISE EXCEPTION 'provider prices retained' USING ERRCODE='23514';
 END IF;
END $$;
DROP TABLE control_loop_provider_prices RESTRICT;
DROP TABLE control_loop_provider_fetches RESTRICT;
COMMIT;
