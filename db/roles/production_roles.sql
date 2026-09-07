-- Run as the database owner after migrations. Login roles are deployment-specific
-- and inherit exactly one of these NOLOGIN group roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN CREATE ROLE control_room_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_application') THEN CREATE ROLE control_room_application NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_reader') THEN CREATE ROLE control_room_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_backup') THEN CREATE ROLE control_room_backup NOLOGIN; END IF;
END;
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO control_room_application, control_room_reader, control_room_backup;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO control_room_application;
GRANT DELETE ON projects, work_items, executions, blockers, attention_items, machine_nodes, worker_runtimes, agent_identities
  TO control_room_application;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO control_room_reader, control_room_backup;

REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events, projection_changes, command_receipts, control_transition_events,
  control_policy_decisions, control_approval_consumptions, control_audit_anchors,
  node_protocol_replay
  FROM control_room_application, control_room_reader, control_room_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
  FROM control_room_reader, control_room_backup;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM control_room_application, control_room_reader, control_room_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM control_room_application, control_room_reader, control_room_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM control_room_application, control_room_reader, control_room_backup;
