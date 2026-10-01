-- MIG-F least-privilege grants. The gateway reports authenticated check-ins;
-- the coordinator-owned supervisor alone advances missed sessions to unreachable.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    GRANT SELECT, INSERT ON fleet_worker_agents, fleet_presence_transitions TO control_room_fleet_gateway;
    GRANT UPDATE (display_name,agent_kind,enabled,session_id,presence_state,last_reported_at,state_changed_at)
      ON fleet_worker_agents TO control_room_fleet_gateway;
    GRANT UPDATE (session_id,presence_state,last_seen_at,connector_version,platform,state_changed_at,graceful_offline_at)
      ON fleet_worker_presence TO control_room_fleet_gateway;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    GRANT SELECT ON fleet_workers, fleet_worker_presence, fleet_worker_agents, fleet_presence_transitions
      TO control_room_task_coordinator;
    GRANT INSERT ON fleet_presence_transitions TO control_room_task_coordinator;
    GRANT UPDATE (presence_state,state_changed_at) ON fleet_worker_presence TO control_room_task_coordinator;
    GRANT UPDATE (presence_state,state_changed_at) ON fleet_worker_agents TO control_room_task_coordinator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    GRANT SELECT ON fleet_worker_agents, fleet_presence_transitions TO control_room_private_web;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_owner_authority') THEN
    GRANT SELECT ON fleet_worker_agents, fleet_presence_transitions TO control_room_fleet_owner_authority;
  END IF;
END $$;
