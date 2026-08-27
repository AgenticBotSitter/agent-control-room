CREATE TABLE control_resource_reservation_heads (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  resource_key text NOT NULL CHECK (resource_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  capacity_units bigint NOT NULL CHECK (capacity_units > 0),
  PRIMARY KEY (tenant_id,resource_key)
);

CREATE TABLE control_resource_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  route_id text NOT NULL CHECK (route_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  resource_key text NOT NULL CHECK (resource_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  units bigint NOT NULL CHECK (units > 0),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active','released','expired')),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (expires_at > acquired_at),
  FOREIGN KEY (tenant_id,resource_key) REFERENCES control_resource_reservation_heads(tenant_id,resource_key) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id)
);

CREATE INDEX idx_control_resource_reservations_active
  ON control_resource_reservations(tenant_id,resource_key,expires_at) WHERE state='active';
