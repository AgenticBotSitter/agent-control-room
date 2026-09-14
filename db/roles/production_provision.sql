-- Production least-privilege logins. Run as superuser with psql variables; secrets
-- stay outside the repository:
--   psql -v migrator_password="$MIGRATOR_PASSWORD" -v app_password="$APP_PASSWORD" \
--     -v scheduler_password="$SCHEDULER_PASSWORD" \
--     -f db/roles/production_provision.sql "dbname=control_room user=postgres"
-- Complements db/roles/production_roles.sql (NOLOGIN groups + grants). The schema
-- owner group owns objects; the migrator login performs upgrades; the application
-- login serves traffic with no DDL. Fails closed when a password variable is empty.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schema_owner') THEN
    CREATE ROLE control_room_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
DO $$
BEGIN
  IF length(:'migrator_password') < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_migrator_password';
  END IF;
  IF length(:'app_password') < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_app_password';
  END IF;
  IF length(:'scheduler_password') < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_scheduler_password';
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN
    CREATE ROLE control_room_migrator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD :'migrator_password' IN ROLE control_room_schema_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_app') THEN
    CREATE ROLE control_room_app LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD :'app_password' IN ROLE control_room_application;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_scheduler') THEN
    CREATE ROLE control_room_scheduler LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
      PASSWORD :'scheduler_password' IN ROLE control_room_schedule_admissions;
  END IF;
END;
$$;
ALTER ROLE control_room_migrator PASSWORD :'migrator_password';
ALTER ROLE control_room_app PASSWORD :'app_password';
ALTER ROLE control_room_scheduler PASSWORD :'scheduler_password';
GRANT control_room_schema_owner TO control_room_migrator;
GRANT control_room_application TO control_room_app;
GRANT control_room_schedule_admissions TO control_room_scheduler;
