-- Down for 0211 only. It removes exactly what 0211 created and granted: the two
-- tables, the readiness trigger on control_jobs, the two guard functions, and
-- the role grants db/roles conferred on 0210's and 0209's tables that appear
-- here first. It touches nothing 0209 or 0210 created.
--
-- The upload tables' grants live here rather than in db/down/0209 because this
-- is the file that first grants them: a down file revokes what its own up file
-- granted, and 0209's up file is a schema migration that confers no privileges
-- of its own. 0209's down file says the same thing from its side.
--
-- It runs first in a downgrade, so by the time 0210's and 0209's down files
-- execute, nothing references these tables.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT, INSERT ON control_task_declared_inputs FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT, INSERT ON control_job_artifact_inputs FROM control_room_private_web';
    -- The gateway-facing half of the upload path, and the owner's read of what
    -- has been promised. Both are granted by db/roles/fleet_gateway_roles.sql
    -- and db/roles/private_web_roles.sql for 0209-0211 together.
    EXECUTE 'REVOKE SELECT ON control_result_upload_sessions FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON control_result_upload_chunks FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    -- The gateway's whole authority over the upload path: reserve a session, send
    -- chunks, finalise, and read the declared outputs and bindings a claim needs.
    -- It holds NO INSERT on the declarations or the bindings, so a machine can
    -- neither write a plan nor bind a file to itself.
    EXECUTE 'REVOKE SELECT, INSERT ON control_result_upload_sessions FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT, INSERT ON control_result_upload_chunks FROM control_room_fleet_gateway';
    -- The catalog SELECT 0209's reservation guard needs. It is granted by the
    -- same role file for the same three migrations, so it is revoked here with
    -- them and not by 0209's down file, which owns the schema only.
    EXECUTE 'REVOKE SELECT ON control_result_file_sets FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_result_files FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_task_declared_outputs FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_task_declared_inputs FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT ON control_job_artifact_inputs FROM control_room_fleet_gateway';
  END IF;
END $$;
DROP TRIGGER control_jobs_artifact_inputs_complete ON control_jobs;
DROP TRIGGER control_job_artifact_inputs_no_truncate ON control_job_artifact_inputs;
DROP TRIGGER control_job_artifact_inputs_no_delete ON control_job_artifact_inputs;
DROP TRIGGER control_job_artifact_inputs_no_update ON control_job_artifact_inputs;
DROP TRIGGER control_job_artifact_inputs_guard ON control_job_artifact_inputs;
DROP TRIGGER control_task_declared_inputs_no_truncate ON control_task_declared_inputs;
DROP TRIGGER control_task_declared_inputs_no_delete ON control_task_declared_inputs;
DROP TRIGGER control_task_declared_inputs_no_update ON control_task_declared_inputs;
DROP TRIGGER control_task_declared_inputs_guard ON control_task_declared_inputs;
DROP INDEX control_job_artifact_inputs_producer;
DROP INDEX control_job_artifact_inputs_consumer;
DROP INDEX control_task_declared_inputs_producer;
DROP TABLE control_job_artifact_inputs;
DROP TABLE control_task_declared_inputs;
DROP FUNCTION guard_job_artifact_inputs_complete();
DROP FUNCTION guard_job_artifact_input_insert();
DROP FUNCTION guard_task_declared_input_insert();
COMMIT;
