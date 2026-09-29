-- S7: owner-consented unattended advance and durable transition receipts.
-- No trigger, scheduler, provider invocation, merge or external effect is added.

ALTER TABLE pipeline_templates DROP CONSTRAINT pipeline_templates_may_advance_unattended_check;
ALTER TABLE pipeline_runs DROP CONSTRAINT pipeline_runs_unattended_check;
-- Scheduler fairness metadata is deliberately outside the authenticated run
-- material: moving a scan cursor must not rewrite owner-approved run state.
ALTER TABLE pipeline_runs ADD COLUMN unattended_last_swept_at timestamptz;
CREATE INDEX pipeline_runs_unattended_sweep_cursor
  ON pipeline_runs(tenant_id, unattended_last_swept_at ASC NULLS FIRST, id)
  WHERE state='active' AND unattended;
-- Preserve upgrade compatibility with authenticated pre-S7 rows while making
-- every new or updated active run carry the immutable wall-clock anchor.  The
-- service refuses any legacy active/null row rather than repairing or re-signing it.
ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_active_started_at_check
  CHECK (state <> 'active' OR started_at IS NOT NULL) NOT VALID;

CREATE TABLE pipeline_unattended_transitions (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  pipeline_template_id text NOT NULL,
  template_version integer NOT NULL CHECK (template_version>=1),
  template_digest text NOT NULL CHECK (template_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_version integer NOT NULL CHECK (run_version>=1),
  run_digest text NOT NULL CHECK (run_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_id text NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version>=1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  enabled boolean NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  transition_digest text NOT NULL CHECK (transition_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,owner_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,pipeline_run_id,project_id)
    REFERENCES pipeline_runs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,pipeline_template_id,project_id)
    REFERENCES pipeline_templates(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_id,project_id)
    REFERENCES control_project_delegation_policies(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id)
    REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE pipeline_advance_receipts (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  pipeline_run_id text NOT NULL,
  stage_ordinal integer NOT NULL CHECK (stage_ordinal>=0),
  source_job_id text NOT NULL,
  execution_job_id text NOT NULL,
  attempt_id text NOT NULL,
  queue_id text NOT NULL,
  selection_digest text NOT NULL CHECK (selection_digest ~ '^sha256:[a-f0-9]{64}$'),
  template_version integer NOT NULL CHECK (template_version>=1),
  template_digest text NOT NULL CHECK (template_digest ~ '^sha256:[a-f0-9]{64}$'),
  run_version integer NOT NULL CHECK (run_version>=1),
  run_digest text NOT NULL CHECK (run_digest ~ '^sha256:[a-f0-9]{64}$'),
  policy_id text NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version>=1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  delegation_receipt_id text NOT NULL,
  delegation_receipt_digest text NOT NULL CHECK (delegation_receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  delegation_task_units integer NOT NULL CHECK (delegation_task_units=1),
  delegation_cost_microusd bigint NOT NULL CHECK (delegation_cost_microusd>=0),
  delegation_cost_evidence_digest text NOT NULL CHECK (delegation_cost_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  advanced_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,pipeline_run_id,stage_ordinal),
  FOREIGN KEY (tenant_id,pipeline_run_id,project_id)
    REFERENCES pipeline_runs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,pipeline_run_id,stage_ordinal)
    REFERENCES pipeline_stage_runs(tenant_id,pipeline_run_id,stage_ordinal) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,execution_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id,execution_job_id)
    REFERENCES control_attempts(tenant_id,id,job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_id,project_id)
    REFERENCES control_project_delegation_policies(tenant_id,id,project_id) ON DELETE RESTRICT
);

CREATE FUNCTION reject_pipeline_unattended_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'pipeline unattended history is append only'; END $$;
REVOKE ALL ON FUNCTION public.reject_pipeline_unattended_history_mutation() FROM PUBLIC;
CREATE TRIGGER pipeline_unattended_transitions_immutable BEFORE UPDATE OR DELETE ON public.pipeline_unattended_transitions
  FOR EACH ROW EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_unattended_transitions_no_truncate BEFORE TRUNCATE ON public.pipeline_unattended_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_advance_receipts_immutable BEFORE UPDATE OR DELETE ON public.pipeline_advance_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_advance_receipts_no_truncate BEFORE TRUNCATE ON public.pipeline_advance_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_pipeline_unattended_history_mutation();

REVOKE ALL ON pipeline_unattended_transitions, pipeline_advance_receipts FROM PUBLIC;

-- No shared login is granted either table. If one ever is, the work-intake
-- session must still see and write only its bound tenant, as 0104 and 0108
-- confine their tables. Every other role keeps its grants.
ALTER TABLE pipeline_unattended_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_unattended_transitions_existing_access ON pipeline_unattended_transitions
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pipeline_unattended_transitions_work_intake_scope ON pipeline_unattended_transitions
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    pipeline_unattended_transitions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    pipeline_unattended_transitions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));
ALTER TABLE pipeline_advance_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY pipeline_advance_receipts_existing_access ON pipeline_advance_receipts
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY pipeline_advance_receipts_work_intake_scope ON pipeline_advance_receipts
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    pipeline_advance_receipts.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    pipeline_advance_receipts.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));

-- Existing installations already have these NOLOGIN roles. Keep the upgrade
-- grant as narrow as the fresh-install role files; absence is valid while an
-- operator is still applying migrations before role provisioning.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT UPDATE (unattended, state, started_at, updated_at, version, template_version, template_digest, record_digest, auth_tag) ON pipeline_runs TO control_room_private_web';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_task_coordinator') THEN
    EXECUTE 'GRANT UPDATE (state, completed_at, current_stage_ordinal, updated_at, version, record_digest, auth_tag, unattended_last_swept_at) ON pipeline_runs TO control_room_task_coordinator';
  END IF;
END $$;
