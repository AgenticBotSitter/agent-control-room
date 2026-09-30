-- Down for 0208 only: the download grant ledger and the grants db/roles
-- conferred on it. It touches nothing 0206 or 0207 created: the two foreign
-- keys into the catalog are dropped with the table, and the revokes name only
-- this migration's own relation.
BEGIN;
-- One role at a time, one relation per statement: the upgrade baseline reads
-- each `EXECUTE 'REVOKE ...'` as a single privilege tuple, so a multi-object or
-- multi-role statement would be unreadable to it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (spent_at) ON control_result_file_download_grants FROM control_room_private_web';
    EXECUTE 'REVOKE INSERT ON control_result_file_download_grants FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON control_result_file_download_grants FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_application') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_application';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reader') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_reader';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_backup') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_backup';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_schedule_admissions') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_schedule_admissions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_github_broker') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_github_broker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_work_intake') THEN
    EXECUTE 'REVOKE ALL ON control_result_file_download_grants FROM control_room_work_intake';
  END IF;
END $$;
LOCK TABLE control_result_file_download_grants IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER control_result_file_download_grants_no_truncate ON control_result_file_download_grants;
DROP TRIGGER control_result_file_download_grants_no_delete ON control_result_file_download_grants;
DROP TRIGGER control_result_file_download_grants_update_guard ON control_result_file_download_grants;
DROP TRIGGER control_result_file_download_grants_guard ON control_result_file_download_grants;
DROP INDEX control_result_file_download_grants_session;
DROP TABLE control_result_file_download_grants;
DROP FUNCTION guard_result_file_download_grant_update();
DROP FUNCTION guard_result_file_download_grant_insert();
COMMIT;
