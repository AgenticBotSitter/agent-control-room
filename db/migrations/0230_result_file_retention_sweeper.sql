-- "Save to my Mac", part 1, fix round 2 (MIG-C follow-up): who may discard a
-- result set nobody ever accepted.
--
-- 0207 made disposal the owner's, which was the right call and is kept: a live
-- human owner with result-read over the project may trash or purge a set that
-- that owner accepted. The review's S3 is what that leaves unusable, and it is
-- a real hole rather than a tidiness complaint:
--
--   * The plan's retention rule is "unaccepted results are swept after 90 days".
--     An unaccepted set has NO accepted identity, so `coalesce(OLD
--     accepted_by_identity_id, NEW.accepted_by_identity_id)` is NULL, the owner
--     predicate cannot match, and the sweep is impossible — for every login,
--     including the superuser. 0207 made a safety property into a permanent
--     lock-out.
--   * An owner cannot REJECT a bad result without first accepting it, which
--     means "accept" currently means "I agree to keep this forever or I can
--     never get rid of it".
--
-- Both are the same missing capability: a disposal that is nobody's
-- responsibility but time's. This adds one, and only one:
--
--   * A set the owner has ACCEPTED still requires that owner. Nothing here
--     widens the accepted case, and no sweeper can touch a retained set.
--   * A set nobody has accepted may be trashed by the owner who could have
--     accepted it — that is the "reject" the review asked for, and it is the
--     live owner, not a role and not a login nobody can attribute.
--   * A set nobody has accepted and that is OLDER THAN 90 DAYS may be trashed
--     by the database's own clock. No identity, no session, no login: the rule
--     is the age, and the age is measured by the server rather than by whoever
--     runs the statement. A sweeper cannot trash anything younger, cannot touch
--     an accepted set, and cannot purge — purge still needs the owner, because
--     purge is the irreversible half and "nobody complained for 90 days" is not
--     consent to destroy.
--
-- The age is a constant here rather than a column so that the rule cannot be
-- changed by a row someone edits: changing the retention window is a migration,
-- which is a reviewed change, and not a value in a table a login can UPDATE.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION public.result_file_unaccepted_retention_days() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 90;
$$;
REVOKE ALL ON FUNCTION public.result_file_unaccepted_retention_days() FROM PUBLIC;

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
  IF NEW.retention_state IS DISTINCT FROM OLD.retention_state AND NOT (
      EXISTS (
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
          AND (owner_grant.project_ids ? '*' OR owner_grant.project_ids ? NEW.project_id))
      OR (
        -- THE REVIEW'S S3, and it is two additions rather than a widening.
        --
        -- Nothing an ACCEPTED set can reach changes above: every clause above
        -- still applies to it, because this arm requires `OLD.accepted_at IS
        -- NULL` and an accepted set has one.
        --
        -- (1) REJECTION, AND IT NAMES WHO REJECTED.
        --
        --     A trigger cannot see who is calling — there is no session to read
        --     and no request to attribute — so "a live owner may reject" has to
        --     be expressed the way 0207 already expresses acceptance: the
        --     rejecting identity goes IN THE ROW, and the trigger then checks
        --     that identity rather than checking that some owner exists. An
        --     earlier revision of this migration only asked whether a live
        --     owner grant existed over the project, and the proof caught it
        --     immediately: `postgres` holds every privilege on the table, was
        --     not an identity at all, and could throw away an unaccepted set
        --     because someone ELSE owned the project. That is a privilege
        --     arrangement wearing a guard's clothes.
        --
        --     So `accepted_by_identity_id` is the rejecting identity, it must be
        --     a live human owner with result-read over this project at the
        --     database clock, and `accepted_at` records when they said no. A
        --     rejection is therefore as recorded and as attributable as an
        --     acceptance, which is what makes "the owner declined this" a fact
        --     the ledger can answer.
        --
        -- (2) THE PLAN'S 90-DAY SWEEP, which needs no identity at all: an
        --     unaccepted set older than the retention window may be trashed at
        --     the DATABASE clock. The age is what authorises it, read from the
        --     server's clock, so no caller can hurry it by naming a timestamp.
        --
        -- Both are TRASH only. Purging is the irreversible half and still needs
        -- a NAMED owner: nobody having complained for ninety days is not consent
        -- to destroy.
        OLD.accepted_at IS NULL
        AND NEW.retention_state = 'trash'
        AND (
          (NEW.accepted_by_identity_id IS NOT NULL
            AND NEW.accepted_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.control_identities reject_identity
              JOIN public.control_role_grants reject_grant ON reject_grant.tenant_id = reject_identity.tenant_id
                AND reject_grant.identity_id = reject_identity.id
              WHERE reject_identity.tenant_id = NEW.tenant_id
                AND reject_identity.id = NEW.accepted_by_identity_id
                AND reject_identity.actor_type = 'human' AND reject_identity.state = 'active'
                AND reject_grant.role_key = 'owner' AND reject_grant.revoked_at IS NULL
                AND (reject_grant.expires_at IS NULL OR reject_grant.expires_at > pg_catalog.statement_timestamp())
                AND (reject_grant.allowed_actions ? '*' OR reject_grant.allowed_actions ? 'tasks.results.read')
                AND (reject_grant.project_ids ? '*' OR reject_grant.project_ids ? NEW.project_id)
                AND NEW.accepted_at <= pg_catalog.statement_timestamp() + interval '1 minute'
                AND NEW.accepted_at >= pg_catalog.statement_timestamp() - interval '5 minutes'))
          OR (NEW.accepted_by_identity_id IS NULL
            AND OLD.created_at < pg_catalog.statement_timestamp()
              - make_interval(days => public.result_file_unaccepted_retention_days()))
        )
      )) THEN
    RAISE EXCEPTION 'result file set disposal needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_result_file_set_acceptance() FROM PUBLIC;
