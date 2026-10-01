-- Reverses only what 0217 granted. Each REVOKE sits inside a role-existence
-- check so this file also runs on a database where the fleet roles were never
-- installed: a Mac-local install has no gateway at all.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_owner_authority') THEN
    EXECUTE 'REVOKE SELECT ON fleet_worker_agents, fleet_presence_transitions FROM control_room_fleet_owner_authority';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT ON fleet_worker_agents, fleet_presence_transitions FROM control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE UPDATE (presence_state,state_changed_at) ON fleet_worker_agents FROM control_room_task_coordinator';
    EXECUTE 'REVOKE UPDATE (presence_state,state_changed_at) ON fleet_worker_presence FROM control_room_task_coordinator';
    EXECUTE 'REVOKE INSERT ON fleet_presence_transitions FROM control_room_task_coordinator';
    EXECUTE 'REVOKE SELECT ON fleet_workers, fleet_worker_presence, fleet_worker_agents, fleet_presence_transitions'
      ' FROM control_room_task_coordinator';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'REVOKE UPDATE (session_id,presence_state,last_seen_at,connector_version,platform,state_changed_at,graceful_offline_at)'
      ' ON fleet_worker_presence FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE UPDATE (display_name,agent_kind,enabled,session_id,presence_state,last_reported_at,state_changed_at)'
      ' ON fleet_worker_agents FROM control_room_fleet_gateway';
    EXECUTE 'REVOKE SELECT, INSERT ON fleet_worker_agents, fleet_presence_transitions FROM control_room_fleet_gateway';
  END IF;
END $$;
COMMIT;
