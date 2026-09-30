BEGIN;
LOCK TABLE installation_operations_mode_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  -- Revoke exactly what this migration's up file granted, and nothing else: the
  -- owner session's and the coordinator's grants. The role files own the rest of these
  -- objects' ACLs, and revoking those here would be an over-revoke of a live
  -- installation.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions FROM control_room_private_web';
    EXECUTE 'REVOKE ALL ON installation_effective_operations_mode FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions FROM control_room_task_coordinator';
  END IF;
END $$;
COMMIT;
