CREATE TABLE control_service_incident_heads (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  correlation_key text NOT NULL CHECK (correlation_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  next_generation integer NOT NULL DEFAULT 0 CHECK (next_generation >= 0),
  PRIMARY KEY (tenant_id,correlation_key)
);

CREATE TABLE control_service_incidents (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  correlation_key text NOT NULL CHECK (correlation_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  generation integer NOT NULL CHECK (generation > 0),
  service_id text NOT NULL CHECK (service_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  severity text NOT NULL CHECK (severity IN ('warning','critical')),
  safe_reason_code text NOT NULL CHECK (safe_reason_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  state text NOT NULL CHECK (state IN ('open','resolved')),
  opened_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id,correlation_key,generation),
  UNIQUE (tenant_id,id),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_control_service_incidents_one_open
  ON control_service_incidents(tenant_id,correlation_key) WHERE state='open';
