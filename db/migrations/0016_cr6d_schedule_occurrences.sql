CREATE TABLE control_schedule_occurrences (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  schedule_id text NOT NULL CHECK (schedule_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  occurrence_key text NOT NULL CHECK (occurrence_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  target_type text NOT NULL CHECK (target_type IN ('workflow','job','service_check')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^sha256:[a-f0-9]{64}$'),
  scheduled_for timestamptz NOT NULL,
  local_time text NOT NULL CHECK (local_time ~ '^[0-9TZ:.+-]{16,40}$'),
  state text NOT NULL CHECK (state IN ('pending','dispatched','cancelled')),
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  PRIMARY KEY (tenant_id,schedule_id,occurrence_key),
  CHECK ((state = 'dispatched') = (dispatched_at IS NOT NULL))
);

CREATE INDEX idx_control_schedule_occurrences_pending
  ON control_schedule_occurrences(tenant_id,state,scheduled_for) WHERE state='pending';
