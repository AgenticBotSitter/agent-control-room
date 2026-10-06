-- Revoke exactly what 0290 granted, then drop exactly what it created. No other
-- privilege, object or role is touched: the grants above are the only ones this
-- migration added, and the table and its trigger are the only objects.
--
-- The role files keep granting the read, so re-applying 0290 (or upgrading
-- forward again) restores it -- the down file reverses one migration, it does
-- not rewrite the authoritative statement.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE INSERT, SELECT ON control_task_handoffs FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE SELECT ON control_task_handoffs FROM control_room_fleet_gateway';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON control_task_handoffs FROM control_room_task_coordinator';
  END IF;
END $$;

DROP TABLE IF EXISTS control_task_handoffs;
DROP FUNCTION IF EXISTS public.guard_control_task_handoff_immutable();