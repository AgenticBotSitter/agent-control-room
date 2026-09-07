CREATE TABLE control_node_operation_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('request_drain','request_resume','request_quarantine')),
  desired_state text NOT NULL CHECK (desired_state IN ('active','draining','quarantined')),
  expected_node_version integer NOT NULL CHECK (expected_node_version >= 0),
  state text NOT NULL CHECK (state IN ('requested','applied','rejected')),
  safe_reason_code text,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  acknowledgement_id text,
  acknowledgement_digest text CHECK (acknowledgement_digest IS NULL OR acknowledgement_digest ~ '^sha256:[a-f0-9]{64}$'),
  safe_result_code text,
  acknowledged_at timestamptz,
  resulting_node_version integer CHECK (resulting_node_version IS NULL OR resulting_node_version >= 0),
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, requested_by, idempotency_key),
  UNIQUE (tenant_id, acknowledgement_id),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((operation='request_quarantine' AND safe_reason_code IS NOT NULL) OR (operation<>'request_quarantine' AND safe_reason_code IS NULL)),
  CHECK ((state='requested' AND acknowledged_at IS NULL AND acknowledgement_id IS NULL AND acknowledgement_digest IS NULL AND resulting_node_version IS NULL)
    OR (state IN ('applied','rejected') AND acknowledged_at IS NOT NULL AND acknowledgement_id IS NOT NULL AND acknowledgement_digest IS NOT NULL))
);

CREATE INDEX idx_node_operation_requests_pending
  ON control_node_operation_requests(tenant_id,node_id,requested_at)
  WHERE state='requested';

CREATE UNIQUE INDEX uq_node_operation_requests_one_pending
  ON control_node_operation_requests(tenant_id,node_id)
  WHERE state='requested';
