-- Production least-privilege logins. Run as superuser with psql variables; secrets
-- stay outside the repository:
--   export MIGRATOR_PASSWORD APP_PASSWORD SCHEDULER_PASSWORD WORK_INTAKE_PASSWORD  # from the secret store
--   psql -v migrator_password="$MIGRATOR_PASSWORD" -v app_password="$APP_PASSWORD" \
--     -v scheduler_password="$SCHEDULER_PASSWORD" \
--     -v work_intake_password="$WORK_INTAKE_PASSWORD" \
--     -f db/roles/production_provision.sql "dbname=control_room user=postgres"
-- Complements db/roles/production_roles.sql (remaining NOLOGIN groups + table
-- grants, re-applied after every migration batch). This script is self-sufficient
-- on a genuinely empty cluster: it creates the four groups the logins depend on
-- (schema owner, application, schedule admissions, work intake) transactionally before the logins.
-- The schema owner group owns objects; the migrator login performs upgrades; the
-- application login serves traffic with no DDL. Fails closed when a password variable is
-- missing or shorter than 24 characters.
--
-- Secret handling: psql substitutes :'variables' only OUTSIDE dollar-quoted
-- bodies, so the passwords are staged into session settings first (SET prints
-- only a command tag, never the value) and consumed inside DO via
-- current_setting(). The settings are RESET at the end. Passwords never appear
-- in the repository, in shell history (when passed via -v from exported env),
-- or in psql output.
\set ON_ERROR_STOP on
-- Unset variable => interpolation error => abort before anything runs.
SET provision.migrator_pw TO :'migrator_password';
SET provision.app_pw TO :'app_password';
SET provision.scheduler_pw TO :'scheduler_password';
SET provision.work_intake_pw TO :'work_intake_password';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schema_owner') THEN
    CREATE ROLE control_room_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_application') THEN
    CREATE ROLE control_room_application NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schedule_admissions') THEN
    CREATE ROLE control_room_schedule_admissions NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_github_broker') THEN
    CREATE ROLE control_room_github_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_work_intake') THEN
    CREATE ROLE control_room_work_intake NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
DO $$
BEGIN
  IF length(current_setting('provision.migrator_pw')) < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_migrator_password';
  END IF;
  IF length(current_setting('provision.app_pw')) < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_app_password';
  END IF;
  IF length(current_setting('provision.scheduler_pw')) < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_scheduler_password';
  END IF;
  IF length(current_setting('provision.work_intake_pw')) < 24 THEN
    RAISE EXCEPTION 'provision_refused_short_work_intake_password';
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN
    EXECUTE format('CREATE ROLE control_room_migrator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L IN ROLE control_room_schema_owner',
      current_setting('provision.migrator_pw'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_app') THEN
    EXECUTE format('CREATE ROLE control_room_app LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L IN ROLE control_room_application',
      current_setting('provision.app_pw'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_scheduler') THEN
    EXECUTE format('CREATE ROLE control_room_scheduler LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L IN ROLE control_room_schedule_admissions',
      current_setting('provision.scheduler_pw'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_work_intake_agent') THEN
    EXECUTE format('CREATE ROLE control_room_work_intake_agent LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L IN ROLE control_room_work_intake',
      current_setting('provision.work_intake_pw'));
  END IF;
END;
$$;
RESET provision.migrator_pw;
RESET provision.app_pw;
RESET provision.scheduler_pw;
RESET provision.work_intake_pw;
-- Rotation / repair path (already outside dollar quotes, substitutes normally).
ALTER ROLE control_room_migrator PASSWORD :'migrator_password';
ALTER ROLE control_room_app PASSWORD :'app_password';
ALTER ROLE control_room_scheduler PASSWORD :'scheduler_password';
ALTER ROLE control_room_work_intake_agent PASSWORD :'work_intake_password';
GRANT control_room_schema_owner TO control_room_migrator;
GRANT control_room_application TO control_room_app;
GRANT control_room_schedule_admissions TO control_room_scheduler;
GRANT control_room_work_intake TO control_room_work_intake_agent;

-- Restricted services never need session-local relations. Remove PostgreSQL's
-- default PUBLIC grant first, then make the denial explicit for every service
-- group/login provisioned here. The database owner keeps its inherent owner
-- authority; the schema owner and migrator use only durable migration objects.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_application', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_app', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_schedule_admissions', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_scheduler', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_github_broker', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_work_intake', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM control_room_work_intake_agent', current_database());
END;
$$;
