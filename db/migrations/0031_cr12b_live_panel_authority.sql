-- CR12B-IDEA-090: authenticated native-receipt and live-admission authority history.

CREATE TABLE control_idea_live_authority_events (
  tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  event_kind text NOT NULL CHECK (event_kind IN (
    'native_receipt_accepted','native_receipt_revoked',
    'admission_sealed','admission_revoked','admission_consumed'
  )),
  subject_id text NOT NULL,
  native_receipt_digest text NOT NULL CHECK (native_receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  admission_id text,
  admission_digest text CHECK (admission_digest IS NULL OR admission_digest ~ '^sha256:[a-f0-9]{64}$'),
  window_id text,
  run_id text,
  previous_record_digest text CHECK (previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,revision),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK ((event_kind LIKE 'native_receipt_%' AND admission_id IS NULL AND admission_digest IS NULL AND window_id IS NULL AND run_id IS NULL)
    OR (event_kind LIKE 'admission_%' AND admission_id IS NOT NULL AND admission_digest IS NOT NULL AND window_id IS NOT NULL AND run_id IS NOT NULL))
);

CREATE INDEX idx_control_idea_live_authority_subject
  ON control_idea_live_authority_events(tenant_id,event_kind,subject_id,revision DESC);
CREATE UNIQUE INDEX uq_control_idea_live_admission_consumption
  ON control_idea_live_authority_events(tenant_id,admission_digest)
  WHERE event_kind='admission_consumed';
CREATE UNIQUE INDEX uq_control_idea_live_window_consumption
  ON control_idea_live_authority_events(tenant_id,window_id)
  WHERE event_kind='admission_consumed';
CREATE UNIQUE INDEX uq_control_idea_live_run_consumption
  ON control_idea_live_authority_events(tenant_id,run_id)
  WHERE event_kind='admission_consumed';
CREATE UNIQUE INDEX uq_control_idea_live_admission_seal_id
  ON control_idea_live_authority_events(tenant_id,admission_id)
  WHERE event_kind='admission_sealed';
CREATE UNIQUE INDEX uq_control_idea_live_admission_seal_run
  ON control_idea_live_authority_events(tenant_id,run_id)
  WHERE event_kind='admission_sealed';

CREATE TRIGGER control_idea_live_authority_events_append_only
  BEFORE UPDATE OR DELETE ON control_idea_live_authority_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_live_authority_events_truncate_guard
  BEFORE TRUNCATE ON control_idea_live_authority_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
