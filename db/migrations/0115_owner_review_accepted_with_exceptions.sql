-- Widen the private web owner-review decision list (0043/0053/0086/0092) to admit
-- "accepted_with_exceptions": the result is usable, but named shortfalls stay open
-- as linked follow-up proposals instead of forcing a revision round. This grants
-- no new privilege: the decision still requires a human reviewer, still cannot
-- carry findings (unlike changes_requested), and still sets grantsApproval=false
-- and grantsExecutionAuthority=false. The exception list itself is checked here
-- for shape, not for the follow-up proposal it names; the completion-gate store
-- and its zod schema are the authority for that binding.
CREATE OR REPLACE FUNCTION guard_private_web_quality_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind NOT IN ('review','finding','verification','profile')
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='review' AND (
      NEW.payload->>'authority' IS DISTINCT FROM 'completion_gate'
      OR coalesce(NEW.payload->>'decision','') NOT IN ('accepted','accepted_with_exceptions','changes_requested')
      OR NEW.payload->'reviewer'->>'actorType' IS DISTINCT FROM 'human'
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='review' AND NEW.payload->>'decision'='accepted_with_exceptions' AND (
      jsonb_typeof(NEW.payload->'exceptions') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.payload->'exceptions')<1
      OR jsonb_array_length(NEW.payload->'exceptions')>10) THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='review' AND NEW.payload->>'decision'<>'accepted_with_exceptions'
      AND NEW.payload ? 'exceptions' THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='verification' AND (
      coalesce(NEW.payload->>'outcome','') NOT IN ('passed','failed','blocked','inconclusive')
      OR NEW.payload->'verifier'->>'actorType' IS DISTINCT FROM 'human'
      OR coalesce(NEW.payload->'verifier'->>'actorId','')=''
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
    IF NEW.kind='profile' AND (
      (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(NEW.payload) k)
        IS DISTINCT FROM ARRAY['automaticLowRiskDisposition','createdAt','createdBy','id',
          'maximumRevisionRounds','minimumIndependentReviews','minimumRisk','name','projectId',
          'requiredVerificationScenarioIds','reviewerSeparation','schemaVersion','targetKind',
          'tenantId','verificationRequiresProducerSeparation']::text[]
      OR NEW.id IS DISTINCT FROM CASE
        WHEN length('profile:mac-local-owner-review:v2:' || NEW.project_id) <= 180
          THEN 'profile:mac-local-owner-review:v2:' || NEW.project_id
        ELSE 'profile:mac-local-owner-review:v2:'
          || substr(encode(sha256(convert_to(to_json(NEW.project_id)::text,'UTF8')),'hex'),1,32) END
      OR NEW.payload->>'schemaVersion' IS DISTINCT FROM 'control-room-completion-gate/v1'
      OR NEW.payload->>'name' IS DISTINCT FROM 'Owner review'
      OR NEW.payload->>'targetKind' IS DISTINCT FROM 'document'
      OR NEW.payload->'requiredVerificationScenarioIds' IS DISTINCT FROM
        '["scenario:mac-local-human-verification","scenario:mac-local-text"]'::jsonb
      OR NEW.payload->'minimumIndependentReviews' IS DISTINCT FROM '1'::jsonb
      OR NEW.payload->'reviewerSeparation' NOT IN (
        '{"actor":true,"worker":true,"agentProfile":true,"harness":true,"modelFamily":false}'::jsonb,
        '{"actor":true,"worker":true,"agentProfile":true,"harness":true,"modelFamily":true}'::jsonb)
      OR NEW.payload->'verificationRequiresProducerSeparation' IS DISTINCT FROM 'true'::jsonb
      OR NEW.payload->>'minimumRisk' IS DISTINCT FROM 'low'
      OR NEW.payload->'maximumRevisionRounds' IS DISTINCT FROM '3'::jsonb
      OR NEW.payload->'automaticLowRiskDisposition' IS DISTINCT FROM 'false'::jsonb
      OR NEW.payload->'createdBy'->>'actorType' IS DISTINCT FROM 'human'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'createdBy')) IS DISTINCT FROM 2
      OR NOT EXISTS (SELECT 1 FROM control_identities i WHERE i.tenant_id=NEW.tenant_id
        AND i.id=NEW.payload->'createdBy'->>'actorId' AND i.actor_type='human' AND i.state='active'
        AND EXISTS (SELECT 1 FROM control_role_grants g WHERE g.tenant_id=i.tenant_id
          AND g.identity_id=i.id AND g.role_key='owner' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
          AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)))) THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_private_web_quality_insert() FROM PUBLIC;
