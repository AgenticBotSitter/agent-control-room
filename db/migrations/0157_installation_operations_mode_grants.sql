-- Grants for the operations-mode record.
--
-- Every role named here is created by the module role files during provisioning,
-- which run AFTER the migrations — and several suites apply the migration files
-- to a role-less database. A bare GRANT or REVOKE would therefore fail on a
-- fresh install and in those suites, so each statement is guarded by the
-- existence of the role, the same shape 0046, 0054 and 0087 use for the
-- coordinator login.
--
-- The role files are the authoritative grants (private_web_roles.sql for the
-- owner session, production_table_grants.sql for the shared ledgers, the
-- reader and the backup role, task_coordinator_roles.sql for the coordinator),
-- so a fresh install and an upgrade converge on the same ACLs and neither is a
-- one-way door.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  -- The applier grants SELECT, INSERT and UPDATE on every table it creates to
  -- the application role, so an installation that upgrades this migration needs
  -- these two objects narrowed. The shared ledgers, the reader, the backup role,
  -- the schedule and broker roles and the work-intake login all read nothing
  -- here: this is an owner control, not shared state.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_application') THEN
    EXECUTE 'REVOKE ALL ON installation_operations_mode_revisions,'
      ' installation_effective_operations_mode FROM control_room_application,'
      ' control_room_reader, control_room_backup, control_room_schedule_admissions,'
      ' control_room_github_broker, control_room_work_intake';
  END IF;
  -- The owner session reads the mode and appends a revision. It holds no UPDATE
  -- or DELETE: a recorded decision is appended, never rewritten, and the 0155
  -- guard refuses anything but a live human owner.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON installation_operations_mode_revisions TO control_room_private_web';
    EXECUTE 'GRANT SELECT ON installation_effective_operations_mode TO control_room_private_web';
  END IF;
  -- The reader and the backup role read the mode. The backup role in particular
  -- must be able to capture it in a restore.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_reader') THEN
    EXECUTE 'GRANT SELECT ON installation_operations_mode_revisions,'
      ' installation_effective_operations_mode TO control_room_application,'
      ' control_room_reader, control_room_backup';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON installation_operations_mode_revisions TO control_room_task_coordinator';
  END IF;
END $$;
