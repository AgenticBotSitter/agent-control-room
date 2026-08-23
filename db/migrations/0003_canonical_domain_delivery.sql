CREATE TABLE IF NOT EXISTS control_nodes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending_enrollment','active','draining','offline','quarantined','revoked')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  identity_key_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS control_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text,
  state text NOT NULL CHECK (state IN ('draft','submitted','accepted','fulfilled','rejected','cancelled')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS control_workflows (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  project_id text NOT NULL,
  definition_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','active','paused','succeeded','failed','cancelled')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES control_requests(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_jobs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workflow_id text NOT NULL,
  project_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','ready','leased','running','waiting_approval','succeeded','failed','cancelled','orphaned','rejected')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  priority integer NOT NULL CHECK (priority BETWEEN 0 AND 100),
  required_capability text NOT NULL,
  authority_digest text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES control_workflows(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_job_dependencies (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  depends_on_job_id text NOT NULL,
  PRIMARY KEY (tenant_id, job_id, depends_on_job_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, depends_on_job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  CHECK (job_id <> depends_on_job_id)
);

CREATE TABLE IF NOT EXISTS control_attempts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('offered','leased','running','waiting','succeeded','failed','cancelled','orphaned')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  worker_id text,
  node_id text,
  lease_epoch bigint,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (job_id, attempt_number),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, node_id) REFERENCES control_nodes(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_leases (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  node_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  state text NOT NULL CHECK (state IN ('active','expired','released','revoked')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  renewed_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (job_id, epoch),
  CHECK (expires_at > acquired_at),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, node_id) REFERENCES control_nodes(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_control_leases_one_active_job
  ON control_leases(job_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS control_checkpoints (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  attempt_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  state text NOT NULL CHECK (state IN ('declared','stored','verified','rejected')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload_digest text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (attempt_id, sequence),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_approvals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','approved','denied','expired','revoked')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS control_effect_intents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  approval_id text,
  operation_digest text NOT NULL,
  destination text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','authorized','executing','confirmed','failed','ambiguous','cancelled')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, destination, operation_digest, idempotency_key),
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, approval_id) REFERENCES control_approvals(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_services (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','degraded','paused','failed','retired')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS control_schedules (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','paused','disabled')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  next_run_at timestamptz,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS control_incidents (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text,
  node_id text,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  state text NOT NULL CHECK (state IN ('open','acknowledged','mitigating','resolved','closed')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, node_id) REFERENCES control_nodes(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_artifact_manifests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  workflow_id text,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  content_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('declared','uploaded','verified','quarantined','rejected','deleted')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_hash, job_id, attempt_id),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES control_workflows(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id) REFERENCES control_jobs(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES control_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS control_transition_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entity_kind text NOT NULL,
  entity_id text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  from_version integer NOT NULL,
  to_version integer NOT NULL,
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent','service','node')),
  idempotency_key text NOT NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  UNIQUE (tenant_id, entity_kind, entity_id, idempotency_key),
  CHECK (entity_kind IN ('request','workflow','job','attempt','lease','checkpoint','effect_intent','approval','service','schedule','incident','artifact_manifest','node')),
  CHECK (from_state <> to_state),
  CHECK (to_version = from_version + 1)
);

CREATE TABLE IF NOT EXISTS control_inbox (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  protocol text NOT NULL,
  message_id text NOT NULL,
  body_digest text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  safe_failure_code text,
  PRIMARY KEY (tenant_id, protocol, message_id)
);

CREATE TABLE IF NOT EXISTS control_outbox (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  claimed_at timestamptz,
  claim_token text,
  delivered_at timestamptz,
  safe_failure_code text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, topic, idempotency_key)
);

CREATE TABLE IF NOT EXISTS control_idempotency (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  operation_scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing','completed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, operation_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_control_jobs_ready ON control_jobs(tenant_id, priority DESC, created_at) WHERE state = 'ready';
CREATE INDEX IF NOT EXISTS idx_control_attempts_job ON control_attempts(job_id, attempt_number DESC);
CREATE INDEX IF NOT EXISTS idx_control_leases_expiry ON control_leases(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_control_effects_attention ON control_effect_intents(tenant_id, state) WHERE state = 'ambiguous';
CREATE INDEX IF NOT EXISTS idx_control_inbox_status ON control_inbox(status, received_at);
CREATE INDEX IF NOT EXISTS idx_control_outbox_delivery ON control_outbox(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_control_transition_entity ON control_transition_events(tenant_id, entity_kind, entity_id, occurred_at);

CREATE OR REPLACE FUNCTION validate_control_payload_mirror()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.payload->>'id' IS DISTINCT FROM NEW.id
     OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
     OR NEW.payload->>'state' IS DISTINCT FROM NEW.state
     OR (NEW.payload->>'version')::integer IS DISTINCT FROM NEW.version THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS control_nodes_payload_mirror ON control_nodes;
CREATE TRIGGER control_nodes_payload_mirror BEFORE INSERT OR UPDATE ON control_nodes FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_requests_payload_mirror ON control_requests;
CREATE TRIGGER control_requests_payload_mirror BEFORE INSERT OR UPDATE ON control_requests FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_workflows_payload_mirror ON control_workflows;
CREATE TRIGGER control_workflows_payload_mirror BEFORE INSERT OR UPDATE ON control_workflows FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_jobs_payload_mirror ON control_jobs;
CREATE TRIGGER control_jobs_payload_mirror BEFORE INSERT OR UPDATE ON control_jobs FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_attempts_payload_mirror ON control_attempts;
CREATE TRIGGER control_attempts_payload_mirror BEFORE INSERT OR UPDATE ON control_attempts FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_leases_payload_mirror ON control_leases;
CREATE TRIGGER control_leases_payload_mirror BEFORE INSERT OR UPDATE ON control_leases FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_checkpoints_payload_mirror ON control_checkpoints;
CREATE TRIGGER control_checkpoints_payload_mirror BEFORE INSERT OR UPDATE ON control_checkpoints FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_approvals_payload_mirror ON control_approvals;
CREATE TRIGGER control_approvals_payload_mirror BEFORE INSERT OR UPDATE ON control_approvals FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_effect_intents_payload_mirror ON control_effect_intents;
CREATE TRIGGER control_effect_intents_payload_mirror BEFORE INSERT OR UPDATE ON control_effect_intents FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_services_payload_mirror ON control_services;
CREATE TRIGGER control_services_payload_mirror BEFORE INSERT OR UPDATE ON control_services FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_schedules_payload_mirror ON control_schedules;
CREATE TRIGGER control_schedules_payload_mirror BEFORE INSERT OR UPDATE ON control_schedules FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_incidents_payload_mirror ON control_incidents;
CREATE TRIGGER control_incidents_payload_mirror BEFORE INSERT OR UPDATE ON control_incidents FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();
DROP TRIGGER IF EXISTS control_artifact_manifests_payload_mirror ON control_artifact_manifests;
CREATE TRIGGER control_artifact_manifests_payload_mirror BEFORE INSERT OR UPDATE ON control_artifact_manifests FOR EACH ROW EXECUTE FUNCTION validate_control_payload_mirror();

DROP TRIGGER IF EXISTS control_transition_events_append_only ON control_transition_events;
CREATE TRIGGER control_transition_events_append_only
BEFORE UPDATE OR DELETE ON control_transition_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
