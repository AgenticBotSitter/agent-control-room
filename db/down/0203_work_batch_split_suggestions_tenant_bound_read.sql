BEGIN;
LOCK TABLE work_batch_split_suggestions IN ACCESS EXCLUSIVE MODE;

-- DATA REFUSING, on purpose. Restoring the predicate-free policy and view below
-- reinstates the cross-tenant read this migration closed, so rolling it back
-- hands every tenant's suggestions to the shared intake login. The refusal is
-- the honest answer to "would you like to do that": no, and not silently.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM work_batch_split_suggestions) THEN
    RAISE EXCEPTION 'split suggestions down migration refused: rows exist and would become readable across tenants';
  END IF;
END $$;

-- REVOKE only what 0203 GRANTED. 0203 itself granted NOTHING: it revoked the
-- predicate from PUBLIC and pointed the policy and the view at it, and the two
-- EXECUTE grants live in the role files (production_table_grants.sql for the
-- intake login, private_web_roles.sql for the owner) because a migration-issued
-- grant is re-revoked by the last role file's
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC`.
--
-- There is therefore NO revoke to perform here, and that is the point worth
-- stating: a down file that issues grants its up file never made is how a
-- rollback quietly widens a role. This one grants nothing.
--
-- 0200's inline policy body is restored verbatim, so every arm it proved (no
-- binding, no matching batch, another tenant, another identity's batch) comes
-- back with it -- only the SPELLING moves, from the predicate back to the
-- expanded EXISTS.
DROP POLICY work_batch_split_suggestions_work_intake_scope ON public.work_batch_split_suggestions;
CREATE POLICY work_batch_split_suggestions_work_intake_scope ON work_batch_split_suggestions
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR (
    work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b)
    AND EXISTS (SELECT 1 FROM public.work_batches w
      WHERE w.tenant_id=work_batch_split_suggestions.tenant_id
        AND w.id=work_batch_split_suggestions.batch_id
        AND w.proposed_by_identity_id=work_batch_split_suggestions.proposed_by_identity_id)))
  WITH CHECK (NOT public.is_work_intake_session() OR (
    work_batch_split_suggestions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b)
    AND EXISTS (SELECT 1 FROM public.work_batches w
      WHERE w.tenant_id=work_batch_split_suggestions.tenant_id
        AND w.id=work_batch_split_suggestions.batch_id
        AND w.proposed_by_identity_id=work_batch_split_suggestions.proposed_by_identity_id)));

-- 0200's predicate-free view. The column list is byte-identical, which is what
-- makes CREATE OR REPLACE legal and what keeps every existing reader working
-- against the same shape.
CREATE OR REPLACE VIEW work_batch_current_split_suggestions AS
  SELECT s.tenant_id, s.project_id, s.batch_id, s.id, s.request_key, s.base_revision,
    s.base_revision_digest, s.proposal, s.proposal_digest, s.suggestion_digest,
    s.proposed_by_identity_id, s.auth_tag, s.created_at,
    false AS starts_work, false AS grants_execution_authority
  FROM public.work_batch_split_suggestions s
  JOIN public.work_batches b ON b.tenant_id=s.tenant_id AND b.id=s.batch_id
  WHERE s.base_revision=b.version AND b.state='proposed';

-- Last, because both objects above still reference it.
DROP FUNCTION public.work_intake_split_suggestion_visible(text, text, text);
COMMIT;