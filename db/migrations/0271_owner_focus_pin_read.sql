-- 0019's owner-focus pin table is read by the live operator-surface bundle, and
-- no Mac-local login was allowed to read it.
--
-- THE BUG THIS FIXES. OperatorSurfaceReadServiceV1.read() fires NINE reads in one
-- Promise.all (src/operator-surfaces/v1/read-service.ts:201-211) and the ninth is
-- `listOwnerFocus`, which SELECTs control_owner_focus_pins. The bundle runs on
-- the COORDINATOR's pool -- private-task-application.ts:50 constructs
-- `new OperatorSurfaceStoreV1(coordinator.database.client)` -- and
-- control_room_task_coordinator held no privilege on that table. Every read in
-- the bundle is correct, and the bundle still failed: GET /api/v1/operator-surface
-- answered with `42501 permission denied for table control_owner_focus_pins`
-- because one Promise.all branch rejected. Measured as the production
-- coordinator login on real PostgreSQL 17 with this tree's migrations:
-- `permission denied for table control_owner_focus_pins`.
--
-- The grant audit reported every grant correct the whole time, and would still
-- do so before this migration: the table appears nowhere in
-- deploy/postgres/desired-grants.json, because no db/roles/*.sql ever granted it
-- to a Mac-local role. A read that no shipped grant makes reachable is invisible
-- to a check that compares the catalogue against the desired set.
--
-- WHY THE COORDINATOR AND NOT THE WEB LOGIN. The bundle's own pool is the
-- coordinator's. Granting control_room_private_web the same SELECT would make the
-- read reachable for a login that does not run it, so nothing would be fixed and
-- the privilege would be a second, unused answer to the same question.
--
-- SCOPE. SELECT only, one table, one login. This is a P0/TODAY priority label the
-- owner set on a project -- it holds no authority, dispatches nothing and grants
-- no access -- and the pin row's own UNIQUE (tenant_id, project_id) and its
-- expires_at are what 0019 already enforces. No INSERT, UPDATE or DELETE: the
-- coordinator is a scheduler, and the pin is the owner's.
--
-- ABOUT THE EMPTY LIST. The read is reachable after this migration and will return
-- zero rows on a fresh installation, because the WRITE half of this feature is
-- not wired to anything: OperatorSurfaceStoreV1.applyAuthorizedOwnerFocus is
-- called only from AuthorizedOwnerFocusCommandServiceV1, which no production
-- composition constructs, and there is no route for it. So this migration makes an
-- existing, already-projected read actually load instead of throwing the whole
-- surface away. It does not add a way to set a pin -- that is separate work, and
-- this migration deliberately grants no write that would make a half-built feature
-- look finished.
--
-- Same convergence as 0237, 0238 and 0270: the role file is the authoritative
-- statement of the grant and is only read when the module is provisioned, so an
-- installation provisioned before this migration existed keeps the older ACL.
-- The role may not exist either -- several suites apply migrations to a role-less
-- database -- so the grant is guarded by its existence.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT SELECT ON control_owner_focus_pins TO control_room_task_coordinator';
  END IF;
END $$;