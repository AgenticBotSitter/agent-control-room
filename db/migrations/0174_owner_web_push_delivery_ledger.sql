-- A durable send reservation prevents duplicates on scheduler restart or a lost delivery acknowledgement.
CREATE TABLE owner_web_push_deliveries (
  tenant_id text NOT NULL,
  subscription_id text NOT NULL,
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z][a-z0-9:_-]{2,180}$'),
  state text NOT NULL CHECK (state IN ('reserved','delivered','failed')),
  status_code integer CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  attempted_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,subscription_id,dedupe_key),
  FOREIGN KEY (tenant_id,subscription_id) REFERENCES owner_web_push_subscriptions(tenant_id,id) ON DELETE CASCADE,
  CHECK ((state='reserved' AND completed_at IS NULL) OR (state IN ('delivered','failed') AND completed_at IS NOT NULL))
);
CREATE INDEX owner_web_push_deliveries_retain ON owner_web_push_deliveries(tenant_id,attempted_at);
REVOKE ALL ON owner_web_push_deliveries FROM PUBLIC;
