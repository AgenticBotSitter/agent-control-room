-- Owner browser subscriptions. Endpoints and encryption keys remain only in the private database.
CREATE TABLE owner_web_push_subscriptions (
  id text NOT NULL CHECK (id ~ '^push:[a-f0-9]{64}$'),
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^[:space:]]+$'),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]+$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]+$'),
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,endpoint)
);
REVOKE ALL ON owner_web_push_subscriptions FROM PUBLIC;
