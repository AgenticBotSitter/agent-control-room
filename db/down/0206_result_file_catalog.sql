-- Down for 0206 only. It removes exactly what 0206 created and granted, and
-- touches nothing 0207 or 0208 added. Those two are applied before this runs in
-- a normal downgrade, so their triggers are dropped first (a trigger cannot
-- outlive the table it guards) and restored afterwards.
BEGIN;
-- 0207's triggers on the 0206 tables, and 0206's own. Dropped before the tables
-- so no DROP TABLE is blocked by a dependent trigger, then 0207's are recreated
-- below so a database left at 0207/0208 still has the guards 0207 installed.
DROP TRIGGER control_result_file_sets_acceptance_guard ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_producer_guard ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_complete ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_no_truncate ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_no_delete ON control_result_file_sets;
DROP TRIGGER control_result_file_sets_guard ON control_result_file_sets;
DROP TRIGGER control_result_files_update_guard ON control_result_files;
DROP TRIGGER control_result_files_guard ON control_result_files;
DROP TRIGGER control_result_files_no_truncate ON control_result_files;
DROP TRIGGER control_result_files_no_delete ON control_result_files;

-- The grants db/roles conferred on the 0206 tables, revoked one role at a time
-- before the tables go, so a REVOKE never names a relation this file is about to
-- drop. Each REVOKE names a single object and a single role: the upgrade
-- baseline reads them as one privilege tuple each, so a multi-object or
-- multi-role statement would be silently unreadable to it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (retention_state, accepted_at, accepted_by_identity_id, retained_until) ON control_result_file_sets FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON control_result_file_sets FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON control_result_files FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    EXECUTE 'REVOKE UPDATE (state, stored_at, manifest_digest) ON control_result_file_sets FROM control_room_native_results';
    EXECUTE 'REVOKE UPDATE (state, stored_at) ON control_result_files FROM control_room_native_results';
    EXECUTE 'REVOKE INSERT ON control_result_file_sets FROM control_room_native_results';
    EXECUTE 'REVOKE INSERT ON control_result_files FROM control_room_native_results';
    EXECUTE 'REVOKE SELECT ON control_result_file_sets FROM control_room_native_results';
    EXECUTE 'REVOKE SELECT ON control_result_files FROM control_room_native_results';
  END IF;
  -- The blanket `ON ALL TABLES` grants in production_table_grants.sql reach
  -- these tables, and 0206's edit to that file is what 0206 granted. Released
  -- here for the same reason 0195's is.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_application') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_application';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_application';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reader') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_reader';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_reader';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_backup') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_backup';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_backup';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_schedule_admissions') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_schedule_admissions';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_schedule_admissions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_github_broker') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_github_broker';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_github_broker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_sets FROM control_room_work_intake';
    EXECUTE 'REVOKE ALL ON control_result_files FROM control_room_work_intake';
  END IF;
END $$;

LOCK TABLE control_result_files, control_result_file_sets IN ACCESS EXCLUSIVE MODE;
DROP INDEX control_result_files_project;
DROP INDEX control_result_files_set;
DROP INDEX control_result_file_sets_project;
DROP INDEX control_result_file_sets_quota;
DROP TABLE control_result_files;
DROP TABLE control_result_file_sets;
DROP FUNCTION guard_result_file_update();
DROP FUNCTION guard_result_file_insert();
DROP FUNCTION guard_result_file_set_write();
DROP FUNCTION enforce_result_file_set_complete();

-- 0207's guards, restored on the relation they guarded.
CREATE TRIGGER control_result_file_sets_acceptance_guard BEFORE UPDATE ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_set_acceptance();
CREATE TRIGGER control_result_file_sets_producer_guard BEFORE INSERT ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_set_producer();
COMMIT;
