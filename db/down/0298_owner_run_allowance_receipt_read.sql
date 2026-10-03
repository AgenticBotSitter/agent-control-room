-- Revoke exactly what 0298 granted, and nothing else. This migration added one
-- column-scoped SELECT to one role and created no object, so there is nothing to
-- drop and no other privilege, role or relation is touched.
--
-- The role file keeps granting the read, so re-applying 0298 (or upgrading
-- forward again) restores it -- the down file reverses one migration, it does not
-- rewrite the authoritative statement.
--
-- The nine columns are spelled out rather than written as `REVOKE SELECT ON
-- pipeline_advance_receipts`, because a table-wide revoke is not the same act:
-- it would also strip any grant a LATER migration added, which is precisely the
-- thing a rollback must not do.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT (tenant_id, pipeline_run_id, stage_ordinal, loop_index, source_job_id, '
      || 'execution_job_id, advanced_at, delegation_cost_state, delegation_cost_microusd) '
      || 'ON pipeline_advance_receipts FROM control_room_private_web';
  END IF;
END $$;
