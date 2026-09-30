-- Revoke exactly what 0224 granted: the coordinator's read on effect intents.
-- Nothing else is touched -- no other privilege on this table, and no other
-- table -- so rolling back restores the pre-0224 ACL rather than narrowing the
-- role further. The role file keeps granting SELECT, so re-applying 0224 (or
-- upgrading forward again) restores it.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON control_effect_intents FROM control_room_task_coordinator';
  END IF;
END $$;