-- S5: server-created plans are the only authority an agent reviewer may use.
-- The plan is negative authority: it grants neither execution nor owner
-- approval and binds one check-stage run to one predecessor target.
CREATE TABLE control_agent_review_plans (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  producer_job_id text NOT NULL,
  reviewer_job_id text NOT NULL,
  reviewer_run_id text NOT NULL,
  target_id text NOT NULL,
  target_digest text NOT NULL CHECK (target_digest ~ '^sha256:[a-f0-9]{64}$'),
  acceptance_profile_id text NOT NULL,
  acceptance_profile_digest text NOT NULL CHECK (acceptance_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  review_id text NOT NULL,
  finding_id text NOT NULL,
  reviewer jsonb NOT NULL,
  plan_digest text NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,review_id),
  UNIQUE (tenant_id,finding_id),
  UNIQUE (tenant_id,reviewer_run_id,target_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,pipeline_run_id,project_id)
    REFERENCES pipeline_runs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,producer_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewer_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewer_run_id)
    REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,target_id)
    REFERENCES control_completion_gate_records(tenant_id,id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(reviewer)='object'
    AND reviewer->>'actorType'='agent'
    AND reviewer ?& ARRAY['actorId','workerId','agentProfileId','harness','adapterId'])
);

CREATE TRIGGER control_agent_review_plans_immutable BEFORE UPDATE OR DELETE ON control_agent_review_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_agent_review_plans_no_truncate BEFORE TRUNCATE ON control_agent_review_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION guard_agent_review_plan_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pipeline_stage_runs reviewer
    JOIN pipeline_stage_runs producer ON producer.tenant_id=reviewer.tenant_id
      AND producer.pipeline_run_id=reviewer.pipeline_run_id
      AND producer.stage_ordinal=reviewer.stage_ordinal-1
    JOIN control_task_execution_plans reviewer_execution ON reviewer_execution.tenant_id=reviewer.tenant_id
      AND reviewer_execution.project_id=reviewer.project_id
      AND reviewer_execution.source_job_id=reviewer.current_job_id
      AND reviewer_execution.job_id=NEW.reviewer_job_id
    JOIN control_task_execution_plans producer_execution ON producer_execution.tenant_id=producer.tenant_id
      AND producer_execution.project_id=producer.project_id
      AND producer_execution.source_job_id=producer.current_job_id
      AND producer_execution.job_id=NEW.producer_job_id
    JOIN control_harness_runs run ON run.tenant_id=reviewer.tenant_id
      AND run.id=NEW.reviewer_run_id AND run.job_id=reviewer_execution.job_id
      AND run.project_id=reviewer.project_id AND run.node_id=reviewer.node_id
    JOIN control_attempts attempt ON attempt.tenant_id=run.tenant_id AND attempt.id=run.attempt_id
      AND attempt.job_id=run.job_id AND attempt.node_id=run.node_id AND attempt.worker_id=reviewer.worker_id
    JOIN control_task_model_selections selection ON selection.tenant_id=reviewer.tenant_id
      AND selection.project_id=reviewer.project_id AND selection.job_id=reviewer_execution.job_id
    JOIN control_completion_gate_records target ON target.tenant_id=producer.tenant_id
      AND target.project_id=producer.project_id AND target.id=NEW.target_id AND target.kind='target'
    WHERE reviewer.tenant_id=NEW.tenant_id AND reviewer.project_id=NEW.project_id
      AND reviewer.pipeline_run_id=NEW.pipeline_run_id AND reviewer_execution.job_id=NEW.reviewer_job_id
      AND reviewer.stage_kind='check' AND reviewer.role='checker'
      AND target.record_digest=NEW.target_digest
      AND target.payload->>'subjectId'=NEW.producer_job_id
      AND target.payload->>'acceptanceProfileId'=NEW.acceptance_profile_id
      AND target.payload->>'acceptanceProfileDigest'=NEW.acceptance_profile_digest
      AND NEW.reviewer=jsonb_strip_nulls(jsonb_build_object('actorId',run.node_id,'actorType','agent',
        'workerId',reviewer.worker_id,'agentProfileId',NEW.reviewer->>'agentProfileId',
        'harness',NEW.reviewer->>'harness','adapterId',NEW.reviewer->>'adapterId',
        'modelFamily',NEW.reviewer->>'modelFamily'))
      AND selection.worker_kind=reviewer.worker_kind AND selection.selection_key=reviewer.selection_key
      AND selection.model=reviewer.model AND selection.effort=reviewer.effort
      AND selection.provider IS NOT DISTINCT FROM reviewer.provider
      AND selection.profile IS NOT DISTINCT FROM reviewer.profile) THEN
    RAISE EXCEPTION 'agent review plan binding rejected';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_agent_review_plan_insert() FROM PUBLIC;
CREATE TRIGGER control_agent_review_plans_binding BEFORE INSERT ON control_agent_review_plans
  FOR EACH ROW EXECUTE FUNCTION guard_agent_review_plan_insert();

-- This branch applies only to the dedicated NOLOGIN group role. Existing
-- human-owner, coordinator and native-result guards remain unchanged.
CREATE FUNCTION guard_agent_reviewer_gate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer'
      AND pg_has_role(current_user,oid,'MEMBER'))
    AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
    IF NEW.kind NOT IN ('review','finding') OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.payload->>'projectId' IS DISTINCT FROM NEW.project_id
      OR NEW.payload->>'id' IS DISTINCT FROM NEW.id
      OR NOT EXISTS (SELECT 1 FROM control_agent_review_plans plan
        JOIN control_completion_gate_records target ON target.tenant_id=plan.tenant_id
          AND target.project_id=plan.project_id AND target.id=plan.target_id AND target.kind='target'
        JOIN control_harness_runs run ON run.tenant_id=plan.tenant_id
          AND run.id=plan.reviewer_run_id AND run.job_id=plan.reviewer_job_id
        JOIN control_attempts attempt ON attempt.tenant_id=run.tenant_id AND attempt.id=run.attempt_id
          AND attempt.job_id=run.job_id AND attempt.node_id=run.node_id
          AND attempt.worker_id=plan.reviewer->>'workerId'
        JOIN pipeline_stage_runs reviewer ON reviewer.tenant_id=plan.tenant_id
          AND reviewer.project_id=plan.project_id AND reviewer.pipeline_run_id=plan.pipeline_run_id
          AND reviewer.stage_kind='check'
        JOIN control_task_execution_plans reviewer_execution ON reviewer_execution.tenant_id=reviewer.tenant_id
          AND reviewer_execution.project_id=reviewer.project_id
          AND reviewer_execution.source_job_id=reviewer.current_job_id
          AND reviewer_execution.job_id=plan.reviewer_job_id
        WHERE plan.tenant_id=NEW.tenant_id AND plan.project_id=NEW.project_id
          AND plan.target_id=NEW.subject_id
          AND ((NEW.kind='review' AND plan.review_id=NEW.id AND plan.target_id=NEW.parent_id
            AND NEW.payload->>'targetId'=plan.target_id
            AND NEW.payload->>'targetDigest'=plan.target_digest
            AND NEW.payload->>'acceptanceProfileId'=plan.acceptance_profile_id
            AND NEW.payload->>'acceptanceProfileDigest'=plan.acceptance_profile_digest
            AND NEW.payload->'reviewer'=plan.reviewer
            AND NEW.payload->>'authority'='completion_gate'
            AND coalesce(NEW.payload->>'decision','') IN ('accepted','changes_requested')
            AND NEW.payload->>'grantsApproval'='false'
            AND NEW.payload->>'grantsExecutionAuthority'='false'
            AND NEW.payload->'findingIds'=CASE WHEN NEW.payload->>'decision'='accepted' THEN '[]'::jsonb
              ELSE jsonb_build_array(plan.finding_id) END)
          OR (NEW.kind='finding' AND plan.finding_id=NEW.id AND plan.review_id=NEW.parent_id
            AND NEW.payload->>'targetId'=plan.target_id AND NEW.payload->>'targetDigest'=plan.target_digest
            AND NEW.payload->>'reviewId'=plan.review_id AND NEW.payload->>'code'='agent:changes_requested'
            AND EXISTS (SELECT 1 FROM control_completion_gate_records review
              WHERE review.tenant_id=plan.tenant_id AND review.project_id=plan.project_id
                AND review.id=plan.review_id AND review.kind='review'
                AND review.payload->'findingIds'=jsonb_build_array(plan.finding_id))))
          AND target.record_digest=plan.target_digest
          AND run.project_id=plan.project_id AND run.node_id=plan.reviewer->>'actorId') THEN
      RAISE EXCEPTION 'agent review insert rejected';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_agent_reviewer_gate_insert() FROM PUBLIC;
CREATE TRIGGER control_completion_gate_agent_reviewer BEFORE INSERT ON control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION guard_agent_reviewer_gate_insert();
