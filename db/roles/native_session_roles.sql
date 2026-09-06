-- OFFLINE OPERATOR SETUP ONLY. Startup verifies; it never provisions this profile.
BEGIN;
CREATE ROLE control_room_native_sessions NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_native_sessions;
GRANT SELECT ON workspaces, control_identities, control_role_grants, control_nodes, control_node_keys,
  node_protocol_connections, node_protocol_replay TO control_room_native_sessions;
GRANT INSERT ON node_protocol_connections, node_protocol_replay TO control_room_native_sessions;
GRANT UPDATE (last_sequence,last_message_id,updated_at) ON node_protocol_connections TO control_room_native_sessions;
GRANT UPDATE (replay_lock) ON node_protocol_replay TO control_room_native_sessions;
COMMIT;
