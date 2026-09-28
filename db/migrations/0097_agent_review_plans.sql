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

CREATE TRIGGER control_agent_review_plans_immutable BEFORE UPDATE OR DELETE ON public.control_agent_review_plans
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER control_agent_review_plans_no_truncate BEFORE TRUNCATE ON public.control_agent_review_plans
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

CREATE FUNCTION guard_agent_review_plan_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pipeline_stage_runs reviewer
    JOIN public.pipeline_stage_runs producer ON producer.tenant_id=reviewer.tenant_id
      AND producer.pipeline_run_id=reviewer.pipeline_run_id
      AND producer.stage_ordinal=reviewer.stage_ordinal-1
    JOIN public.control_task_execution_plans reviewer_execution ON reviewer_execution.tenant_id=reviewer.tenant_id
      AND reviewer_execution.project_id=reviewer.project_id
      AND reviewer_execution.source_job_id=reviewer.current_job_id
      AND reviewer_execution.job_id=NEW.reviewer_job_id
    JOIN public.control_task_execution_plans producer_execution ON producer_execution.tenant_id=producer.tenant_id
      AND producer_execution.project_id=producer.project_id
      AND producer_execution.source_job_id=producer.current_job_id
      AND producer_execution.job_id=NEW.producer_job_id
    JOIN public.control_harness_runs run ON run.tenant_id=reviewer.tenant_id
      AND run.id=NEW.reviewer_run_id AND run.job_id=reviewer_execution.job_id
      AND run.project_id=reviewer.project_id AND run.node_id=reviewer.node_id
    JOIN public.control_attempts attempt ON attempt.tenant_id=run.tenant_id AND attempt.id=run.attempt_id
      AND attempt.job_id=run.job_id AND attempt.node_id=run.node_id AND attempt.worker_id=reviewer.worker_id
    JOIN public.control_task_model_selections selection ON selection.tenant_id=reviewer.tenant_id
      AND selection.project_id=reviewer.project_id AND selection.job_id=reviewer_execution.job_id
    JOIN public.control_completion_gate_records target ON target.tenant_id=producer.tenant_id
      AND target.project_id=producer.project_id AND target.id=NEW.target_id AND target.kind='target'
    WHERE reviewer.tenant_id=NEW.tenant_id AND reviewer.project_id=NEW.project_id
      AND reviewer.pipeline_run_id=NEW.pipeline_run_id AND reviewer_execution.job_id=NEW.reviewer_job_id
      AND reviewer.stage_kind='check' AND reviewer.role='checker'
      AND target.record_digest=NEW.target_digest
      AND target.payload->>'subjectId'=NEW.producer_job_id
      AND target.payload->>'acceptanceProfileId'=NEW.acceptance_profile_id
      AND target.payload->>'acceptanceProfileDigest'=NEW.acceptance_profile_digest
      AND NEW.reviewer=pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('actorId',run.node_id,'actorType','agent',
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
REVOKE ALL ON FUNCTION public.guard_agent_review_plan_insert() FROM PUBLIC;
CREATE TRIGGER control_agent_review_plans_binding BEFORE INSERT ON public.control_agent_review_plans
  FOR EACH ROW EXECUTE FUNCTION public.guard_agent_review_plan_insert();

-- Defense in depth: the dedicated reviewer login never writes this table
-- directly. The SECURITY DEFINER entry point below derives and authenticates
-- the complete append instead.
CREATE FUNCTION guard_agent_reviewer_gate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_agent_reviewer'
      AND pg_catalog.pg_has_role(session_user,oid,'MEMBER'))
    AND current_user=session_user
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND NOT rolsuper) THEN
    RAISE EXCEPTION 'agent reviewer raw insert rejected';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_agent_reviewer_gate_insert() FROM PUBLIC;
CREATE TRIGGER control_completion_gate_agent_reviewer BEFORE INSERT ON public.control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_agent_reviewer_gate_insert();

CREATE FUNCTION agent_review_canonical_jsonb(input jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE kind text := jsonb_typeof(input); rendered text;
BEGIN
  IF kind IN ('null','boolean','number','string') THEN RETURN input::text; END IF;
  IF kind='array' THEN
    SELECT '[' || coalesce(string_agg(public.agent_review_canonical_jsonb(value),',' ORDER BY ordinal),'') || ']'
      INTO rendered FROM jsonb_array_elements(input) WITH ORDINALITY AS item(value,ordinal);
    RETURN rendered;
  END IF;
  IF kind='object' THEN
    SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || public.agent_review_canonical_jsonb(value),',' ORDER BY key),'') || '}'
      INTO rendered FROM jsonb_each(input) AS item(key,value);
    RETURN rendered;
  END IF;
  RAISE EXCEPTION 'agent review canonical JSON rejected';
END;
$$;
REVOKE ALL ON FUNCTION agent_review_canonical_jsonb(jsonb) FROM PUBLIC;

CREATE FUNCTION agent_review_hmac_sha256(key_bytes bytea, material text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE key_block bytea; inner_pad bytea; outer_pad bytea; position integer;
BEGIN
  IF octet_length(key_bytes)<>32 THEN RAISE EXCEPTION 'agent review integrity key rejected'; END IF;
  key_block=key_bytes || decode(repeat('00',32),'hex');
  inner_pad=decode(repeat('00',64),'hex');
  outer_pad=decode(repeat('00',64),'hex');
  FOR position IN 0..63 LOOP
    inner_pad=set_byte(inner_pad,position,get_byte(key_block,position) # 54);
    outer_pad=set_byte(outer_pad,position,get_byte(key_block,position) # 92);
  END LOOP;
  RETURN 'hmac-sha256:' || encode(sha256(outer_pad || sha256(inner_pad || convert_to(material,'UTF8'))),'hex');
END;
$$;
REVOKE ALL ON FUNCTION agent_review_hmac_sha256(bytea,text) FROM PUBLIC;

CREATE FUNCTION agent_review_principals_independent(producer jsonb, reviewer jsonb, separation jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT bool_and(coalesce(CASE axis.policy
    WHEN 'actor' THEN coalesce((separation->>axis.policy)::boolean,false)=false
      OR jsonb_typeof(producer->axis.field)='string' AND jsonb_typeof(reviewer->axis.field)='string'
        AND producer->>axis.field<>reviewer->>axis.field
    ELSE coalesce((separation->>axis.policy)::boolean,false)=false OR reviewer->>'actorType'='human'
      OR jsonb_typeof(producer->axis.field)='string' AND jsonb_typeof(reviewer->axis.field)='string'
        AND producer->>axis.field<>reviewer->>axis.field END,false))
  FROM (VALUES ('actor','actorId'),('worker','workerId'),('agentProfile','agentProfileId'),
    ('harness','harness'),('modelFamily','modelFamily')) AS axis(policy,field)
$$;
REVOKE ALL ON FUNCTION agent_review_principals_independent(jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION commit_agent_review(plan_id text, review_payload jsonb, finding_payload jsonb, integrity_key bytea)
RETURNS TABLE(replayed boolean, prior_revision bigint, prior_record_count bigint, prior_state_digest text,
  prior_state_auth_tag text, next_revision bigint, next_record_count bigint, next_state_digest text,
  next_state_auth_tag text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE plan public.control_agent_review_plans%ROWTYPE; target public.control_completion_gate_records%ROWTYPE;
  profile public.control_completion_gate_records%ROWTYPE; integrity public.control_completion_gate_integrity%ROWTYPE;
  existing public.control_completion_gate_records%ROWTYPE; plan_material jsonb;
  v_record_id text; v_record_kind text; v_record_key text; v_subject_id text; v_parent_id text; v_record_digest text;
  v_record_auth_tag text; v_occurred_at timestamptz; material jsonb; state_material jsonb; inserted_count integer := 0;
  minimum_risk integer; assessed_risk integer; effective_risk integer; expected_current_tag text;
  computed_count bigint; computed_digest text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='control_room_agent_reviewer'
      AND pg_catalog.pg_has_role(session_user,r.oid,'MEMBER'))
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper) THEN
    RAISE EXCEPTION 'agent review commit caller rejected';
  END IF;
  IF pg_catalog.octet_length(integrity_key)<>32 OR pg_catalog.jsonb_typeof(review_payload)<>'object'
    OR (finding_payload IS NOT NULL AND pg_catalog.jsonb_typeof(finding_payload)<>'object') THEN
    RAISE EXCEPTION 'agent review commit input rejected';
  END IF;
  SELECT * INTO plan FROM public.control_agent_review_plans p WHERE p.id=plan_id AND p.tenant_id=review_payload->>'tenantId';
  IF NOT FOUND THEN RAISE EXCEPTION 'agent review plan unavailable'; END IF;
  SELECT * INTO integrity FROM public.control_completion_gate_integrity i WHERE i.tenant_id=plan.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent review integrity unavailable'; END IF;
  expected_current_tag=public.agent_review_hmac_sha256(integrity_key,public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object(
    'module','completion-gate','tenantId',integrity.tenant_id,'revision',integrity.revision,
    'recordCount',integrity.record_count,'stateDigest',integrity.state_digest)));
  IF integrity.state_auth_tag IS DISTINCT FROM expected_current_tag THEN RAISE EXCEPTION 'agent review integrity key rejected'; END IF;
  FOR existing IN SELECT * FROM public.control_completion_gate_records r
    WHERE r.tenant_id=plan.tenant_id ORDER BY r.kind,r.id LOOP
    computed_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.agent_review_canonical_jsonb(existing.payload),'UTF8')),'hex');
    expected_current_tag=public.agent_review_hmac_sha256(integrity_key,public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object(
      'id',existing.id,'tenantId',existing.tenant_id,'projectId',existing.project_id,'kind',existing.kind,
      'recordKey',existing.record_key,'subjectId',existing.subject_id,'parentId',existing.parent_id,
      'recordDigest',existing.record_digest,
      'occurredAt',pg_catalog.to_char(existing.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
    IF existing.record_digest IS DISTINCT FROM computed_digest
      OR existing.record_auth_tag IS DISTINCT FROM expected_current_tag THEN
      RAISE EXCEPTION 'agent review existing record integrity rejected';
    END IF;
  END LOOP;
  SELECT pg_catalog.count(*),pg_catalog.jsonb_build_object('tenantId',plan.tenant_id,'records',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',r.id,'projectId',r.project_id,'kind',r.kind,'recordKey',r.record_key,'subjectId',r.subject_id,
    'parentId',r.parent_id,'recordDigest',r.record_digest,'recordAuthTag',r.record_auth_tag,
    'occurredAt',pg_catalog.to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY r.kind,r.id),'[]'::jsonb))
    INTO computed_count,state_material FROM public.control_completion_gate_records r WHERE r.tenant_id=plan.tenant_id;
  computed_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.agent_review_canonical_jsonb(state_material),'UTF8')),'hex');
  IF integrity.record_count<>computed_count OR integrity.state_digest IS DISTINCT FROM computed_digest THEN
    RAISE EXCEPTION 'agent review existing state integrity rejected';
  END IF;
  plan_material=pg_catalog.jsonb_build_object('schema','control-room.agent-review-plan/v1','id',plan.id,
    'tenantId',plan.tenant_id,'projectId',plan.project_id,'pipelineRunId',plan.pipeline_run_id,
    'producerJobId',plan.producer_job_id,'reviewerJobId',plan.reviewer_job_id,'reviewerRunId',plan.reviewer_run_id,
    'targetId',plan.target_id,'targetDigest',plan.target_digest,'acceptanceProfileId',plan.acceptance_profile_id,
    'acceptanceProfileDigest',plan.acceptance_profile_digest,'reviewId',plan.review_id,'findingId',plan.finding_id,
    'reviewer',plan.reviewer,'createdAt',pg_catalog.to_char(plan.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'grantsApproval',false,'grantsExecutionAuthority',false);
  IF plan.plan_digest IS DISTINCT FROM 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      public.agent_review_canonical_jsonb(plan_material),'UTF8')),'hex')
    OR plan.auth_tag IS DISTINCT FROM public.agent_review_hmac_sha256(integrity_key,public.agent_review_canonical_jsonb(
      pg_catalog.jsonb_build_object('purpose','agent-review-plan/v1','plan',plan_material))) THEN
    RAISE EXCEPTION 'agent review plan integrity rejected';
  END IF;
  SELECT * INTO target FROM public.control_completion_gate_records r
    WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id AND r.id=plan.target_id AND r.kind='target';
  SELECT * INTO profile FROM public.control_completion_gate_records r
    WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id
      AND r.id=plan.acceptance_profile_id AND r.kind='profile';
  minimum_risk=pg_catalog.array_position(ARRAY['low','medium','high','critical'],profile.payload->>'minimumRisk');
  assessed_risk=pg_catalog.array_position(ARRAY['low','medium','high','critical'],review_payload->>'assessedRisk');
  effective_risk=pg_catalog.array_position(ARRAY['low','medium','high','critical'],review_payload->>'effectiveRisk');
  IF target.id IS NULL OR profile.id IS NULL OR target.record_digest<>plan.target_digest
    OR profile.record_digest<>plan.acceptance_profile_digest
    OR target.payload->>'tenantId'<>plan.tenant_id OR target.payload->>'projectId'<>plan.project_id
    OR target.payload->>'acceptanceProfileId'<>profile.id
    OR target.payload->>'acceptanceProfileDigest'<>profile.record_digest
    OR target.payload->>'kind'<>profile.payload->>'targetKind'
    OR NOT public.agent_review_principals_independent(target.payload->'producer',plan.reviewer,
      profile.payload->'reviewerSeparation')
    OR review_payload->>'schemaVersion'<>'control-room-completion-gate/v1'
    OR review_payload->>'id'<>plan.review_id OR review_payload->>'tenantId'<>plan.tenant_id
    OR review_payload->>'projectId'<>plan.project_id OR review_payload->>'targetId'<>plan.target_id
    OR review_payload->>'targetDigest'<>plan.target_digest
    OR review_payload->>'acceptanceProfileId'<>plan.acceptance_profile_id
    OR review_payload->>'acceptanceProfileDigest'<>plan.acceptance_profile_digest
    OR review_payload->'reviewer'<>plan.reviewer OR review_payload->>'authority'<>'completion_gate'
    OR review_payload->>'decision' NOT IN ('accepted','changes_requested')
    OR review_payload->>'grantsApproval'<>'false' OR review_payload->>'grantsExecutionAuthority'<>'false'
    OR minimum_risk IS NULL OR assessed_risk IS NULL OR effective_risk<>greatest(minimum_risk,assessed_risk)
    OR review_payload->'findingIds'<>(CASE WHEN review_payload->>'decision'='accepted' THEN '[]'::jsonb
      ELSE pg_catalog.jsonb_build_array(plan.finding_id) END)
    OR (review_payload->>'reviewedAt')::timestamptz < (target.payload->>'submittedAt')::timestamptz
    OR NOT EXISTS (SELECT 1 FROM public.control_harness_runs run
      JOIN public.control_attempts attempt ON attempt.tenant_id=run.tenant_id AND attempt.id=run.attempt_id
        AND attempt.job_id=run.job_id AND attempt.node_id=run.node_id AND attempt.worker_id=plan.reviewer->>'workerId'
      WHERE run.tenant_id=plan.tenant_id AND run.id=plan.reviewer_run_id AND run.job_id=plan.reviewer_job_id
        AND run.project_id=plan.project_id AND run.node_id=plan.reviewer->>'actorId' AND run.state='succeeded') THEN
    RAISE EXCEPTION 'agent review commit binding rejected';
  END IF;
  IF review_payload->>'decision'='accepted' AND finding_payload IS NOT NULL THEN
    RAISE EXCEPTION 'agent review finding binding rejected';
  END IF;
  IF review_payload->>'decision'='changes_requested' AND finding_payload IS NULL THEN
    RAISE EXCEPTION 'agent review finding binding rejected';
  END IF;
  IF finding_payload IS NOT NULL AND (
      finding_payload->>'schemaVersion'<>'control-room-completion-gate/v1'
      OR finding_payload->>'id'<>plan.finding_id OR finding_payload->>'tenantId'<>plan.tenant_id
      OR finding_payload->>'projectId'<>plan.project_id OR finding_payload->>'targetId'<>plan.target_id
      OR finding_payload->>'targetDigest'<>plan.target_digest OR finding_payload->>'reviewId'<>plan.review_id
      OR finding_payload->>'code'<>'agent:changes_requested'
      OR finding_payload->>'severity'<>review_payload->>'effectiveRisk'
      OR (finding_payload->>'raisedAt')::timestamptz < (review_payload->>'reviewedAt')::timestamptz) THEN
    RAISE EXCEPTION 'agent review finding binding rejected';
  END IF;

  -- Exact retries are resolved before mutable target-state checks, matching
  -- the Completion Gate store's replay-first contract.
  IF EXISTS (SELECT 1 FROM public.control_completion_gate_records r
      WHERE r.tenant_id=plan.tenant_id AND r.id=plan.review_id) THEN
    v_record_key='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object(
      'kind','review','targetId',plan.target_id,'authority','completion_gate',
      'reviewerActorId',plan.reviewer->>'actorId')),'UTF8')),'hex');
    v_record_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      public.agent_review_canonical_jsonb(review_payload),'UTF8')),'hex');
    IF NOT EXISTS (SELECT 1 FROM public.control_completion_gate_records r
        WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id AND r.id=plan.review_id
          AND r.kind='review' AND r.record_key=v_record_key AND r.subject_id=plan.target_id
          AND r.parent_id=plan.target_id AND r.record_digest=v_record_digest AND r.payload=review_payload
          AND pg_catalog.to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=review_payload->>'reviewedAt')
      OR finding_payload IS NULL AND EXISTS (SELECT 1 FROM public.control_completion_gate_records r
        WHERE r.tenant_id=plan.tenant_id AND r.id=plan.finding_id)
      OR finding_payload IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.control_completion_gate_records r
        WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id AND r.id=plan.finding_id
          AND r.kind='finding' AND r.record_key=plan.finding_id AND r.subject_id=plan.target_id
          AND r.parent_id=plan.review_id AND r.record_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            public.agent_review_canonical_jsonb(finding_payload),'UTF8')),'hex') AND r.payload=finding_payload
          AND pg_catalog.to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=finding_payload->>'raisedAt') THEN
      RAISE EXCEPTION 'agent review record conflict';
    END IF;
    replayed=true; prior_revision=integrity.revision; prior_record_count=integrity.record_count;
    prior_state_digest=integrity.state_digest; prior_state_auth_tag=integrity.state_auth_tag;
    next_revision=prior_revision; next_record_count=prior_record_count;
    next_state_digest=prior_state_digest; next_state_auth_tag=prior_state_auth_tag; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.control_completion_gate_records r
      WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id
        AND r.kind='revision' AND r.parent_id=plan.target_id)
    OR review_payload->>'decision'='accepted' AND EXISTS (SELECT 1 FROM public.control_completion_gate_records r
      WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id
        AND r.kind='finding' AND r.subject_id=plan.target_id)
    OR EXISTS (SELECT 1 FROM public.control_completion_gate_records r
      WHERE r.tenant_id=plan.tenant_id AND r.project_id=plan.project_id AND r.kind='review'
        AND r.parent_id=plan.target_id AND r.payload->>'authority'='completion_gate'
        AND NOT public.agent_review_principals_independent(r.payload->'reviewer',plan.reviewer,
          profile.payload->'reviewerSeparation')) THEN
    RAISE EXCEPTION 'agent review current state rejected';
  END IF;

  FOR v_record_kind, material IN SELECT * FROM (VALUES ('review',review_payload),('finding',finding_payload)) AS records(kind,payload)
    WHERE payload IS NOT NULL ORDER BY kind DESC LOOP
    v_record_id=material->>'id';
    v_occurred_at=CASE WHEN v_record_kind='review' THEN (material->>'reviewedAt')::timestamptz ELSE (material->>'raisedAt')::timestamptz END;
    IF (CASE WHEN v_record_kind='review' THEN material->>'reviewedAt' ELSE material->>'raisedAt' END)
      <>pg_catalog.to_char(v_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
      RAISE EXCEPTION 'agent review timestamp rejected';
    END IF;
    v_subject_id=plan.target_id; v_parent_id=CASE WHEN v_record_kind='review' THEN plan.target_id ELSE plan.review_id END;
    v_record_key=CASE WHEN v_record_kind='review' THEN 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object('kind','review','targetId',plan.target_id,
        'authority','completion_gate','reviewerActorId',plan.reviewer->>'actorId')),'UTF8')),'hex') ELSE v_record_id END;
    v_record_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.agent_review_canonical_jsonb(material),'UTF8')),'hex');
    v_record_auth_tag=public.agent_review_hmac_sha256(integrity_key,public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object(
      'id',v_record_id,'tenantId',plan.tenant_id,'projectId',plan.project_id,'kind',v_record_kind,'recordKey',v_record_key,
      'subjectId',v_subject_id,'parentId',v_parent_id,'recordDigest',v_record_digest,
      'occurredAt',pg_catalog.to_char(v_occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
    INSERT INTO public.control_completion_gate_records(id,tenant_id,project_id,kind,record_key,subject_id,parent_id,
      record_digest,record_auth_tag,payload,occurred_at)
      VALUES(v_record_id,plan.tenant_id,plan.project_id,v_record_kind,v_record_key,v_subject_id,v_parent_id,
        v_record_digest,v_record_auth_tag,material,v_occurred_at)
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS effective_risk = ROW_COUNT;
    IF effective_risk=0 AND NOT EXISTS (SELECT 1 FROM public.control_completion_gate_records r
      WHERE r.tenant_id=plan.tenant_id AND r.id=v_record_id AND r.kind=v_record_kind AND r.record_key=v_record_key
        AND r.record_digest=v_record_digest AND r.record_auth_tag=v_record_auth_tag AND r.payload=material) THEN
      RAISE EXCEPTION 'agent review record conflict';
    END IF;
    inserted_count=inserted_count+effective_risk;
  END LOOP;
  prior_revision=integrity.revision; prior_record_count=integrity.record_count;
  prior_state_digest=integrity.state_digest; prior_state_auth_tag=integrity.state_auth_tag;
  IF inserted_count=0 THEN
    replayed=true; next_revision=prior_revision; next_record_count=prior_record_count;
    next_state_digest=prior_state_digest; next_state_auth_tag=prior_state_auth_tag; RETURN NEXT; RETURN;
  END IF;
  SELECT pg_catalog.jsonb_build_object('tenantId',plan.tenant_id,'records',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',r.id,'projectId',r.project_id,'kind',r.kind,'recordKey',r.record_key,'subjectId',r.subject_id,
    'parentId',r.parent_id,'recordDigest',r.record_digest,'recordAuthTag',r.record_auth_tag,
    'occurredAt',pg_catalog.to_char(r.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY r.kind,r.id),'[]'::jsonb))
    INTO state_material FROM public.control_completion_gate_records r WHERE r.tenant_id=plan.tenant_id;
  next_revision=prior_revision+1; next_record_count=(SELECT pg_catalog.count(*) FROM public.control_completion_gate_records r WHERE r.tenant_id=plan.tenant_id);
  next_state_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.agent_review_canonical_jsonb(state_material),'UTF8')),'hex');
  next_state_auth_tag=public.agent_review_hmac_sha256(integrity_key,public.agent_review_canonical_jsonb(pg_catalog.jsonb_build_object(
    'module','completion-gate','tenantId',plan.tenant_id,'revision',next_revision,
    'recordCount',next_record_count,'stateDigest',next_state_digest)));
  UPDATE public.control_completion_gate_integrity SET revision=next_revision,record_count=next_record_count,
    state_digest=next_state_digest,state_auth_tag=next_state_auth_tag WHERE tenant_id=plan.tenant_id AND revision=prior_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'agent review integrity conflict'; END IF;
  replayed=false; RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.commit_agent_review(text,jsonb,jsonb,bytea) FROM PUBLIC;
