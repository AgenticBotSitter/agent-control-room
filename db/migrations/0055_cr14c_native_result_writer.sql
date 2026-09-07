-- Inert row locking only: the dedicated result writer receives no job-state UPDATE privilege.
ALTER TABLE control_jobs ADD COLUMN result_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_jobs_result_lock CHECK (result_lock IS FALSE);

CREATE FUNCTION guard_native_results_gate_insert() RETURNS trigger
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
        AND NEW.payload->'producer'=jsonb_build_object('actorType','agent','actorId',p.plan->>'nodeId')
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
        AND NEW.payload->'revisedBy'=jsonb_build_object('actorType','agent','actorId',p.plan->>'nodeId')
        AND NEW.payload->>'revisedAt'=r.receipt->>'receivedAt'
    )) THEN RAISE EXCEPTION 'native result revision insert rejected'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_native_results_gate_insert() FROM PUBLIC;
CREATE TRIGGER control_completion_gate_native_results BEFORE INSERT ON control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION guard_native_results_gate_insert();
