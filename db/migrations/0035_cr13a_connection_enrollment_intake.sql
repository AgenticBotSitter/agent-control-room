-- CR13A-LIVE-030: authenticated Hermes connection-enrollment intake evidence.

CREATE TABLE control_connection_enrollment_intake_heads (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 0 AND 10000),
  last_audit_record_digest text CHECK (
    last_audit_record_digest IS NULL OR last_audit_record_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  head_auth_tag text NOT NULL CHECK (head_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  CHECK (
    (last_sequence = 0 AND last_audit_record_digest IS NULL)
    OR (last_sequence > 0 AND last_audit_record_digest IS NOT NULL)
  )
);

CREATE TABLE control_connection_enrollment_intake_receipts (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  delivery_id text NOT NULL,
  enrollment_id text NOT NULL,
  connection_id text NOT NULL,
  node_id text NOT NULL,
  key_id_digest text NOT NULL CHECK (key_id_digest ~ '^sha256:[a-f0-9]{64}$'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
  delivery_evidence_digest text NOT NULL CHECK (delivery_evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  envelope_digest text NOT NULL CHECK (envelope_digest ~ '^sha256:[a-f0-9]{64}$'),
  enrollment_result_digest text NOT NULL CHECK (enrollment_result_digest ~ '^sha256:[a-f0-9]{64}$'),
  registry_revision bigint NOT NULL CHECK (registry_revision > 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_audit_record_digest text CHECK (
    previous_audit_record_digest IS NULL OR previous_audit_record_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  audit_record_digest text NOT NULL UNIQUE CHECK (audit_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  receipt_auth_tag text NOT NULL CHECK (receipt_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id,delivery_id),
  UNIQUE (tenant_id,enrollment_id),
  UNIQUE (tenant_id,sequence),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,connection_id,registry_revision)
    REFERENCES control_connection_enrollments(tenant_id,connection_id,revision) ON DELETE RESTRICT,
  CHECK (
    (sequence = 1 AND previous_audit_record_digest IS NULL)
    OR (sequence > 1 AND previous_audit_record_digest IS NOT NULL)
  )
);

CREATE INDEX idx_control_connection_enrollment_intake_receipts_enrollment
  ON control_connection_enrollment_intake_receipts(tenant_id,enrollment_id);
CREATE INDEX idx_control_connection_enrollment_intake_receipts_sequence
  ON control_connection_enrollment_intake_receipts(tenant_id,sequence);

CREATE TRIGGER control_connection_enrollment_intake_receipts_append_only
  BEFORE UPDATE OR DELETE ON control_connection_enrollment_intake_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_connection_enrollment_intake_receipts_truncate_guard
  BEFORE TRUNCATE ON control_connection_enrollment_intake_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
