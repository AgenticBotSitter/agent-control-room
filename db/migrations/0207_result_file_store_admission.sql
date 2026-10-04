-- "Save to my Mac", part 1 (plan v4.3 §2.6, MIG-C): byte-store admission.
--
-- 0206 created the catalog. This migration closes the hole that makes the
-- catalog safe rather than merely descriptive (plan §2.6, H2):
--
--   * A worker login can never read the byte store or download a file. It
--     holds no privilege on either catalog table — db/roles/fleet_gateway_roles.sql
--     grants it neither — and the per-row producer binding below refuses any
--     write that is not the attempt's own recorded worker.
--   * A set is only accepted by the owner. Acceptance moves a set from the
--     90-day unaccepted sweep into the project's own life, so it is checked
--     against a live human owner holding the result-read grant, exactly as
--     0195 checks a module install approval.
--
-- AUTHORISATION IS WRITTEN INLINE, not delegated to a helper function. The
-- private-database preflight fails any public-schema function that a login
-- can EXECUTE and that is not one of its three pinned boundaries, so a
-- `result_file_download_permitted()` helper could not be called by the web
-- login at all. The web path therefore runs the same join inline in its own
-- SELECT, which is the shape 0140 already uses for its gateway checks.
--
-- Nothing here needs a definer-rights function, and no role gains EXECUTE on
-- anything new.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Acceptance names WHO accepted, so the guard can check that identity's live
-- owner grant rather than trusting the caller's own claim. Added by ALTER so
-- 0206's table keeps one migration's worth of create statements.
ALTER TABLE control_result_file_sets ADD COLUMN accepted_by_identity_id text
  CHECK (accepted_by_identity_id IS NULL OR accepted_by_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$');
ALTER TABLE control_result_file_sets ADD CONSTRAINT control_result_file_sets_accepted_by_fk
  FOREIGN KEY (tenant_id, accepted_by_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT;
-- 'retained' is the accepted state: it is unreachable without an accepted_at and
-- now without the identity that accepted it. (Immutability of an existing
-- acceptance is the trigger's job, not a CHECK's: a CHECK cannot see OLD.)
ALTER TABLE control_result_file_sets ADD CONSTRAINT control_result_file_sets_accepted_by_present
  CHECK (retention_state <> 'retained' OR (accepted_at IS NOT NULL AND accepted_by_identity_id IS NOT NULL));

-- ---------------------------------------------------------------------------
-- The per-row producer binding
-- ---------------------------------------------------------------------------
-- A result file is a catalog row about BYTES, and the bytes have a producer.
-- For a fleet set that producer is the worker the canonical attempt recorded;
-- for a native set it is the attempt whose native receipt already exists. A
-- row naming any other producer is refused, so even a role that somehow
-- reached these tables could not attribute a file to work it did not do.
CREATE FUNCTION guard_result_file_set_producer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE attempt_worker text;
BEGIN
  IF NEW.producer_kind='fleet' THEN
    SELECT a.worker_id INTO attempt_worker FROM public.control_attempts a
      WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.attempt_id;
    IF attempt_worker IS NULL OR NEW.producer_id IS DISTINCT FROM attempt_worker
      OR NOT EXISTS (SELECT 1 FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id
        AND w.worker_id=NEW.producer_id AND w.state='active')
      OR NEW.producer_id NOT LIKE 'fleet-worker:%' THEN
      RAISE EXCEPTION 'result file set producer rejected' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.producer_id<>'control-room-native'
      OR NOT EXISTS (SELECT 1 FROM public.control_native_artifact_receipts r
        WHERE r.tenant_id=NEW.tenant_id AND r.attempt_id=NEW.attempt_id AND r.job_id=NEW.job_id
          AND r.project_id=NEW.project_id) THEN
    -- Native work is produced by the Mac itself under one fixed name, and it
    -- must have a published native receipt for this exact project, job and
    -- attempt. That receipt is what makes "the existing native text result"
    -- an honest catalog row rather than a relabelled file store.
    --
    -- BOTH conditions are on one line deliberately. A native set needs the fixed
    -- name AND the receipt, and the review found this written as
    -- `producer_id<>'control-room-native' THEN <require receipt>`, which is the
    -- other two thirds of the statement: a `native` set naming a worker
    -- impostor was accepted whenever a receipt happened to exist, and a
    -- `native` set with no receipt at all was accepted under the fixed name.
    -- The catalog then attributed files to work that never produced them. One
    -- `ELSIF ... OR ...` is the only shape in which neither slip is available.
    RAISE EXCEPTION 'result file set producer rejected' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_set_producer() FROM PUBLIC;
CREATE TRIGGER control_result_file_sets_producer_guard BEFORE INSERT ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_set_producer();

-- ---------------------------------------------------------------------------
-- Retention is the owner's, and acceptance is a grant-checked owner act
-- ---------------------------------------------------------------------------
-- 0206 already forces retention forward only (provisional -> retained -> trash
-- -> purged). This adds who: recording acceptance requires a live human owner
-- with a result-read grant over this project at the database clock, not at the
-- caller's clock and not merely at INSERT time. A publisher that wrote the
-- bytes cannot accept them, and a lapsed session cannot either.
CREATE FUNCTION guard_result_file_set_acceptance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
  -- A recorded acceptance is permanent. Rewriting who accepted, or when, would
  -- let a later editor re-point a retained set at an identity that never looked
  -- at it, and would let an acceptance be unwritten to free its quota.
  IF OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR NEW.accepted_by_identity_id IS DISTINCT FROM OLD.accepted_by_identity_id) THEN
    RAISE EXCEPTION 'result file set acceptance rejected' USING ERRCODE = '23514';
  END IF;
  -- THROWING THE BYTES AWAY IS ALSO THE OWNER'S, and this is the review's
  -- should-fix finding: acceptance was grant-checked but `provisional/retained
  -- -> trash -> purged` was not, so the web login could trash or purge a set with
  -- no owner involved at all. Acceptance says "keep this", and discarding it must
  -- not be the easier half of the same decision.
  --
  -- The same predicate as acceptance, against the same accepted identity, and it
  -- runs at the DATABASE clock rather than the caller's. A live human owner with
  -- result-read over this project, and an unexpired grant, is required for the
  -- move. A publisher that wrote the bytes cannot discard them, and a lapsed
  -- session cannot either.
  IF NEW.retention_state IS DISTINCT FROM OLD.retention_state AND NOT EXISTS (
      SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants owner_grant ON owner_grant.tenant_id = owner_identity.tenant_id
        AND owner_grant.identity_id = owner_identity.id
      WHERE owner_identity.tenant_id = NEW.tenant_id
        -- The accepted identity when there is one, because that is the identity
        -- whose judgement this set is being recorded under; otherwise the
        -- identity that accepted it at all.
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
REVOKE ALL ON FUNCTION public.guard_result_file_set_acceptance() FROM PUBLIC;
CREATE TRIGGER control_result_file_sets_acceptance_guard BEFORE UPDATE ON control_result_file_sets
  FOR EACH ROW EXECUTE FUNCTION public.guard_result_file_set_acceptance();
