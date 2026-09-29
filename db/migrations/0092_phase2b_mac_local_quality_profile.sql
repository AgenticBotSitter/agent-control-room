-- Admit a versioned Mac-local owner-review profile for reviewer independence
-- and a distinct human verification scenario. Existing v1 profile records are
-- immutable and remain valid for their existing targets; new work uses the v2
-- profile id. On the first start after upgrade, each active project registers
-- v2; existing targets keep their recorded v1 profile/digest and new targets
-- bind v2. Human owner review remains available under both versions. This
-- replaces only insert guards and grants no new privilege.
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

-- The native-results login may insert a target only when its complete producer
-- principal is reconstructed from the authenticated durable review plan. The
-- older guard compared against actor id/type alone; once trusted publication
-- began binding agent provenance, that exact JSON comparison rejected every
-- legitimate Mac-local target. Keep the comparison exact so a caller cannot
-- omit, alter, or add provenance while inserting the target or its revision.
CREATE OR REPLACE FUNCTION guard_native_results_gate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_native_results'
    AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind NOT IN ('target','revision')
      OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'native result gate insert rejected';
    END IF;
    IF NEW.kind='target' AND NOT EXISTS (
      SELECT 1 FROM control_native_review_plans p
      JOIN control_native_artifact_receipts r ON r.tenant_id=p.tenant_id AND r.run_id=p.run_id
      WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
        AND p.plan->>'targetId'=NEW.id
        AND NEW.payload->>'kind'='document'
        AND NEW.payload->'producer'=jsonb_strip_nulls(jsonb_build_object(
          'actorId',p.plan->>'nodeId','actorType','agent',
          'workerId',p.plan->>'workerId','agentProfileId',p.plan->>'agentProfileId',
          'harness',p.plan->>'harness','adapterId',p.plan->>'adapterId',
          'modelFamily',p.plan->>'modelFamily'))
        AND NEW.payload->>'acceptanceProfileId'=p.plan->>'acceptanceProfileId'
        AND NEW.payload->>'acceptanceProfileDigest'=p.plan->>'acceptanceProfileDigest'
        AND NEW.payload->>'subjectId'=coalesce(p.plan->'revision'->>'rootSubjectId',p.job_id)
        AND NEW.payload->>'rootTargetId'=coalesce(p.plan->'revision'->>'rootTargetId',p.plan->>'targetId')
        AND NEW.payload->'revisionNumber'=coalesce(p.plan->'revision'->'revisionNumber','0'::jsonb)
        AND NEW.payload->>'supersedesTargetId' IS NOT DISTINCT FROM p.plan->'revision'->>'fromTargetId'
        AND NEW.payload->>'subjectDigest'=r.receipt->>'contentHash'
        AND NEW.payload->>'submittedAt'=r.receipt->>'receivedAt'
    ) THEN RAISE EXCEPTION 'native result target insert rejected'; END IF;
    IF NEW.kind='revision' AND (NEW.payload->>'grantsApproval' IS DISTINCT FROM 'false'
      OR NEW.payload->>'grantsExecutionAuthority' IS DISTINCT FROM 'false' OR NOT EXISTS (
      SELECT 1 FROM control_native_review_plans p
      JOIN control_native_artifact_receipts r ON r.tenant_id=p.tenant_id AND r.run_id=p.run_id
      JOIN control_completion_gate_records t ON t.tenant_id=p.tenant_id AND t.project_id=p.project_id
        AND t.id=p.plan->>'targetId' AND t.kind='target'
      WHERE p.tenant_id=NEW.tenant_id AND p.project_id=NEW.project_id
        AND p.plan->>'schema'='control-room.native-review-plan/v2'
        AND NEW.payload->>'toTargetId'=t.id AND NEW.payload->>'toTargetDigest'=t.record_digest
        AND NEW.payload->>'rootTargetId'=p.plan->'revision'->>'rootTargetId'
        AND NEW.payload->>'fromTargetId'=p.plan->'revision'->>'fromTargetId'
        AND NEW.payload->>'fromTargetDigest'=p.plan->'revision'->>'fromTargetDigest'
        AND NEW.payload->'revisionNumber'=p.plan->'revision'->'revisionNumber'
        AND NEW.payload->'resolvedFindingIds'=p.plan->'revision'->'findingIds'
        AND NEW.payload->'revisedBy'=jsonb_strip_nulls(jsonb_build_object(
          'actorId',p.plan->>'nodeId','actorType','agent',
          'workerId',p.plan->>'workerId','agentProfileId',p.plan->>'agentProfileId',
          'harness',p.plan->>'harness','adapterId',p.plan->>'adapterId',
          'modelFamily',p.plan->>'modelFamily'))
        AND NEW.payload->>'revisedAt'=r.receipt->>'receivedAt'
    )) THEN RAISE EXCEPTION 'native result revision insert rejected'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_native_results_gate_insert() FROM PUBLIC;
