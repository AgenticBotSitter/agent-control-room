BEGIN;
-- 0150 alone: the one installation allowance record. A limit the owner has
-- already set is exactly the kind of state a down migration must not discard,
-- so the file refuses whenever the record exists.
LOCK TABLE pipeline_installation_allowances IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_installation_allowances) THEN
    RAISE EXCEPTION 'pipeline installation allowance down migration refused: limits are set';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE UPDATE (runs_per_hour, runs_per_agent_per_day, machine_max_agent_processes, machine_max_db_clusters, dollar_cap_microusd, owner_identity_id, version, record_digest, auth_tag, updated_at) ON pipeline_installation_allowances FROM control_room_private_web';
    EXECUTE 'REVOKE INSERT ON pipeline_installation_allowances FROM control_room_private_web';
    EXECUTE 'REVOKE SELECT ON pipeline_installation_allowances FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE UPDATE (coordinator_lock) ON pipeline_installation_allowances FROM control_room_task_coordinator';
  END IF;
END $$;
DROP POLICY pipeline_installation_allowances_work_intake_scope ON pipeline_installation_allowances;
DROP POLICY pipeline_installation_allowances_existing_access ON pipeline_installation_allowances;
DROP TRIGGER pipeline_installation_allowances_no_truncate ON pipeline_installation_allowances;
DROP TRIGGER pipeline_installation_allowances_no_delete ON pipeline_installation_allowances;
DROP TRIGGER pipeline_installation_allowances_guard ON pipeline_installation_allowances;
DROP TABLE pipeline_installation_allowances;
DROP FUNCTION guard_pipeline_installation_allowance_write();
COMMIT;
