-- Harness-neutral durable result reservations. This is deliberately a sibling
-- of the native-only table from migration 0071: neither schema literal nor
-- role boundary is widened to make a different record shape fit.
ALTER TABLE control_harness_runs ADD CONSTRAINT uq_control_harness_runs_result_lineage
  UNIQUE (tenant_id,id,project_id,job_id,attempt_id);

CREATE TABLE control_durable_result_write_reservations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  run_id text NOT NULL,
  artifact_id text NOT NULL,
  identity_digest text NOT NULL CONSTRAINT ck_durable_result_reservation_identity_digest
    CHECK (identity_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CONSTRAINT ck_durable_result_reservation_state
    CHECK (state IN ('reserved','bytes_verified','metadata_committed','storage_uncertain')),
  contract_digest text NOT NULL CONSTRAINT ck_durable_result_reservation_contract_digest
    CHECK (contract_digest ~ '^sha256:[a-f0-9]{64}$'),
  reservation jsonb NOT NULL,
  auth_tag text NOT NULL CONSTRAINT ck_durable_result_reservation_auth_tag
    CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,run_id),
  UNIQUE (tenant_id,artifact_id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,project_id,job_id,attempt_id)
    REFERENCES control_harness_runs(tenant_id,id,project_id,job_id,attempt_id) ON DELETE RESTRICT,
  CONSTRAINT ck_durable_result_reservation_mirrors CHECK (
    (jsonb_typeof(reservation)='object'
    AND reservation->>'schema'='control-room.durable-result-write-reservation/v1'
    AND reservation->'identity'->>'tenantId'=tenant_id
    AND reservation->'identity'->>'projectId'=project_id
    AND reservation->'identity'->>'jobId'=job_id
    AND reservation->'identity'->>'attemptId'=attempt_id
    AND reservation->'identity'->>'runId'=run_id
    AND reservation->'identity'->>'artifactId'=artifact_id
    AND reservation->>'identityDigest'=identity_digest
    AND reservation->>'state'=state
    AND reservation->>'contractDigest'=contract_digest) IS TRUE
  ),
  CONSTRAINT ck_durable_result_reservation_time CHECK (updated_at >= created_at)
);

CREATE FUNCTION guard_durable_result_write_reservation_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
    OR NEW.identity_digest IS DISTINCT FROM OLD.identity_digest
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'durable result reservation identity is immutable';
  END IF;
  IF NOT ((OLD.state='reserved' AND NEW.state IN ('bytes_verified','storage_uncertain'))
    OR (OLD.state='bytes_verified' AND NEW.state IN ('metadata_committed','storage_uncertain'))) THEN
    RAISE EXCEPTION 'durable result reservation transition rejected';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION guard_durable_result_write_reservation_update() FROM PUBLIC;
CREATE TRIGGER control_durable_result_write_reservations_guard BEFORE UPDATE
  ON control_durable_result_write_reservations FOR EACH ROW
  EXECUTE FUNCTION guard_durable_result_write_reservation_update();
CREATE TRIGGER control_durable_result_write_reservations_immutable BEFORE DELETE
  ON control_durable_result_write_reservations FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_durable_result_write_reservations_no_truncate BEFORE TRUNCATE
  ON control_durable_result_write_reservations FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
