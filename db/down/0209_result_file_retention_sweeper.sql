-- Down for 0209 only: the two retention-window rules it granted, and nothing
-- else. 0207's guard is REPLACED with 0207's own text, so rolling this back
-- restores the previous refusal exactly rather than dropping the guard — the
-- function is not removed, because 0207 created it and 0208's down file does
-- not drop it either. The window function is dropped, because nothing else
-- grants or depends on it.
--
-- The effect of rolling back is the review's S3 returning: an unaccepted set
-- cannot be trashed by anyone again, and the plan's 90-day sweep is impossible.
-- That is the correct thing for a down migration to say out loud.
BEGIN;
DROP FUNCTION public.result_file_unaccepted_retention_days();
CREATE OR REPLACE FUNCTION public.guard_result_file_set_acceptance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE owner_set public.control_result_file_sets%ROWTYPE;
BEGIN
  IF NEW.retention_state IS NOT DISTINCT FROM OLD.retention_state
    AND NEW.accepted_at IS NOT DISTINCT FROM OLD.accepted_at
    AND NEW.accepted_by_identity_id IS NOT DISTINCT FROM OLD.accepted_by_identity_id THEN RETURN NEW; END IF;
  IF NEW.accepted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants owner_grant ON owner_grant.tenant_id = owner_identity.tenant_id
        AND owner_grant.identity_id = owner_identity.id
      WHERE owner_identity.tenant_id = NEW.tenant_id AND owner_identity.id = NEW.accepted_by_identity_id
        AND owner_identity.actor_type = 'human' AND owner_identity.state = 'active'
        AND owner_grant.role_key = 'owner' AND owner_grant.revoked_at IS NULL
        AND (owner_grant.expires_at IS NULL OR owner_grant.expires_at > NEW.accepted_at)
        AND (owner_grant.allowed_actions ? '*' OR owner_grant.allowed_actions ? 'tasks.results.read')
        AND (owner_grant.project_ids ? '*' OR owner_grant.project_ids ? NEW.project_id)
        AND NEW.accepted_at <= pg_catalog.statement_timestamp() + interval '1 minute'
        AND NEW.accepted_at >= pg_catalog.statement_timestamp() - interval '5 minutes') THEN
    RAISE EXCEPTION 'result file set acceptance needs the owner' USING ERRCODE = '42501';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR NEW.accepted_by_identity_id IS DISTINCT FROM OLD.accepted_by_identity_id) THEN
    RAISE EXCEPTION 'result file set acceptance rejected' USING ERRCODE = '23514';
  END IF;
  IF NEW.retention_state IS DISTINCT FROM OLD.retention_state AND NOT EXISTS (
      SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants owner_grant ON owner_grant.tenant_id = owner_identity.tenant_id
        AND owner_grant.identity_id = owner_identity.id
      WHERE owner_identity.tenant_id = NEW.tenant_id
        AND owner_identity.id = coalesce(OLD.accepted_by_identity_id, NEW.accepted_by_identity_id)
        AND owner_identity.actor_type = 'human' AND owner_identity.state = 'active'
        AND owner_grant.role_key = 'owner' AND owner_grant.revoked_at IS NULL
        AND (owner_grant.expires_at IS NULL OR owner_grant.expires_at > pg_catalog.statement_timestamp())
        AND (owner_grant.allowed_actions ? '*' OR owner_grant.allowed_actions ? 'tasks.results.read')
        AND (owner_grant.project_ids ? '*' OR owner_grant.project_ids ? NEW.project_id)) THEN
    RAISE EXCEPTION 'result file set disposal needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
