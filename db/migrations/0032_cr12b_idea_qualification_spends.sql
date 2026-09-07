-- CR12B-IDEA-110A: append-only, one-use Hermes qualification permit spending.

CREATE TABLE control_idea_qualification_spend_events (
  tenant_id text NOT NULL,
  permit_digest text NOT NULL CHECK (permit_digest ~ '^sha256:[a-f0-9]{64}$'),
  sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  event_kind text NOT NULL CHECK (event_kind IN (
    'claimed','execute_returned','terminal_ambiguity','cleanup_completed','cleanup_uncertain'
  )),
  attempt_id text NOT NULL,
  marker_digest text NOT NULL CHECK (marker_digest ~ '^sha256:[a-f0-9]{64}$'),
  previous_record_digest text CHECK (previous_record_digest IS NULL OR previous_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL UNIQUE CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,permit_digest,sequence),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CHECK ((sequence=1 AND event_kind='claimed' AND previous_record_digest IS NULL)
    OR (sequence=2 AND event_kind IN ('execute_returned','terminal_ambiguity') AND previous_record_digest IS NOT NULL)
    OR (sequence=3 AND event_kind IN ('cleanup_completed','cleanup_uncertain') AND previous_record_digest IS NOT NULL))
);

CREATE UNIQUE INDEX uq_control_idea_qualification_attempt
  ON control_idea_qualification_spend_events(tenant_id,attempt_id)
  WHERE event_kind='claimed';
CREATE UNIQUE INDEX uq_control_idea_qualification_marker
  ON control_idea_qualification_spend_events(tenant_id,marker_digest)
  WHERE event_kind='claimed';

CREATE TRIGGER control_idea_qualification_spend_events_append_only
  BEFORE UPDATE OR DELETE ON control_idea_qualification_spend_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_qualification_spend_events_truncate_guard
  BEFORE TRUNCATE ON control_idea_qualification_spend_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
