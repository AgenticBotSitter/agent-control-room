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
-- one-way door. The shared group roles (application, reader, backup, schedule,
-- broker, work intake) are deliberately not named here: the applier re-runs
-- production_table_grants.sql after every migration batch, which narrows them
-- on these objects, and the upgrade's role manifest pins the roles a migration
-- may name to the module logins below.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  -- The owner session reads the mode and appends a revision. It holds no UPDATE
  -- or DELETE: a recorded decision is appended, never rewritten, and the 0155
  -- guard refuses anything but a live human owner.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON installation_operations_mode_revisions TO control_room_private_web';
    EXECUTE 'GRANT SELECT ON installation_effective_operations_mode TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON installation_operations_mode_revisions TO control_room_task_coordinator';
  END IF;
  -- The fleet gateway creates claims too, and the 0156 claim guard reads the
  -- mode with the inserting login's privileges: without this read every fleet
  -- claim is refused, even while the installation is running.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') THEN
    EXECUTE 'GRANT SELECT ON installation_operations_mode_revisions TO control_room_fleet_gateway';
  END IF;
END $$;
