-- CR-8B: authenticated append-only completion-gate records. Review quality,
-- verification evidence, preferences, and consequential approval stay distinct.

CREATE TABLE control_completion_gate_records (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'profile','target','review','verification','finding','revision','preference','approval_request','approval_decision'
  )),
  record_key text NOT NULL,
  subject_id text NOT NULL,
  parent_id text,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,kind,record_key),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_completion_gate_subject
  ON control_completion_gate_records(tenant_id,project_id,kind,subject_id,occurred_at,id);
CREATE INDEX idx_control_completion_gate_parent
  ON control_completion_gate_records(tenant_id,project_id,kind,parent_id,occurred_at,id)
  WHERE parent_id IS NOT NULL;

CREATE TRIGGER control_completion_gate_records_append_only
  BEFORE UPDATE OR DELETE ON control_completion_gate_records
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_completion_gate_records_truncate_guard
  BEFORE TRUNCATE ON control_completion_gate_records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_completion_gate_integrity (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  record_count bigint NOT NULL CHECK (record_count >= 0),
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[a-f0-9]{64}$'),
  state_auth_tag text NOT NULL CHECK (state_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$')
);
