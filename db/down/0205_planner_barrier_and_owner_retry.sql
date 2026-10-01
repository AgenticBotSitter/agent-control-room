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
-- So this file revokes no role privilege, and the function's PUBLIC revoke below
-- only restores the state 0205 removed (PUBLIC held EXECUTE on everything by
-- default until then).

-- 1. The owner-retry operation goes first: nothing else references it.
DROP FUNCTION public.control_room_planner_grant_owner_retry(text, text, text[]);

-- 2. The latch column goes before the CHECK that constrains it, and the index that
--    reads it goes before the column. The column is NOT NULL-free by design (a
--    spent latch is NULL), so nothing else here is recoverable and nothing else is
--    dropped: the only rollback of a spent retry is that the retry cannot be
--    re-spent, which is the honest state for a database that no longer records it.
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
-- 0202's SELECT grant on this view survives the DROP/CREATE because the recreated
-- view has the same owner and the same name, so no grant statement is needed -- and
-- none is issued, because this up file never granted it.
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

-- 4. The five remaining barriers, each `SET (security_barrier = false)` the exact
--    inverse of its ALTER VIEW in 0205. The sixth,
--    control_planner_open_needs_you, was dropped and recreated in step 4 already
--    WITHOUT the barrier, so setting it false here would be a no-op on an option
--    that is already off; leaving the statement out is the honest count, and the
--    six-barrier claim in the comment above names all six of 0205's.
ALTER VIEW public.work_batch_current_split_suggestions SET (security_barrier = false);
ALTER VIEW public.work_batch_effective_queue_admissions SET (security_barrier = false);
ALTER VIEW public.pipeline_ordered_stage_runs SET (security_barrier = false);
ALTER VIEW public.installation_effective_operations_mode SET (security_barrier = false);
ALTER VIEW public.control_project_planner_selections SET (security_barrier = false);
COMMIT;