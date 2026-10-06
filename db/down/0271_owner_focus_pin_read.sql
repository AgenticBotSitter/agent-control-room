-- Revoke exactly what 0271 granted, and nothing else: the SELECT
-- control_room_task_coordinator holds on control_owner_focus_pins. The operator
-- surface's ninth read then fails again with `42501 permission denied for table
-- control_owner_focus_pins`, which takes the whole nine-read bundle with it --
-- the pre-0271 behaviour, and the point: this file reverses one migration, it
-- does not rewrite the authoritative statement.
--
-- The role file keeps granting the read, so re-applying 0271 (or upgrading
-- forward again) restores it. Only the SELECT goes: the coordinator never held a
-- write on this table and 0019's own unique constraint and expiry rules are
-- untouched, so no pin can be created, moved or deleted by this file.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON control_owner_focus_pins FROM control_room_task_coordinator';
  END IF;
END $$;