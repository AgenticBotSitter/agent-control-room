-- Exact Codex result evidence only. Rows authorize no process, retry, completion or capacity effect.
CREATE TABLE control_codex_result_publications (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  publication_id text NOT NULL,
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,run_id),
  UNIQUE (tenant_id,publication_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id) REFERENCES control_harness_runs(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT ck_codex_result_publication_mirrors CHECK (
    record->>'schema'='control-room.codex-canonical-result-record/v1'
    AND record->'publication'->'identity'->>'tenantId'=tenant_id
    AND record->'publication'->'identity'->>'projectId'=project_id
    AND record->'publication'->'identity'->>'jobId'=job_id
    AND record->'publication'->'identity'->>'attemptId'=attempt_id
    AND record->'publication'->'identity'->>'runId'=run_id
    AND record->'publication'->>'publicationId'=publication_id
    AND record->>'recordDigest'=record_digest
  )
);
CREATE TRIGGER control_codex_result_publications_immutable BEFORE UPDATE OR DELETE
  ON control_codex_result_publications FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_codex_result_publications_no_truncate BEFORE TRUNCATE
  ON control_codex_result_publications FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
