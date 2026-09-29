-- Protected, manager-derived worktree audit plans.  The plan contains paths,
-- revision and lease-derived data; only the evidence role may read it.  This
-- table is not a queue, worker command, result publication, or browser feed.
CREATE TABLE control_worktree_change_audit_plans (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,project_id,job_id,attempt_id)
    REFERENCES control_harness_runs(tenant_id,id,project_id,job_id,attempt_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,attempt_id) REFERENCES control_worker_delivery_receipts(tenant_id,job_id,attempt_id) ON DELETE RESTRICT,
  CONSTRAINT ck_worktree_change_audit_plan_mirrors CHECK (
    record->>'schema'='control-room.worktree-change-audit-plan-record/v1'
    AND record->'identity'->>'tenantId'=tenant_id
    AND record->'identity'->>'projectId'=project_id
    AND record->'identity'->>'jobId'=job_id
    AND record->'identity'->>'attemptId'=attempt_id
    AND record->'identity'->>'runId'=run_id
    AND record->'plan'->>'schema'='control-room.worktree-change-audit-plan/v1'
    AND record->'plan'->>'deliveryDigest'=record->>'deliveryDigest'
  )
);

CREATE TRIGGER control_worktree_change_audit_plans_immutable
  BEFORE UPDATE OR DELETE ON control_worktree_change_audit_plans
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_worktree_change_audit_plans_no_truncate
  BEFORE TRUNCATE ON control_worktree_change_audit_plans
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
