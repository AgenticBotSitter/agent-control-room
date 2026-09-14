-- Owner-selected project coordinators, exact agent proposals and bounded adoption.
-- These records are authority evidence; they do not create an agent login, queue,
-- execution approval, provider call, or automatic result acceptance.

ALTER TABLE control_native_artifact_receipts
  ADD CONSTRAINT uq_control_native_artifact_run_artifact
  UNIQUE (tenant_id,run_id,artifact_id);
ALTER TABLE control_native_artifact_receipts
  ADD CONSTRAINT uq_control_native_artifact_run_artifact_project
  UNIQUE (tenant_id,run_id,artifact_id,project_id);

CREATE TABLE control_project_coordinator_heads (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  coordinator_identity_id text NOT NULL,
  coordinator_actor_type text NOT NULL CHECK (coordinator_actor_type IN ('human','agent')),
  executor_id text,
  adapter_id text,
  connector_profile_digest text CHECK (connector_profile_digest IS NULL OR connector_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  execution_binding_digest text CHECK (execution_binding_digest IS NULL OR execution_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  assigned_by_owner_identity_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  assigned_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= assigned_at),
  revoked_at timestamptz,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,coordinator_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,assigned_by_owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= assigned_at),
  CHECK ((coordinator_actor_type='human' AND executor_id IS NULL AND adapter_id IS NULL
      AND connector_profile_digest IS NULL AND execution_binding_digest IS NULL)
    OR (coordinator_actor_type='agent' AND executor_id IS NOT NULL AND adapter_id IS NOT NULL
      AND execution_binding_digest IS NOT NULL))
);

CREATE FUNCTION guard_project_coordinator_head_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.project_id<>OLD.project_id
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'project coordinator head update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_project_coordinator_head_update() FROM PUBLIC;
CREATE TRIGGER control_project_coordinator_heads_guard
  BEFORE UPDATE ON control_project_coordinator_heads
  FOR EACH ROW EXECUTE FUNCTION guard_project_coordinator_head_update();
CREATE TRIGGER control_project_coordinator_heads_no_delete
  BEFORE DELETE ON control_project_coordinator_heads
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordinator_heads_no_truncate
  BEFORE TRUNCATE ON control_project_coordinator_heads
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_project_coordination_proposals (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  coordinator_identity_id text NOT NULL,
  coordinator_version bigint NOT NULL CHECK (coordinator_version >= 1),
  source_run_id text NOT NULL,
  source_artifact_id text NOT NULL,
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^sha256:[a-f0-9]{64}$'),
  source_receipt_digest text NOT NULL CHECK (source_receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  source_execution_binding_digest text NOT NULL CHECK (source_execution_binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  validation_state text NOT NULL CHECK (validation_state IN ('accepted','rejected')),
  proposal_schema text,
  proposal_digest text CHECK (proposal_digest IS NULL OR proposal_digest ~ '^sha256:[a-f0-9]{64}$'),
  proposal jsonb,
  action_set jsonb NOT NULL CHECK (jsonb_typeof(action_set)='array'),
  task_count integer NOT NULL CHECK (task_count BETWEEN 0 AND 32),
  edge_count integer NOT NULL CHECK (edge_count BETWEEN 0 AND 64),
  safe_reason_code text,
  ingested_at timestamptz NOT NULL,
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_run_id),
  UNIQUE (tenant_id,id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,coordinator_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,source_artifact_id,project_id)
    REFERENCES control_native_artifact_receipts(tenant_id,run_id,artifact_id,project_id) ON DELETE RESTRICT,
  CHECK ((validation_state='accepted' AND proposal_schema IS NOT NULL
      AND proposal_schema='control-room.project-coordination-proposal/v1'
      AND proposal_digest IS NOT NULL AND proposal IS NOT NULL AND jsonb_typeof(proposal)='object'
      AND safe_reason_code IS NULL)
    OR (validation_state='rejected' AND proposal_schema IS NULL AND proposal_digest IS NULL
      AND proposal IS NULL AND safe_reason_code IS NOT NULL))
);

CREATE TABLE control_project_delegation_policies (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  coordinator_identity_id text NOT NULL,
  coordinator_version bigint NOT NULL CHECK (coordinator_version >= 1),
  state text NOT NULL CHECK (state IN ('active','paused','revoked')),
  version bigint NOT NULL CHECK (version >= 1),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  owner_identity_digest text NOT NULL CHECK (owner_identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  allowed_actions jsonb NOT NULL CHECK (jsonb_typeof(allowed_actions)='array'),
  eligible_routes jsonb NOT NULL CHECK (jsonb_typeof(eligible_routes)='array'),
  risk_ceiling text NOT NULL CHECK (risk_ceiling IN ('low','medium','high','critical')),
  effect_ceiling text NOT NULL CHECK (effect_ceiling IN ('none','approval_required','preauthorized')),
  max_total_tasks integer NOT NULL CHECK (max_total_tasks BETWEEN 1 AND 1024),
  max_total_cost_microusd bigint NOT NULL CHECK (max_total_cost_microusd >= 0),
  max_concurrent_tasks integer NOT NULL CHECK (max_concurrent_tasks BETWEEN 1 AND 32),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL CHECK (valid_until > valid_from),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,coordinator_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_control_project_delegation_policy_current
  ON control_project_delegation_policies(tenant_id,project_id,coordinator_version)
  WHERE state IN ('active','paused');

CREATE FUNCTION guard_project_delegation_policy_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='revoked' OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at
    OR (to_jsonb(NEW)-ARRAY['state','version','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','version','updated_at']) THEN
    RAISE EXCEPTION 'project delegation policy update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_project_delegation_policy_update() FROM PUBLIC;
CREATE TRIGGER control_project_delegation_policies_guard
  BEFORE UPDATE ON control_project_delegation_policies
  FOR EACH ROW EXECUTE FUNCTION guard_project_delegation_policy_update();
CREATE TRIGGER control_project_delegation_policies_no_delete
  BEFORE DELETE ON control_project_delegation_policies
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_delegation_policies_no_truncate
  BEFORE TRUNCATE ON control_project_delegation_policies
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_project_coordination_operation_receipts (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  proposal_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('proposal.adopt','tasks.plan','tasks.assign','review.request')),
  authorization_kind text NOT NULL CHECK (authorization_kind IN ('owner','policy')),
  initiating_identity_id text NOT NULL,
  policy_id text,
  policy_version bigint,
  policy_digest text CHECK (policy_digest IS NULL OR policy_digest ~ '^sha256:[a-f0-9]{64}$'),
  coordinator_version bigint NOT NULL CHECK (coordinator_version >= 1),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  task_units integer NOT NULL CHECK (task_units BETWEEN 0 AND 32),
  admitted_cost_microusd bigint CHECK (admitted_cost_microusd IS NULL OR admitted_cost_microusd >= 0),
  cost_evidence_digest text CHECK (cost_evidence_digest IS NULL OR cost_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  concurrency_units integer NOT NULL CHECK (concurrency_units BETWEEN 0 AND 32),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  committed_at timestamptz NOT NULL,
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id),
  UNIQUE (tenant_id,authorization_kind,initiating_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,proposal_id,project_id)
    REFERENCES control_project_coordination_proposals(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,initiating_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,policy_id,project_id)
    REFERENCES control_project_delegation_policies(tenant_id,id,project_id) ON DELETE RESTRICT,
  CHECK ((authorization_kind='owner' AND policy_id IS NULL AND policy_version IS NULL AND policy_digest IS NULL)
    OR (authorization_kind='policy' AND policy_id IS NOT NULL AND policy_version IS NOT NULL AND policy_digest IS NOT NULL)),
  CHECK ((admitted_cost_microusd IS NULL) = (cost_evidence_digest IS NULL))
);
CREATE UNIQUE INDEX uq_control_project_coordination_proposal_adoption
  ON control_project_coordination_operation_receipts(tenant_id,proposal_id)
  WHERE operation='proposal.adopt';

CREATE TABLE control_project_coordination_operation_jobs (
  tenant_id text NOT NULL,
  operation_receipt_id text NOT NULL,
  proposal_local_id text NOT NULL,
  project_id text NOT NULL,
  canonical_job_id text NOT NULL,
  recommended_route_digest text CHECK (recommended_route_digest IS NULL OR recommended_route_digest ~ '^sha256:[a-f0-9]{64}$'),
  admitted_cost_microusd bigint CHECK (admitted_cost_microusd IS NULL OR admitted_cost_microusd >= 0),
  cost_evidence_digest text CHECK (cost_evidence_digest IS NULL OR cost_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  coordinator_lock boolean NOT NULL DEFAULT false CHECK (coordinator_lock IS FALSE),
  PRIMARY KEY (tenant_id,operation_receipt_id,proposal_local_id),
  UNIQUE (tenant_id,canonical_job_id),
  FOREIGN KEY (tenant_id,operation_receipt_id,project_id)
    REFERENCES control_project_coordination_operation_receipts(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,canonical_job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  CHECK ((admitted_cost_microusd IS NULL) = (cost_evidence_digest IS NULL))
);

CREATE TRIGGER control_project_coordination_proposals_immutable
  BEFORE UPDATE OR DELETE ON control_project_coordination_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordination_proposals_no_truncate
  BEFORE TRUNCATE ON control_project_coordination_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordination_operation_receipts_immutable
  BEFORE UPDATE OR DELETE ON control_project_coordination_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordination_operation_receipts_no_truncate
  BEFORE TRUNCATE ON control_project_coordination_operation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordination_operation_jobs_immutable
  BEFORE UPDATE OR DELETE ON control_project_coordination_operation_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_project_coordination_operation_jobs_no_truncate
  BEFORE TRUNCATE ON control_project_coordination_operation_jobs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
