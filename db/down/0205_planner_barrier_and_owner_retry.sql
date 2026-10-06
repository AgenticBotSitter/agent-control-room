BEGIN;
LOCK TABLE control_planner_needs_you_items, control_planner_failure_counters IN ACCESS EXCLUSIVE MODE;

-- DATA REFUSING, on purpose, and this one refuses the LOUDEST of the three. 0205
-- closed three real holes: the cross-tenant error-channel read (the six barriers),
-- the per-press Needs-you flood (the unique index on the escalating scope), and
-- the permanent lockout of a twice-failed description (the owner retry). Its down
-- reopens all three. Rolling it back on a database carrying evidence is how an
-- operator loses a fact they cannot recover, so the refusal is the honest default.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_planner_needs_you_items) THEN
    RAISE EXCEPTION 'planner barrier and owner retry down migration refused: needs-you rows exist';
  END IF;
  IF EXISTS (SELECT 1 FROM control_planner_failure_counters WHERE failure_count>0) THEN
    RAISE EXCEPTION 'planner barrier and owner retry down migration refused: live failures exist';
  END IF;
END $$;

-- REVOKE only what 0205 GRANTED. It granted EXECUTE to nobody from this file: the
-- coordinator's and the owner's EXECUTE on control_room_planner_grant_owner_retry
-- live in db/roles/task_coordinator_roles.sql and db/roles/private_web_roles.sql,
-- because the last role file ends with
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC` and a
-- migration-issued grant is re-revoked by it. Measured, not assumed: the guarded
-- version of 0205 granted the function and every call failed 42501.
--
-- So this file revokes no role privilege. PUBLIC's EXECUTE on the three functions
-- 0205 created is not restored either, because they are all dropped below and a
-- default privilege is not a grant to bring back.

-- 1. The owner-retry operation goes first: nothing else references it.
DROP FUNCTION public.control_room_planner_grant_owner_retry(text, text, text[]);

-- 2. The latch column, its CHECK and its index go before the guard function is
--    restored below, because 0205's guard reads `owner_retry_cleared_at` and
--    0202's does not: dropping the column first is what lets the restore below be
--    the pre-0205 body rather than one with a dangling reference. A spent latch is
--    NULL by design, so there is nothing here to recover -- the honest state after
--    a rollback is that a retry cannot be re-spent, on a database that no longer
--    records that it was spent.
DROP INDEX public.control_planner_failure_counters_owner_retry;
ALTER TABLE public.control_planner_failure_counters
  DROP CONSTRAINT control_planner_failure_counters_retry_check;
ALTER TABLE public.control_planner_failure_counters
  DROP COLUMN owner_retry_cleared_at;

-- 3. The owner-facing view, BEFORE the column it reads. 0205 ADDED `scope_key` to
--    0202's column list, and a column list is not removable by replacement, so the
--    view has to be dropped and recreated at 0202's shape -- WITHOUT the barrier,
--    because a plain view is what 0202 had and a barrier that outlives its reason
--    is not a safe thing to hand an operator. Order matters: while this view still
--    selects `scope_key`, PostgreSQL refuses the DROP COLUMN with "other objects
--    depend on it", which is the database being right and this file being wrong
--    about the order.
DROP VIEW public.control_planner_open_needs_you;
CREATE VIEW public.control_planner_open_needs_you AS
  SELECT s.tenant_id, s.project_id, s.id, s.request_key, s.reason_code, s.failure_count,
    s.raised_by_identity_id, s.raised_at, s.action_item_id,
    false AS starts_work, false AS grants_execution_authority
  FROM public.control_planner_needs_you_items s;
--
-- AND IT MUST BE RE-OWNED, because "whoever ran this file" is not always the
-- schema owner. The applier runs migrations as control_room_migrator with SET
-- ROLE control_room_schema_owner, so there the view comes out right -- but an
-- operator who rolls back as their superuser (the obvious way, and the way the
-- other files in db/down are read) would leave it owned by the superuser. The
-- applier then refuses the whole install with `migration_refused_non_owner_objects`,
-- so a rollback done the obvious way poisons the database for the next apply.
-- Measured on a fresh 153-migration install, this file run twice: as the schema
-- owner, 0 views not owned by it; as the superuser, 1 (`control_planner_open_needs_you`
-- owner=postgres).
--
-- `ALTER VIEW ... OWNER TO` does not touch the view's definition, so the schema
-- digest is unaffected (asserted by tests/down-migration-owner-real-postgres.test.ts).
--
-- The owner is READ FROM A SIBLING OBJECT, not from this view: by this point the
-- view's own owner IS the wrong one. The table it selects from
-- (control_planner_needs_you_items) was created by 0202 and is untouched by this
-- file, so its owner is the schema owner on any install, whatever role ran the
-- rollback. An earlier attempt read the owner off the recreated view itself and
-- therefore read back `fixture_admin` -- the role that just created it -- which
-- fixed nothing; that was caught by running the file as the superuser, which is
-- the only way to see it.
DO $$ DECLARE
  schema_owner text;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO STRICT schema_owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'control_planner_needs_you_items';
  EXECUTE format('ALTER VIEW public.control_planner_open_needs_you OWNER TO %I', schema_owner);
EXCEPTION WHEN no_data_found THEN
  -- The table is not there either, so this cluster is not one 0202 built. The
  -- applier's own ownership check still refuses the install; this must not be the
  -- thing that fails, because there is nothing to re-own.
  NULL;
END $$;
--
-- THE DROP DISCARDS THE VIEW'S GRANTS: the recreated view is a new relation with a
-- NULL ACL (measured in review round 5). An earlier draft said 0202's SELECT grant
-- "survives the DROP/CREATE"; it does not. So 0202's own grant is re-issued here,
-- in 0202's own guarded form, because restoring 0202's view means restoring the
-- privilege 0202 gave on it -- and the role files cannot be relied on to do it on
-- a rolled-back database, since they name 0205's function and fail 42883 there.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT ON public.control_planner_open_needs_you TO control_room_private_web';
  END IF;
END $$;
--
-- 0202's counter guard, verbatim. The scope unique index must go before the column
-- it is built on, or the DROP COLUMN would cascade into it and the restore below
-- would be missing an object 0202's database had.
DROP INDEX public.control_planner_needs_you_scope_unique;
ALTER TABLE public.control_planner_needs_you_items
  ALTER COLUMN scope_key DROP NOT NULL;
ALTER TABLE public.control_planner_needs_you_items
  DROP COLUMN scope_key;

CREATE OR REPLACE FUNCTION public.guard_planner_failure_counter_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.failure_count<>1 OR NEW.cleared_at IS NOT NULL OR NEW.last_failure_at IS NULL THEN
      RAISE EXCEPTION 'planner failure counter insert rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.version<>OLD.version+1
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'planner failure counter update rejected';
  END IF;
  IF NEW.failure_count=OLD.failure_count+1
    AND NEW.last_failure_at IS NOT NULL AND NEW.cleared_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.failure_count=0 AND NEW.cleared_at IS NOT NULL
    AND NEW.last_failure_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'planner failure counter update rejected';
END $$;

-- 0204's Needs-you insert guard, verbatim. 0205 replaced it with a body that reads
-- NEW.scope_key, and the column is dropped above; a plpgsql body is not
-- dependency-tracked, so without this the rolled-back database kept 0205's guard
-- and every Needs-you raise failed at run time with "record new has no field
-- scope_key". Found while adding the stacked rollback test (fix round 5); the
-- earlier version of this file left it behind.
CREATE OR REPLACE FUNCTION public.guard_planner_needs_you_item_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  project_key text;
  request_key_initial text;
  request_key_resplit text;
BEGIN
  project_key := public.planner_failure_scope_key('project', jsonb_build_object(
    'kind', 'initial', 'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text,
    'ownerRequest', NEW.owner_request_digest));
  request_key_initial := public.planner_failure_scope_key('initial', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  request_key_resplit := public.planner_failure_scope_key('resplit', jsonb_build_object(
    'tenantId', NEW.tenant_id::text, 'projectId', NEW.project_id::text, 'requestKey', NEW.request_key::text));
  IF NEW.failure_count<2 OR NEW.reason_code<>'orchestrator_failed_twice'
    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.md5(
      NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.request_key) from 1 for 32)
    OR NOT EXISTS (SELECT 1 FROM public.control_identities i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.raised_by_identity_id
        AND i.actor_type='agent' AND i.state='active')
    -- The escalation must still be TRUE: a raise that does not match a live
    -- counter at or above the count it names is a caller inventing one. The
    -- counter is matched on the RAISED request, not merely the project, so one
    -- project's second failure cannot license another request's escalation.
    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL
        AND c.scope_key IN (project_key, request_key_initial, request_key_resplit)) THEN
    RAISE EXCEPTION 'planner needs-you insert rejected';
  END IF;
  RETURN NEW;
END $$;

-- 4. The five remaining barriers, each RESET -- the exact inverse of its ALTER VIEW
--    in 0205, because before 0205 these views carried NO reloption at all.
--    `SET (security_barrier = false)` turned the barrier off but left
--    `{security_barrier=false}` in reloptions, which a database that never ran 0205
--    does not have (review round 5, Q5). The sixth, control_planner_open_needs_you,
--    was dropped and recreated in step 3 without the option, so it needs nothing.
ALTER VIEW public.work_batch_current_split_suggestions RESET (security_barrier);
ALTER VIEW public.work_batch_effective_queue_admissions RESET (security_barrier);
ALTER VIEW public.pipeline_ordered_stage_runs RESET (security_barrier);
ALTER VIEW public.installation_effective_operations_mode RESET (security_barrier);
ALTER VIEW public.control_project_planner_selections RESET (security_barrier);
-- NOT AN OWNER ROLLBACK PATH. Like every down file here it leaves the applier's
-- ledger rows in place, and down-then-up restores everything except column
-- positions, which both schema digests include -- so the applier then refuses with
-- `migration_live_schema_drift` and every login refuses to start (review round 5,
-- R5-L1). Disposable clusters only; a real rollback is a restore from backup.
COMMIT;