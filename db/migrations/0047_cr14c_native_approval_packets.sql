-- Signed approval evidence, not an execution transition or a consumable grant.
CREATE TABLE control_native_approval_packets (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,job_id,attempt_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_native_approval_packets_immutable BEFORE UPDATE OR DELETE ON control_native_approval_packets
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_approval_packets_no_truncate BEFORE TRUNCATE ON control_native_approval_packets
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
