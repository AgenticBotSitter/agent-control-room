-- CR-9A: isolated, source-scheduled external content read synchronization.
-- Source records remain authoritative. These tables contain sanitized projections,
-- digest-only evidence, and opaque cursors; no source command or lease is stored.

CREATE TABLE control_external_content_releases (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  release_digest text NOT NULL CHECK (release_digest ~ '^sha256:[a-f0-9]{64}$'),
  release_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  payload jsonb NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,release_digest),
  UNIQUE (tenant_id,release_id)
);

CREATE TABLE control_external_content_state (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  state_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,state_id),
  UNIQUE (tenant_id,workspace_id,project_id,adapter_id)
);

CREATE TABLE control_external_content_read_receipts (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_id text NOT NULL,
  request_id text NOT NULL,
  page_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  release_digest text NOT NULL,
  control_state_digest text NOT NULL CHECK (control_state_digest ~ '^sha256:[a-f0-9]{64}$'),
  operation text NOT NULL CHECK (operation IN ('getProjectSummary','listWorkItems','listExecutions','listBlockers','listWorkers','listAttentionItems','readChanges')),
  next_cursor_value text NOT NULL,
  next_cursor_digest text NOT NULL CHECK (next_cursor_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,receipt_digest),
  UNIQUE (tenant_id,adapter_id,request_id,page_id),
  FOREIGN KEY (tenant_id,release_digest) REFERENCES control_external_content_releases(tenant_id,release_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_streams (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('getProjectSummary','listWorkItems','listExecutions','listBlockers','listWorkers','listAttentionItems','readChanges')),
  cursor_value text NOT NULL,
  cursor_digest text NOT NULL CHECK (cursor_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,adapter_id,operation),
  FOREIGN KEY (tenant_id,receipt_digest) REFERENCES control_external_content_read_receipts(tenant_id,receipt_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_record_history (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('project','work_item','execution','blocker','worker','attention')),
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('upsert','remove')),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,adapter_id,kind,source_record_id,source_version),
  FOREIGN KEY (tenant_id,receipt_digest) REFERENCES control_external_content_read_receipts(tenant_id,receipt_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_current_records (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('project','work_item','execution','blocker','worker','attention')),
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_digest text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,adapter_id,kind,source_record_id),
  FOREIGN KEY (tenant_id,receipt_digest) REFERENCES control_external_content_read_receipts(tenant_id,receipt_digest) ON DELETE RESTRICT
);

CREATE INDEX idx_external_content_current_scope
  ON control_external_content_current_records(tenant_id,workspace_id,project_id,kind,source_record_id);

CREATE TRIGGER control_external_content_releases_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_releases
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_read_receipts_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_read_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_record_history_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_record_history
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
