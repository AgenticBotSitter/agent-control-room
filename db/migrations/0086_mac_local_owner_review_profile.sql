-- Preserve the existing private review boundary (0043/0053) and additionally admit
-- exactly one profile shape: the fixed Mac-local "Owner review" acceptance profile
-- for one of the tenant's own projects. Its content is the strictest profile the
-- product defines: one independent human review, no automatic low-risk disposition,
-- producer separation, and the owner as author. The web role cannot register any
-- other profile, target, revision or preference, and this grants no new privilege.
CREATE OR REPLACE FUNCTION guard_private_web_quality_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
      OR coalesce(NEW.payload->>'decision','') NOT IN ('accepted','changes_requested')
      OR NEW.payload->'reviewer'->>'actorType' IS DISTINCT FROM 'human'
      OR NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false') THEN
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
      -- Exact key set: no additional or missing fields.
      (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(NEW.payload) k)
        IS DISTINCT FROM ARRAY['automaticLowRiskDisposition','createdAt','createdBy','id',
          'maximumRevisionRounds','minimumIndependentReviews','minimumRisk','name','projectId',
          'requiredVerificationScenarioIds','reviewerSeparation','schemaVersion','targetKind',
          'tenantId','verificationRequiresProducerSeparation']::text[]
      -- The one fixed id for this project: the direct form, or for long project ids the
      -- first 32 hex characters of sha256Digest(projectId), i.e. SHA-256 of its JSON text.
      OR NEW.id IS DISTINCT FROM CASE
        WHEN length('profile:mac-local-owner-review:' || NEW.project_id) <= 180
          THEN 'profile:mac-local-owner-review:' || NEW.project_id
        ELSE 'profile:mac-local-owner-review:'
          || substr(encode(sha256(convert_to(to_json(NEW.project_id)::text,'UTF8')),'hex'),1,32) END
      OR NEW.payload->>'schemaVersion' IS DISTINCT FROM 'control-room-completion-gate/v1'
      OR NEW.payload->>'name' IS DISTINCT FROM 'Owner review'
      OR NEW.payload->>'targetKind' IS DISTINCT FROM 'document'
      OR NEW.payload->'requiredVerificationScenarioIds' IS DISTINCT FROM '["scenario:mac-local-text"]'::jsonb
      OR NEW.payload->'minimumIndependentReviews' IS DISTINCT FROM '1'::jsonb
      OR NEW.payload->'reviewerSeparation' IS DISTINCT FROM
        '{"actor":true,"worker":false,"agentProfile":false,"harness":false,"modelFamily":false}'::jsonb
      OR NEW.payload->'verificationRequiresProducerSeparation' IS DISTINCT FROM 'true'::jsonb
      OR NEW.payload->>'minimumRisk' IS DISTINCT FROM 'low'
      OR NEW.payload->'maximumRevisionRounds' IS DISTINCT FROM '3'::jsonb
      OR NEW.payload->'automaticLowRiskDisposition' IS DISTINCT FROM 'false'::jsonb
      OR NEW.payload->'createdBy'->>'actorType' IS DISTINCT FROM 'human'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'createdBy')) IS DISTINCT FROM 2
      -- The author is a human identity of this same tenant.
      OR NOT EXISTS (SELECT 1 FROM control_identities i WHERE i.tenant_id=NEW.tenant_id
        AND i.id=NEW.payload->'createdBy'->>'actorId' AND i.actor_type='human')) THEN
      RAISE EXCEPTION 'private quality insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_private_web_quality_insert() FROM PUBLIC;
