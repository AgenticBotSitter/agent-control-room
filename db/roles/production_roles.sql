-- Production group roles. Run as the bootstrap superuser with CREATEROLE
-- privilege during the #63 bootstrap phase. The login roles (control_room_migrator,
-- control_room_app, control_room_scheduler) are created by apply-migrations.mjs
-- directly with passwords from CONTROL_ROOM_*_PASSWORD env. The group roles here
-- define the privilege classes: control_room_application (app + writer),
-- control_room_reader (read-only web), control_room_backup (read-only backup),
-- control_room_schedule_admissions (the narrow #120 scheduler service role).
-- Table-level grants live in db/roles/production_table_grants.sql and run as
-- the schema owner during the migrate phase.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_migrator') THEN CREATE ROLE control_room_migrator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_application') THEN CREATE ROLE control_room_application NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_reader') THEN CREATE ROLE control_room_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_backup') THEN CREATE ROLE control_room_backup NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_schedule_admissions') THEN CREATE ROLE control_room_schedule_admissions NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_room_github_broker') THEN CREATE ROLE control_room_github_broker NOLOGIN; END IF;
END;
$$;
