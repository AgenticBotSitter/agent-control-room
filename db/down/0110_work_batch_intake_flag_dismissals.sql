BEGIN;
LOCK TABLE work_batch_intake_flag_dismissals IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batch_intake_flag_dismissals) THEN
    RAISE EXCEPTION 'work batch intake flag dismissal down migration refused: records exist';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON work_batch_intake_flag_dismissals FROM control_room_private_web';
  END IF;
END $$;
DROP TRIGGER work_batch_intake_flag_dismissals_no_truncate ON work_batch_intake_flag_dismissals;
DROP TRIGGER work_batch_intake_flag_dismissals_append_only ON work_batch_intake_flag_dismissals;
DROP TRIGGER work_batch_intake_flag_dismissals_guard ON work_batch_intake_flag_dismissals;
DROP FUNCTION guard_work_batch_intake_flag_dismissal_insert();
DROP TABLE work_batch_intake_flag_dismissals;
COMMIT;
