CREATE TABLE control_project_budget_heads (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL CHECK (project_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$'),
  ceiling_microusd bigint NOT NULL CHECK (ceiling_microusd >= 0),
  PRIMARY KEY (tenant_id,project_id)
);

CREATE TABLE control_project_budget_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  estimated_microusd bigint NOT NULL CHECK (estimated_microusd >= 0),
  state text NOT NULL CHECK (state IN ('active','released')),
  created_at timestamptz NOT NULL,
  released_at timestamptz,
  FOREIGN KEY (tenant_id,project_id) REFERENCES control_project_budget_heads(tenant_id,project_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,id)
);
