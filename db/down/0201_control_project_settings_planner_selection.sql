BEGIN;
LOCK TABLE control_project_settings IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_project_settings
      WHERE planner_mode<>'inherit' OR planner_worker_id IS NOT NULL) THEN
    RAISE EXCEPTION 'planner selection down migration refused: recorded selections exist';
  END IF;
END $$;
-- Only what 0201 granted.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (planner_mode, planner_worker_id, planner_worker_kind, planner_model, planner_effort) ON control_project_settings FROM control_room_private_web';
  END IF;
END $$;
DROP VIEW control_project_planner_selections;
ALTER TABLE control_project_settings
  DROP CONSTRAINT control_project_settings_planner_selection_coherent,
  DROP CONSTRAINT control_project_settings_planner_effort_check,
  DROP CONSTRAINT control_project_settings_planner_model_check,
  DROP CONSTRAINT control_project_settings_planner_worker_kind_check,
  DROP CONSTRAINT control_project_settings_planner_worker_id_check,
  DROP CONSTRAINT control_project_settings_planner_mode_check,
  DROP COLUMN planner_effort,
  DROP COLUMN planner_model,
  DROP COLUMN planner_worker_kind,
  DROP COLUMN planner_worker_id,
  DROP COLUMN planner_mode;
COMMIT;
