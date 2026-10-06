-- Reverses 0243 only: the two per-tenant tables the recurring scheduler gained,
-- and the grant on them.
--
-- Revoke first, then drop. That order is not cosmetic -- `db/roles/
-- task_coordinator_roles.sql` grants these tables SELECT/INSERT/UPDATE on every
-- provision and upgrade, so a database whose stack is taken down to 0242 while
-- the role file still names the tables would be left with a grant on relations
-- that no longer exist. Dropping the tables first leaves that grant dangling and
-- the next grant reconciliation fails on a missing relation. Revoking first
-- leaves 0242's state exactly, and re-applying 0243 (or upgrading forward again)
-- restores the grant -- the down file reverses one migration, it does not rewrite
-- the authoritative statement.
--
-- NO OTHER OBJECT IS TOUCHED. 0186's proposals and rules tables, 0186's guards
-- and the ledger entries for them are 0186's to drop in 0186's own down file, and
-- this file drops nothing an earlier migration created. Both tables are
-- per-tenant scheduling facts and nothing else references them, so the
-- downgrade is unconditional: unlike 0186 there is no retained record whose
-- removal would destroy an owner-visible artefact, and refusing to downgrade
-- while a tenant merely has a cursor row would make the stack unreversible for
-- an ordinary install.
--
-- The claims table goes first, then the cursors, purely so the two names are
-- taken down in the order they were created. They are independent tables and
-- either order lands on the same state.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'REVOKE ALL ON control_recurring_proposal_claims, control_recurring_scan_cursors'
      ' FROM control_room_task_coordinator';
  END IF;
END $$;

DROP TABLE control_recurring_proposal_claims;
DROP TABLE control_recurring_scan_cursors;
