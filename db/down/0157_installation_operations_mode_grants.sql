BEGIN;
LOCK TABLE installation_operations_mode_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  -- Revoke exactly what this migration's up file granted, and nothing else: the
  -- REVOKE and the three GRANT sets. The role files own the rest of these
  -- objects' ACLs, and revoking those here would be an over-revoke of a live
  -- installation.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_application') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions,'
      ' installation_effective_operations_mode FROM control_room_application,'
      ' control_room_reader, control_room_backup, control_room_schedule_admissions,'
      ' control_room_github_broker, control_room_work_intake';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions FROM control_room_private_web';
    EXECUTE 'REVOKE ALL ON installation_effective_operations_mode FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reader') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions,'
      ' installation_effective_operations_mode FROM control_room_application,'
      ' control_room_reader, control_room_backup';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions FROM control_room_task_coordinator';
  END IF;
END $$;
COMMIT;
