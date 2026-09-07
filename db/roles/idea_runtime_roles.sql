-- OFFLINE OPERATOR SETUP ONLY. Startup verifies; it never applies this template.
-- A separate private LOGIN may inherit only this role, without ADMIN or ownership.
BEGIN;
CREATE ROLE control_room_idea_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_idea_runtime;
-- Identity/grant reads support the existing read-only preflight, not grant mutation.
GRANT SELECT ON workspaces, control_identities, control_role_grants,
  control_idea_sessions, control_idea_contributions, control_idea_bot_run_events, control_idea_decisions
  TO control_room_idea_runtime;
GRANT INSERT ON control_idea_contributions, control_idea_bot_run_events TO control_room_idea_runtime;
-- Stable workspace locking serializes ledger appends; immutable event rows stay immutable.
GRANT UPDATE (web_lock) ON workspaces TO control_room_idea_runtime;
COMMIT;
