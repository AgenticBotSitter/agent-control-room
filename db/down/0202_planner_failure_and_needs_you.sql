BEGIN;
LOCK TABLE control_planner_needs_you_items, control_planner_failure_counters IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_planner_needs_you_items) THEN
    RAISE EXCEPTION 'planner needs-you down migration refused: records exist';
  END IF;
  IF EXISTS (SELECT 1 FROM control_planner_failure_counters WHERE failure_count>0) THEN
    RAISE EXCEPTION 'planner failure counter down migration refused: live failures exist';
  END IF;
END $$;
-- Only what 0202 granted, and only from roles that exist here.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT ON control_planner_open_needs_you FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_planner_needs_you_items FROM control_room_task_coordinator';
    EXECUTE 'REVOKE UPDATE (failure_count, last_failure_at, cleared_at, version, updated_at) ON control_planner_failure_counters FROM control_room_task_coordinator';
    EXECUTE 'REVOKE SELECT, INSERT ON control_planner_failure_counters FROM control_room_task_coordinator';
  END IF;
END $$;
DROP VIEW control_planner_open_needs_you;
DROP TRIGGER control_planner_needs_you_items_no_truncate ON control_planner_needs_you_items;
DROP TRIGGER control_planner_needs_you_items_append_only ON control_planner_needs_you_items;
DROP TRIGGER control_planner_needs_you_items_guard ON control_planner_needs_you_items;
DROP FUNCTION guard_planner_needs_you_item_insert();
DROP TABLE control_planner_needs_you_items;
DROP TRIGGER control_planner_failure_counters_no_truncate ON control_planner_failure_counters;
DROP TRIGGER control_planner_failure_counters_no_delete ON control_planner_failure_counters;
DROP TRIGGER control_planner_failure_counters_guard ON control_planner_failure_counters;
DROP FUNCTION guard_planner_failure_counter_write();
DROP TABLE control_planner_failure_counters;
COMMIT;
