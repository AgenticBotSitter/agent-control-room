CREATE TABLE control_native_artifact_receipts (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  artifact_id text NOT NULL,
  receipt jsonb NOT NULL,
  auth_tag text NOT NULL,
  PRIMARY KEY (tenant_id,run_id),
  UNIQUE (tenant_id,artifact_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,artifact_id) REFERENCES control_artifact_manifests(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX control_native_artifact_job_catalog ON control_native_artifact_receipts(tenant_id,project_id,job_id,artifact_id COLLATE "C");
CREATE TRIGGER control_native_artifact_receipts_immutable BEFORE UPDATE OR DELETE ON control_native_artifact_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_native_artifact_receipts_no_truncate BEFORE TRUNCATE ON control_native_artifact_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- Existing verified review reads serialize with writers without authority-bearing UPDATE grants.
ALTER TABLE control_completion_gate_integrity ADD COLUMN web_lock boolean NOT NULL DEFAULT false
  CONSTRAINT control_completion_gate_integrity_web_lock CHECK (web_lock IS FALSE);
