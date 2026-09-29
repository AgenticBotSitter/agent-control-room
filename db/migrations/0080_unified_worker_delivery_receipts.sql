-- One immutable acknowledgement for the topology-neutral controller-to-worker
-- handoff.  It deliberately records only an accepted/rejected delivery receipt;
-- it is not a queue, scheduler, execution record, or permission grant.
CREATE TABLE control_worker_delivery_receipts (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  record jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,job_id,attempt_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT
);

CREATE TRIGGER control_worker_delivery_receipts_immutable
  BEFORE UPDATE OR DELETE ON control_worker_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_worker_delivery_receipts_no_truncate
  BEFORE TRUNCATE ON control_worker_delivery_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
