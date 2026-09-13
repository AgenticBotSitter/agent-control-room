-- One committed Codex send slot per canonical queue attempt. It does not prove delivery.
CREATE TABLE control_codex_transmission_intents (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,job_id,attempt_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,attempt_id) REFERENCES control_codex_delivery_envelopes(tenant_id,job_id,attempt_id) ON DELETE RESTRICT
);
CREATE TRIGGER control_codex_transmission_intents_immutable BEFORE UPDATE OR DELETE ON control_codex_transmission_intents
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_codex_transmission_intents_no_truncate BEFORE TRUNCATE ON control_codex_transmission_intents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
