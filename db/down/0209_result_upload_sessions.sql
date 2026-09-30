-- Down for 0209 only. It removes exactly what 0209 created and granted: the
-- three tables, the four triggers on them, the two guard functions and the role
-- grants db/roles conferred. It touches nothing 0210 or 0211 added.
--
-- 0210's and 0211's triggers and tables reference 0209's, so a downgrade that
-- reached here with those still applied would be refused by PostgreSQL with
-- 2BP01 — which is the correct refusal, and why down files run newest-first:
-- db/down/0211_job_artifact_inputs.sql and db/down/0210_result_upload_publication.sql
-- have both already run by the time this one executes.
BEGIN;
-- One role at a time, one relation per statement: the upgrade baseline reads
-- each `EXECUTE 'REVOKE ...'` as a single privilege tuple, so a multi-object or
-- multi-role statement would be unreadable to it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_task_declared_outputs FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_task_declared_outputs FROM control_room_fleet_gateway';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_task_declared_outputs FROM control_room_private_web';
  END IF;
  -- The upload tables are NOT granted to any role in 0209's own role files: the
  -- gateway reads and writes them through its own store, and the web login reads
  -- them for the owner's project view, so both grants are installed by the role
  -- files and revoked by db/down/0210_result_upload_publication.sql and
  -- db/down/0211_job_artifact_inputs.sql, which is where 0209's tables first
  -- appear in those role files.
  --
  -- The CATALOG SELECT is the exception, and it belongs to this file rather than
  -- to 0211's, because it exists for 0209 and only for 0209. 0209's reservation
  -- guard is SECURITY INVOKER and reads control_result_file_sets and
  -- control_result_files to pin an upload to the owner's approved row, so 0209
  -- is the migration that makes those two privileges load-bearing. 0210's guards
  -- are the same shape but its tables are its own, and 0211 has no catalog
  -- guard at all - its bindings are derived from the rows a caller supplies.
  -- Revoking it here is what returns the database to the state 0208 left, and the
  -- downgrade test checks exactly that.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE SELECT ON control_result_file_sets FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_result_files FROM control_room_fleet_gateway';
  END IF;
END $$;
DROP TRIGGER control_result_upload_chunks_no_truncate ON control_result_upload_chunks;
DROP TRIGGER control_result_upload_chunks_no_delete ON control_result_upload_chunks;
DROP TRIGGER control_result_upload_chunks_no_update ON control_result_upload_chunks;
DROP TRIGGER control_result_upload_chunks_guard ON control_result_upload_chunks;
DROP TRIGGER control_result_upload_sessions_no_truncate ON control_result_upload_sessions;
DROP TRIGGER control_result_upload_sessions_no_delete ON control_result_upload_sessions;
DROP TRIGGER control_result_upload_sessions_update_guard ON control_result_upload_sessions;
DROP TRIGGER control_result_upload_sessions_guard ON control_result_upload_sessions;
DROP TRIGGER control_task_declared_outputs_no_truncate ON control_task_declared_outputs;
DROP TRIGGER control_task_declared_outputs_no_delete ON control_task_declared_outputs;
DROP TRIGGER control_task_declared_outputs_no_update ON control_task_declared_outputs;
DROP TRIGGER control_task_declared_outputs_guard ON control_task_declared_outputs;
DROP INDEX control_result_upload_chunks_session;
DROP INDEX control_result_upload_sessions_open;
DROP INDEX control_result_upload_sessions_claim;
DROP INDEX control_task_declared_outputs_project;
DROP TABLE control_result_upload_chunks;
DROP TABLE control_result_upload_sessions;
DROP TABLE control_task_declared_outputs;
DROP FUNCTION guard_result_upload_chunk_insert();
DROP FUNCTION guard_result_upload_session_update();
DROP FUNCTION guard_result_upload_session_insert();
DROP FUNCTION guard_task_declared_output_insert();
COMMIT;
