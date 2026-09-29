BEGIN;
LOCK TABLE installation_operations_mode_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM installation_operations_mode_revisions) THEN
    RAISE EXCEPTION '0155 down migration refused: recorded operations mode revisions exist';
  END IF;
END $$;
DROP VIEW installation_effective_operations_mode;
DROP POLICY installation_operations_mode_revisions_work_intake_scope ON installation_operations_mode_revisions;
DROP POLICY installation_operations_mode_revisions_existing_access ON installation_operations_mode_revisions;
DROP TRIGGER installation_operations_mode_revisions_no_truncate ON installation_operations_mode_revisions;
DROP TRIGGER installation_operations_mode_revisions_immutable ON installation_operations_mode_revisions;
DROP TRIGGER installation_operations_mode_revisions_guard ON installation_operations_mode_revisions;
DROP FUNCTION guard_installation_operations_mode_insert();
DROP INDEX installation_operations_mode_revisions_current;
DROP TABLE installation_operations_mode_revisions;
COMMIT;
