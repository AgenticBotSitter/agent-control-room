-- Reverses only what 0241 granted, guarded on role existence like 0195 and 0220:
-- a bare REVOKE to a role that does not exist yet is a hard error, and this file is
-- read by the schema-only paths where the web login has not been created.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (last_done_at, snoozed_until, updated_at) ON recurring_chores FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT ON recurring_chores FROM control_room_private_web';
    EXECUTE 'REVOKE UPDATE (last_opened_at, open_count, updated_at) ON page_visits FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT ON page_visits FROM control_room_private_web';
    EXECUTE 'REVOKE UPDATE (pinned_at, updated_at) ON page_pins FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT, DELETE ON page_pins FROM control_room_private_web';
  END IF;
END $$;
COMMIT;
-- The three guard functions and their triggers. Dropped last, and only after the
-- grants above: a down file that dropped the function first would fail, because the
-- triggers that reference it still exist. This is the same order 0219's down file
-- uses, for the same reason.
BEGIN;
DROP TRIGGER page_pins_no_truncate ON page_pins;
DROP TRIGGER page_pins_guard ON page_pins;
DROP TRIGGER page_visits_no_truncate ON page_visits;
DROP TRIGGER page_visits_no_delete ON page_visits;
DROP TRIGGER page_visits_guard ON page_visits;
DROP FUNCTION public.guard_page_pin_write();
DROP FUNCTION public.guard_page_visit_write();
DROP TRIGGER recurring_chores_no_truncate ON recurring_chores;
DROP TRIGGER recurring_chores_no_delete ON recurring_chores;
DROP TRIGGER recurring_chores_guard ON recurring_chores;
DROP FUNCTION public.guard_recurring_chore_write();
COMMIT;