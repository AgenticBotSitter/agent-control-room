BEGIN;
-- 0153 alone: the owner-reported database-cluster observation. A recorded
-- observation is evidence the owner gathered about their own machine, so the
-- down path refuses while one exists. It revokes only its own two grants and
-- drops only its own objects; 0150, 0151, 0152 and 0154 are untouched.
LOCK TABLE pipeline_machine_capacity_observations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_machine_capacity_observations) THEN
    RAISE EXCEPTION 'pipeline machine capacity down migration refused: observations exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE INSERT ON pipeline_machine_capacity_observations FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON pipeline_machine_capacity_observations FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE SELECT ON pipeline_machine_capacity_observations FROM control_room_task_coordinator';
  END IF;
END $$;
DROP POLICY pipeline_machine_capacity_observations_work_intake_scope ON pipeline_machine_capacity_observations;
DROP POLICY pipeline_machine_capacity_observations_existing_access ON pipeline_machine_capacity_observations;
DROP TRIGGER pipeline_machine_capacity_observations_no_truncate ON pipeline_machine_capacity_observations;
DROP TRIGGER pipeline_machine_capacity_observations_immutable ON pipeline_machine_capacity_observations;
DROP TABLE pipeline_machine_capacity_observations;
COMMIT;
