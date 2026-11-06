-- Unvalidate acknowledgement and admission provenance.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
DO $$ DECLARE predicate text; name text; BEGIN
 FOREACH name IN ARRAY ARRAY['control_loop_improvement_commands_binding_check','control_loop_improvement_commands_check1'] LOOP
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT predicate FROM pg_constraint
   WHERE conname=name AND conrelid='control_loop_improvement_commands'::regclass;
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I','control_loop_improvement_commands',name);
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID','control_loop_improvement_commands',name,predicate);
 END LOOP;
END $$;
-- Leave validated pair FKs in place until 0316 down drops the pair; no needless FK re-add.
COMMIT;
