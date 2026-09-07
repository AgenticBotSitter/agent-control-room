CREATE TABLE control_node_job_events (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  attempt_id text NOT NULL,
  event_sequence integer NOT NULL CHECK (event_sequence > 0),
  message_id text NOT NULL,
  node_id text NOT NULL,
  job_id text NOT NULL,
  lease_id text NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('started','progress','checkpointed','waiting','completed','failed','cancelled')),
  occurred_at timestamptz NOT NULL,
  body_digest text NOT NULL CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  safe_reason_code text,
  artifact_id text,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,attempt_id,event_sequence),
  UNIQUE (tenant_id,message_id),
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_artifact_lineage (
  artifact_id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  producer_id text NOT NULL,
  lineage_digest text NOT NULL CHECK (lineage_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  producer_claim_digest text NOT NULL CHECK (producer_claim_digest ~ '^sha256:[a-f0-9]{64}$'),
  independent_verification_state text NOT NULL CHECK (independent_verification_state='not_run'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (tenant_id,artifact_id),
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,producer_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_node_job_events_attempt ON control_node_job_events(tenant_id,attempt_id,event_sequence);
CREATE INDEX idx_control_artifact_lineage_attempt ON control_artifact_lineage(tenant_id,attempt_id,recorded_at);
