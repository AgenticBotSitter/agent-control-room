-- Down for 0213_text_copy_derivation_grants.sql.
--
-- Revokes exactly what the up file granted, and nothing else. 0213 created TWO
-- views and granted SELECT on them to three roles; it created no table, no
-- function and no trigger, and it granted nothing on any pre-existing object.
-- So this revokes those three grants and drops the two views.
--
-- It deliberately does NOT touch control_text_copy_derivations: that table
-- belongs to 0212, and dropping it here would take away an object this migration
-- never created.
--
-- EVERY role REVOKE is guarded by an IF EXISTS on pg_roles, for the same reason
-- every GRANT in the up file is: this down file is applied on a BARE cluster
-- with no production roles, which is exactly what cook/v1's
-- tests/postgres-production-lifecycle.test.mjs does when it derives, at runtime,
-- every migration whose up file depends on an object a withheld down file
-- removes (dependentMigrationsV1). 0213's worker view joins
-- work_batch_queue_admissions (0104), so 0213 is pulled into that teardown set
-- and its down file runs where none of the three roles exist.
--
-- An UNCONDITIONAL `REVOKE ... FROM control_room_native_queue_worker` there
-- aborts the whole teardown with 42704 "role does not exist", which surfaces as
-- `deferred_partial_schema` and fails test:postgres-production the moment this
-- branch lands. 0208's down file was already guarded this way for the same
-- reason; this file simply forgot. One privilege tuple per EXECUTE, because the
-- upgrade baseline reads each `EXECUTE 'REVOKE ...'` as a single tuple.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_queue_worker') THEN
    EXECUTE 'REVOKE SELECT ON control_worker_text_copy_derivations FROM control_room_native_queue_worker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results') THEN
    EXECUTE 'REVOKE INSERT ON control_text_copy_derivations FROM control_room_native_results';
    EXECUTE 'REVOKE SELECT ON control_text_copy_derivations FROM control_room_native_results';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'REVOKE SELECT ON control_project_text_copy_derivations FROM control_room_private_web';
  END IF;
END $$;

-- Newest-first teardown order: the two views go before the table 0213's worker
-- view reads (work_batch_queue_admissions, 0104) and before the 0212 table.
-- DROP VIEW IF EXISTS is always valid, so these need no guard.
DROP VIEW IF EXISTS control_project_text_copy_derivations;
DROP VIEW IF EXISTS control_worker_text_copy_derivations;

COMMIT;