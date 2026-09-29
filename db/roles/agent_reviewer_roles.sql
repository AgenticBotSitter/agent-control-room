-- OFFLINE OPERATOR SETUP ONLY. One private LOGIN may inherit only this
-- narrowly scoped group role. It cannot plan, assign, run, approve or alter.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer') THEN
    CREATE ROLE control_room_agent_reviewer NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE control_room_agent_reviewer NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM control_room_agent_reviewer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM control_room_agent_reviewer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM control_room_agent_reviewer;
GRANT USAGE ON SCHEMA public TO control_room_agent_reviewer;
-- Exact review set: read the one bound plan and call the single authenticated
-- server-side commit. Both boundaries serve only the installation tenant. No
-- table privilege of any kind is granted, so no row of any tenant is readable.
GRANT EXECUTE ON FUNCTION read_agent_review_plan(text),
  commit_agent_review(text,jsonb,jsonb,bytea) TO control_room_agent_reviewer;
COMMIT;
