-- S7: owner-consented unattended advance and durable transition receipts.
-- No trigger, scheduler, provider invocation, merge or external effect is added.

ALTER TABLE pipeline_templates DROP CONSTRAINT pipeline_templates_may_advance_unattended_check;
ALTER TABLE pipeline_runs DROP CONSTRAINT pipeline_runs_unattended_check;

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

CREATE FUNCTION reject_pipeline_unattended_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pipeline unattended history is append only'; END $$;
REVOKE ALL ON FUNCTION reject_pipeline_unattended_history_mutation() FROM PUBLIC;
CREATE TRIGGER pipeline_unattended_transitions_immutable BEFORE UPDATE OR DELETE ON pipeline_unattended_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_unattended_transitions_no_truncate BEFORE TRUNCATE ON pipeline_unattended_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_advance_receipts_immutable BEFORE UPDATE OR DELETE ON pipeline_advance_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_pipeline_unattended_history_mutation();
CREATE TRIGGER pipeline_advance_receipts_no_truncate BEFORE TRUNCATE ON pipeline_advance_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_pipeline_unattended_history_mutation();

REVOKE ALL ON pipeline_unattended_transitions, pipeline_advance_receipts FROM PUBLIC;
