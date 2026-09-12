-- OFFLINE OPERATOR SETUP ONLY. Startup verifies; it never applies this template.
-- A separate private LOGIN may inherit only this role, without ADMIN or ownership.
BEGIN;
CREATE ROLE control_room_news_ingestion NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_news_ingestion;
GRANT SELECT ON workspaces, projects, control_identities, control_role_grants,
  control_abs_story_versions, control_abs_source_observations, control_abs_discovery_baselines, control_abs_source_settings, control_abs_story_archives, control_abs_article_details TO control_room_news_ingestion;
GRANT INSERT ON control_abs_story_versions, control_abs_source_observations, control_abs_discovery_baselines, control_abs_article_details TO control_room_news_ingestion;
-- Row locks require a column UPDATE privilege. These lock columns grant no ability
-- to change project content, ownership, domain state, source metadata or identity grants.
GRANT UPDATE (web_lock) ON workspaces TO control_room_news_ingestion;
GRANT UPDATE (coordinator_lock) ON projects TO control_room_news_ingestion;
COMMIT;
