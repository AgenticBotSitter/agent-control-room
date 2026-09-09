-- OFFLINE OPERATOR SETUP ONLY. Fresh NOLOGIN role; never run by startup.
-- Its private LOGIN may inherit only this role, without ADMIN or ownership.
BEGIN;
CREATE ROLE control_room_idea_creation NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_idea_creation;
GRANT SELECT ON workspaces, control_identities, control_role_grants, control_web_sessions,
  control_idea_sessions, control_idea_bot_run_events, control_idea_contributions, control_idea_syntheses,
  control_idea_decisions, control_idea_owner_authorizations, control_policy_decisions,
  projects, control_project_lifecycle_events, audit_events, control_audit_chain_heads TO control_room_idea_creation;
GRANT INSERT ON control_web_sessions, control_idea_sessions, control_idea_bot_run_events, audit_events, control_audit_chain_heads
  TO control_room_idea_creation;
GRANT INSERT ON control_policy_decisions, control_idea_owner_authorizations, control_idea_decisions,
  projects, control_project_lifecycle_events, control_idea_syntheses TO control_room_idea_creation;
GRANT UPDATE (web_lock) ON workspaces, control_identities, control_role_grants TO control_room_idea_creation;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_idea_creation;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_idea_creation;
COMMIT;
