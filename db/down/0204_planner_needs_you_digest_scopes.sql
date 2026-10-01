BEGIN;
LOCK TABLE control_planner_needs_you_items IN ACCESS EXCLUSIVE MODE;

-- DATA REFUSING, on purpose. The column this migration added is NOT NULL with a
-- CHECK that it is a sha256 digest, and there is no honest value to put there on
-- the way down: the column answers "which description did the owner actually
-- ask for", and guessing one would let a future raise be justified by an
-- assertion this migration's down file invented. So a populated table refuses.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_planner_needs_you_items) THEN
    RAISE EXCEPTION 'planner needs-you digest scopes down migration refused: rows exist and the digest cannot be reconstructed';
  END IF;
END $$;

-- REVOKE only what 0204 GRANTED. It granted nothing to any role: it revoked both
-- of its functions from PUBLIC, and the coordinator's EXECUTE on
-- planner_failure_scope_key lives in db/roles/task_coordinator_roles.sql because
-- a migration-issued grant is re-revoked by the last role file's
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC`. So there is
-- no role revoke here, and adding one would take back a privilege this file
-- never gave.
--
-- 0202's guard body is restored verbatim, including the fact that 0202's version
-- was NOT SECURITY DEFINER -- 0204 made it so in order to call
-- planner_failure_scope_key with the trigger's owner's rights. Restoring it
-- means restoring that too, or the rollback would leave a definer function
-- where the pre-0204 database had an invoker one.
CREATE OR REPLACE FUNCTION public.guard_planner_needs_you_item_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.failure_count<2 OR NEW.reason_code<>'orchestrator_failed_twice'
    OR NEW.id<>'planner-needs-you:' || substring(pg_catalog.md5(
      NEW.tenant_id || '/' || NEW.project_id || '/' || NEW.request_key) from 1 for 32)
    OR NOT EXISTS (SELECT 1 FROM public.control_identities i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.raised_by_identity_id
        AND i.actor_type='agent' AND i.state='active')
    OR NOT EXISTS (SELECT 1 FROM public.control_planner_failure_counters c
      WHERE c.tenant_id=NEW.tenant_id AND c.project_id=NEW.project_id
        AND c.failure_count>=NEW.failure_count AND c.cleared_at IS NULL
        AND c.scope_key LIKE '%:' || NEW.request_key) THEN
    RAISE EXCEPTION 'planner needs-you insert rejected';
  END IF;
  RETURN NEW;
END $$;

-- The guard no longer references the scope function, so it goes before the
-- function does rather than after.
DROP FUNCTION public.planner_failure_scope_key(text, jsonb);

-- The column last: the restored guard above does not read it, but nothing else
-- may be holding a dependency on it that this file cannot see.
ALTER TABLE public.control_planner_needs_you_items
  DROP COLUMN owner_request_digest;
-- NOT AN OWNER ROLLBACK PATH. Like every down file here it leaves the applier's
-- ledger rows in place, so the ledger still claims the up file is applied, and
-- down-then-up does not restore column positions, which both schema digests
-- include (review round 5, R5-L1). Disposable clusters only; a real rollback is a
-- restore from backup.
COMMIT;