-- Result-bound protected worktree audit evidence. Raw paths, scopes, revisions
-- and content digests remain evidence-role-only. This is append-only evidence,
-- not a result writer, browser projection, queue, or execution grant.
CREATE TABLE control_worktree_change_audit_records (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  artifact_id text NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,run_id,artifact_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES control_worktree_change_audit_plans(tenant_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,project_id,job_id,attempt_id)
    REFERENCES control_harness_runs(tenant_id,id,project_id,job_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,artifact_id,project_id)
    REFERENCES control_native_artifact_receipts(tenant_id,run_id,artifact_id,project_id) ON DELETE RESTRICT,
  CONSTRAINT ck_worktree_change_audit_record_mirrors CHECK (
    (record->>'schema'='control-room.worktree-change-audit-record/v1') IS TRUE
    AND (record->'identity'->>'tenantId'=tenant_id) IS TRUE
    AND (record->'identity'->>'projectId'=project_id) IS TRUE
    AND (record->'identity'->>'jobId'=job_id) IS TRUE
    AND (record->'identity'->>'attemptId'=attempt_id) IS TRUE
    AND (record->'identity'->>'runId'=run_id) IS TRUE
    AND (record->'identity'->>'artifactId'=artifact_id) IS TRUE
    AND (record->'plan'->>'schema'='control-room.worktree-change-audit-plan/v1') IS TRUE
    AND (record->'evidence'->>'schema'='control-room.worktree-change-audit-evidence/v1') IS TRUE
    AND (record->'evidence'->>'planDigest'=record->'plan'->>'planDigest') IS TRUE
  )
);

CREATE TRIGGER control_worktree_change_audit_records_immutable
  BEFORE UPDATE OR DELETE ON control_worktree_change_audit_records
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_worktree_change_audit_records_no_truncate
  BEFORE TRUNCATE ON control_worktree_change_audit_records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
