-- MIG-A (plan v4.3 §2.1): make the current-split-suggestion read TENANT-BOUND.
--
-- 0200's own header is the reason this file exists:
--
--   "Confine the shared intake login to the bound tenant ... Without this the
--    login's SELECT on the new table would be EVERY tenant's suggestions."
--
-- That RESTRICTIVE policy is the ONLY thing confining control_room_work_intake
-- on work_batch_split_suggestions. 0200 then granted that same login SELECT on
-- work_batch_current_split_suggestions, a plain VIEW whose owner is
-- control_room_schema_owner -- the table's own owner, and therefore exempt from
-- RLS. The view has no tenant predicate, so it reads the base table with no row
-- policy applied at all. The confinement 0200 installed is bypassed by the very
-- view 0200 shipped to read it back.
--
-- Measured before this file (two real tenants, the intake login bound to A):
--
--   base-table rows of B = 0     work_batches rows of B = 0     VIEW rows of B = 1
--   leaked proposal text contains the other tenant's title = true
--
-- So the shared intake login could read every tenant's full proposal text,
-- request keys and integrity tags. A single-tenant Mac install is unaffected;
-- any shared database is not.
--
-- THE FIX, and why it is a predicate rather than a REVOKE.
--
-- 0200 granted the view to the intake login on purpose: the orchestrator appends
-- one suggestion and must read back the CURRENT one, because a stale suggestion
-- must not be readable back as if it were live. Dropping the grant would break
-- the read-back the coordinator's own re-split path depends on. So the grant
-- stays and the VIEW gains the same predicate 0200 put on the table.
--
-- The predicate is deliberately the TABLE's own, not a paraphrase of it, so
-- there is one written-down rule for "which suggestions is the work-intake
-- login allowed to see" and the view cannot drift away from it. It reaches
-- exactly the two facts 0200's policy reached: the row is the bound tenant's,
-- and the batch it belongs to is one the bound identity actually proposed.
--
-- WHY NOT `security_invoker = true`, which would make the view obey the base
-- table's RLS directly and could not be edited back into this hole?
--
-- Because a view with that reloption runs with the CALLER's rights, and the owner
-- web login holds NO grant at all on work_batch_split_suggestions -- by design:
-- 0200's comment is that it "holds NO privilege at all on the base table, so no
-- web path can enumerate a stale suggestion, insert one, or reach another
-- project." Turning the reloption on would make the owner login's read fail with
-- permission denied, and the only way to make it pass again is to grant it the
-- base table. That grant would be a NEW cross-tenant hole rather than a fix: the
-- RESTRICTIVE policy's USING arm is `NOT is_work_intake_session() OR (...)`, so
-- for a non-intake session it is unconditionally TRUE and the web login would
-- read every tenant's suggestions at the base table. The owner path's tenancy is
-- enforced in the application BEFORE any SQL runs (every store method takes the
-- authenticated owner's tenant and compares it to its own scope), and it is not
-- the path that leaked. Fixing the intake login by widening the owner login is
-- the wrong trade in both directions at once, so it is not made.
--
-- What holds the shape instead: the predicate is one function, and both the
-- table's policy and the view call it. Deleting the predicate call from the view
-- is a one-line diff a reviewer sees; the mutation suite in
-- scripts/orchui-mutations.sh removes the predicate from the view's WHERE
-- clause and requires the real-PostgreSQL cross-tenant test to fail.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- One predicate, one definition, used by BOTH the view and 0200's policy.
-- SECURITY DEFINER so the predicate can be evaluated for a login that holds no
-- grant on work_batches or work_intake_tenant_binding. It is deliberately NOT a
-- window onto those tables: it takes three values the CALLER already holds (they
-- come from a row the caller is asking about) and returns ONE boolean, so it
-- cannot be used to enumerate tenants, batches or proposers. STABLE, because it
-- reads no more than one statement's snapshot of two tables, and the planner
-- may call it more than once per row.
--
-- `session_user` -- not `current_user` -- is what makes this correct inside the
-- view: the view runs as the schema owner, but `session_user` is still the login
-- that issued the query, so is_work_intake_session() answers for the real caller.
CREATE FUNCTION public.work_intake_split_suggestion_visible(row_tenant text, row_batch text,
  row_proposer text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT public.is_work_intake_session() OR EXISTS (
    SELECT 1 FROM public.work_intake_tenant_binding b
    WHERE b.tenant_id=row_tenant
      AND EXISTS (SELECT 1 FROM public.work_batches w
        WHERE w.tenant_id=row_tenant AND w.id=row_batch AND w.proposed_by_identity_id=row_proposer));
$$;
REVOKE ALL ON FUNCTION public.work_intake_split_suggestion_visible(text, text, text) FROM PUBLIC;
COMMENT ON FUNCTION public.work_intake_split_suggestion_visible(text, text, text) IS
  'Whether a work-intake session may see this split-suggestion row. The single definition of that rule, called by both 0200''s RESTRICTIVE row policy and 0203''s view predicate. Returns one boolean about one row, never a row.';

-- Fold the same function into 0200's policy so the table and the view cannot
-- express the rule differently. The policy body is otherwise unchanged, so
-- every arm 0200 already proved (no binding, no matching batch, another tenant,
-- another identity's batch) is the same arm; only its spelling moves.
DROP POLICY work_batch_split_suggestions_work_intake_scope ON public.work_batch_split_suggestions;
CREATE POLICY work_batch_split_suggestions_work_intake_scope ON work_batch_split_suggestions
  AS RESTRICTIVE FOR ALL
  USING (public.work_intake_split_suggestion_visible(work_batch_split_suggestions.tenant_id,
    work_batch_split_suggestions.batch_id, work_batch_split_suggestions.proposed_by_identity_id))
  WITH CHECK (public.work_intake_split_suggestion_visible(work_batch_split_suggestions.tenant_id,
    work_batch_split_suggestions.batch_id, work_batch_split_suggestions.proposed_by_identity_id));

-- The owner's read, with the predicate. Column list is byte-identical to 0200's,
-- which is what makes CREATE OR REPLACE legal and what keeps every existing
-- reader (the web store's listSuggestions and prefillForOwner, the intake store's
-- prefillForOwner) working against the same shape.
CREATE OR REPLACE VIEW work_batch_current_split_suggestions AS
  SELECT s.tenant_id, s.project_id, s.batch_id, s.id, s.request_key, s.base_revision,
    s.base_revision_digest, s.proposal, s.proposal_digest, s.suggestion_digest,
    s.proposed_by_identity_id, s.auth_tag, s.created_at,
    false AS starts_work, false AS grants_execution_authority
  FROM public.work_batch_split_suggestions s
  JOIN public.work_batches b ON b.tenant_id=s.tenant_id AND b.id=s.batch_id
  WHERE s.base_revision=b.version AND b.state='proposed'
    AND public.work_intake_split_suggestion_visible(s.tenant_id, s.batch_id, s.proposed_by_identity_id);

-- The GRANTS are unchanged, on purpose: 0200 granted both logins on this view and
-- both still may. What changed is that the intake login's SELECT is now bounded
-- to the tenant it is bound to, which is the invariant 0200 claimed to install
-- and this file actually installs.
--
-- NO FUNCTION GRANT IS MADE HERE, deliberately, and the reason is install order
-- rather than design taste. This file is a `migrate` entry; the role grant files
-- (`db/roles/*.sql`) are separate `grants` entries that run afterwards, and the
-- last of them ends with `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS
-- FROM PUBLIC`. A grant issued from this file therefore survives for the
-- migration run and is then re-revoked, and a fresh install and an upgraded one
-- end in the same broken state -- measured, not assumed: with the EXECUTE issued
-- here, the owner web login could not read its own tenant's current suggestion at
-- all ("permission denied for function
-- work_intake_split_suggestion_visible"). The two EXECUTE grants live where the
-- rest of the login's privileges live, in production_table_grants.sql (intake)
-- and private_web_roles.sql (owner).
--
-- Why BOTH logins need it, since the view runs with its OWNER's rights: a view's
-- WHERE clause is privilege-checked against `session_user`, not against the
-- view's owner. View ownership decides which rights the function's SELECT is
-- evaluated under; it does not exempt the caller from the EXECUTE check. Both
-- logins are exactly the two 0200 already granted the view to, so no third party
-- gains anything, and the function returns one boolean about three values the
-- caller already supplied -- it cannot enumerate tenants, batches or proposers,
-- and it cannot read a row the caller could not already read through the view.

-- A down migration is intentionally operator-authored and data refusing: it
-- revokes only what this file granted (the predicate's EXECUTE), restores 0200's
-- inline policy body, restores 0200's predicate-free view, and drops the
-- function. It restores the cross-tenant read this file closed, so the lead runs
-- it only on a disposable cluster, alongside 0200's own down file.
