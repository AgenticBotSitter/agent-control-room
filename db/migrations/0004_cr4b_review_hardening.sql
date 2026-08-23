-- CR-4B review hardening. This is a forward migration; 0003 remains immutable.

-- Tenant-prefix every lineage uniqueness rule, including the adjacent 0001
-- worker-to-machine relationship found during review.
ALTER TABLE control_attempts DROP CONSTRAINT IF EXISTS control_attempts_job_id_attempt_number_key;
ALTER TABLE control_attempts ADD CONSTRAINT uq_control_attempts_tenant_job_number
  UNIQUE (tenant_id, job_id, attempt_number);

ALTER TABLE control_leases DROP CONSTRAINT IF EXISTS control_leases_attempt_id_key;
ALTER TABLE control_leases DROP CONSTRAINT IF EXISTS control_leases_job_id_epoch_key;
ALTER TABLE control_leases ADD CONSTRAINT uq_control_leases_tenant_attempt
  UNIQUE (tenant_id, attempt_id);
ALTER TABLE control_leases ADD CONSTRAINT uq_control_leases_tenant_job_epoch
  UNIQUE (tenant_id, job_id, epoch);
DROP INDEX IF EXISTS uq_control_leases_one_active_job;
CREATE UNIQUE INDEX uq_control_leases_one_active_job
  ON control_leases(tenant_id, job_id) WHERE state = 'active';

ALTER TABLE control_checkpoints DROP CONSTRAINT IF EXISTS control_checkpoints_attempt_id_sequence_key;
ALTER TABLE control_checkpoints ADD CONSTRAINT uq_control_checkpoints_tenant_attempt_sequence
  UNIQUE (tenant_id, attempt_id, sequence);

ALTER TABLE machine_nodes ADD CONSTRAINT uq_machine_nodes_tenant_id_id UNIQUE (tenant_id, id);
ALTER TABLE worker_runtimes DROP CONSTRAINT IF EXISTS worker_runtimes_machine_id_fkey;
ALTER TABLE worker_runtimes ADD CONSTRAINT fk_worker_runtimes_tenant_machine
  FOREIGN KEY (tenant_id, machine_id) REFERENCES machine_nodes(tenant_id, id) ON DELETE RESTRICT;

-- Canonical SHA-256 fields fail closed even for direct SQL or a future adapter.
ALTER TABLE control_workflows ADD CONSTRAINT ck_control_workflows_definition_digest
  CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_jobs ADD CONSTRAINT ck_control_jobs_authority_digest
  CHECK (authority_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_checkpoints ADD CONSTRAINT ck_control_checkpoints_payload_digest
  CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_approvals ADD CONSTRAINT ck_control_approvals_operation_digest
  CHECK (operation_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_effect_intents ADD CONSTRAINT ck_control_effect_intents_operation_digest
  CHECK (operation_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_artifact_manifests ADD CONSTRAINT ck_control_artifacts_content_hash
  CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_inbox ADD CONSTRAINT ck_control_inbox_body_digest
  CHECK (body_digest ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE control_idempotency ADD CONSTRAINT ck_control_idempotency_request_digest
  CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$');

-- One live approval request per exact operation and one intent binding per
-- approval are structural backstops. CR-4C still owns expiry, revocation,
-- actor authorization, digest verification, and atomic consumption.
CREATE UNIQUE INDEX uq_control_approvals_live_operation
  ON control_approvals(tenant_id, operation_digest)
  WHERE state IN ('pending', 'approved');
CREATE UNIQUE INDEX uq_control_effect_intents_approval
  ON control_effect_intents(tenant_id, approval_id)
  WHERE approval_id IS NOT NULL;

-- All canonical entities use caller-supplied authoritative timestamps, but
-- impossible chronology is rejected by the database.
ALTER TABLE control_nodes ADD CONSTRAINT ck_control_nodes_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_requests ADD CONSTRAINT ck_control_requests_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_workflows ADD CONSTRAINT ck_control_workflows_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_jobs ADD CONSTRAINT ck_control_jobs_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_attempts ADD CONSTRAINT ck_control_attempts_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_leases ADD CONSTRAINT ck_control_leases_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_checkpoints ADD CONSTRAINT ck_control_checkpoints_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_approvals ADD CONSTRAINT ck_control_approvals_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_effect_intents ADD CONSTRAINT ck_control_effect_intents_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_services ADD CONSTRAINT ck_control_services_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_schedules ADD CONSTRAINT ck_control_schedules_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_incidents ADD CONSTRAINT ck_control_incidents_timestamp_order CHECK (updated_at >= created_at);
ALTER TABLE control_artifact_manifests ADD CONSTRAINT ck_control_artifacts_timestamp_order CHECK (updated_at >= created_at);

-- Replace the narrow 0003 mirror with coverage for every indexed field used
-- in lineage, scheduling, approval, or effect decisions.
CREATE OR REPLACE FUNCTION validate_control_payload_mirror()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_data jsonb;
BEGIN
  row_data := to_jsonb(NEW);
  IF jsonb_typeof(NEW.payload->'version') IS DISTINCT FROM 'number'
     OR NEW.payload->>'id' IS DISTINCT FROM NEW.id
     OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id
     OR NEW.payload->>'state' IS DISTINCT FROM NEW.state THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  END IF;
  IF (NEW.payload->>'version')::integer IS DISTINCT FROM NEW.version THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  END IF;

  IF TG_TABLE_NAME = 'control_nodes'
     AND NEW.payload->>'identityKeyId' IS DISTINCT FROM row_data->>'identity_key_id' THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_requests'
     AND (NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR NEW.payload->>'idempotencyKey' IS DISTINCT FROM row_data->>'idempotency_key') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_workflows'
     AND (NEW.payload->>'requestId' IS DISTINCT FROM row_data->>'request_id'
       OR NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR NEW.payload->>'definitionDigest' IS DISTINCT FROM row_data->>'definition_digest') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_jobs'
     AND (jsonb_typeof(NEW.payload->'priority') IS DISTINCT FROM 'number'
       OR NEW.payload->>'workflowId' IS DISTINCT FROM row_data->>'workflow_id'
       OR NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR (NEW.payload->>'priority')::integer IS DISTINCT FROM (row_data->>'priority')::integer
       OR NEW.payload->>'requiredCapability' IS DISTINCT FROM row_data->>'required_capability'
       OR NEW.payload#>>'{authority,digest}' IS DISTINCT FROM row_data->>'authority_digest') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_attempts'
     AND (jsonb_typeof(NEW.payload->'attemptNumber') IS DISTINCT FROM 'number'
       OR NEW.payload->>'jobId' IS DISTINCT FROM row_data->>'job_id'
       OR (NEW.payload->>'attemptNumber')::integer IS DISTINCT FROM (row_data->>'attempt_number')::integer
       OR NEW.payload->>'workerId' IS DISTINCT FROM row_data->>'worker_id'
       OR NEW.payload->>'nodeId' IS DISTINCT FROM row_data->>'node_id'
       OR CASE WHEN row_data->>'lease_epoch' IS NULL THEN NEW.payload ? 'leaseEpoch'
               ELSE jsonb_typeof(NEW.payload->'leaseEpoch') IS DISTINCT FROM 'number'
                    OR (NEW.payload->>'leaseEpoch')::bigint IS DISTINCT FROM (row_data->>'lease_epoch')::bigint END) THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_leases'
     AND (jsonb_typeof(NEW.payload->'epoch') IS DISTINCT FROM 'number'
       OR NEW.payload->>'jobId' IS DISTINCT FROM row_data->>'job_id'
       OR NEW.payload->>'attemptId' IS DISTINCT FROM row_data->>'attempt_id'
       OR NEW.payload->>'nodeId' IS DISTINCT FROM row_data->>'node_id'
       OR (NEW.payload->>'epoch')::bigint IS DISTINCT FROM (row_data->>'epoch')::bigint
       OR (NEW.payload->>'acquiredAt')::timestamptz IS DISTINCT FROM (row_data->>'acquired_at')::timestamptz
       OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM (row_data->>'expires_at')::timestamptz
       OR CASE WHEN row_data->>'renewed_at' IS NULL THEN NEW.payload ? 'renewedAt'
               ELSE (NEW.payload->>'renewedAt')::timestamptz IS DISTINCT FROM (row_data->>'renewed_at')::timestamptz END) THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_checkpoints'
     AND (jsonb_typeof(NEW.payload->'sequence') IS DISTINCT FROM 'number'
       OR NEW.payload->>'attemptId' IS DISTINCT FROM row_data->>'attempt_id'
       OR (NEW.payload->>'sequence')::integer IS DISTINCT FROM (row_data->>'sequence')::integer
       OR NEW.payload->>'payloadDigest' IS DISTINCT FROM row_data->>'payload_digest') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_approvals'
     AND (NEW.payload->>'operationDigest' IS DISTINCT FROM row_data->>'operation_digest'
       OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM (row_data->>'expires_at')::timestamptz) THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_effect_intents'
     AND (NEW.payload->>'jobId' IS DISTINCT FROM row_data->>'job_id'
       OR NEW.payload->>'attemptId' IS DISTINCT FROM row_data->>'attempt_id'
       OR NEW.payload->>'approvalId' IS DISTINCT FROM row_data->>'approval_id'
       OR NEW.payload->>'operationDigest' IS DISTINCT FROM row_data->>'operation_digest'
       OR NEW.payload->>'destination' IS DISTINCT FROM row_data->>'destination'
       OR NEW.payload->>'idempotencyKey' IS DISTINCT FROM row_data->>'idempotency_key') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_services'
     AND NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id' THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_schedules'
     AND (NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR CASE WHEN row_data->>'next_run_at' IS NULL THEN NEW.payload ? 'nextRunAt'
               ELSE (NEW.payload->>'nextRunAt')::timestamptz IS DISTINCT FROM (row_data->>'next_run_at')::timestamptz END) THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_incidents'
     AND (NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR NEW.payload->>'nodeId' IS DISTINCT FROM row_data->>'node_id'
       OR NEW.payload->>'severity' IS DISTINCT FROM row_data->>'severity') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  ELSIF TG_TABLE_NAME = 'control_artifact_manifests'
     AND (NEW.payload->>'projectId' IS DISTINCT FROM row_data->>'project_id'
       OR NEW.payload->>'workflowId' IS DISTINCT FROM row_data->>'workflow_id'
       OR NEW.payload->>'jobId' IS DISTINCT FROM row_data->>'job_id'
       OR NEW.payload->>'attemptId' IS DISTINCT FROM row_data->>'attempt_id'
       OR NEW.payload->>'contentHash' IS DISTINCT FROM row_data->>'content_hash') THEN
    RAISE EXCEPTION 'canonical payload mirror mismatch on %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;

-- Row triggers cannot see TRUNCATE. This statement trigger closes that gap in
-- development and tests; CR-4C also revokes TRUNCATE from application roles.
DROP TRIGGER IF EXISTS control_transition_events_truncate_guard ON control_transition_events;
CREATE TRIGGER control_transition_events_truncate_guard
BEFORE TRUNCATE ON control_transition_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
