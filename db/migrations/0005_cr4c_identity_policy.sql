CREATE TABLE control_identities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent','service','node')),
  display_name text NOT NULL,
  auth_provider text NOT NULL,
  auth_subject_digest text NOT NULL CHECK (auth_subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('active','suspended','revoked')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, auth_provider, auth_subject_digest),
  CHECK (updated_at >= created_at)
);

CREATE TABLE control_role_grants (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id text NOT NULL,
  role_key text NOT NULL,
  allowed_actions jsonb NOT NULL CHECK (jsonb_typeof(allowed_actions) = 'array'),
  project_ids jsonb NOT NULL CHECK (jsonb_typeof(project_ids) = 'array'),
  risk_ceiling text NOT NULL CHECK (risk_ceiling IN ('low','medium','high','critical')),
  allow_external_effects boolean NOT NULL DEFAULT false,
  require_strong_factor boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE control_policy_decisions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  identity_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  project_id text,
  risk text NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  external_effect boolean NOT NULL,
  allowed boolean NOT NULL,
  reason_codes jsonb NOT NULL CHECK (jsonb_typeof(reason_codes) = 'array'),
  grant_ids jsonb NOT NULL CHECK (jsonb_typeof(grant_ids) = 'array'),
  strong_factor_evidence_id text,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  decided_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > decided_at),
  CHECK (allowed OR jsonb_array_length(reason_codes) > 0)
);

CREATE TABLE control_approval_consumptions (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  approval_id text NOT NULL,
  effect_intent_id text NOT NULL,
  policy_decision_id text NOT NULL,
  operation_digest text NOT NULL CHECK (operation_digest ~ '^sha256:[0-9a-f]{64}$'),
  consumed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, approval_id),
  UNIQUE (tenant_id, effect_intent_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES control_approvals(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, effect_intent_id) REFERENCES control_effect_intents(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, policy_decision_id) REFERENCES control_policy_decisions(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_role_grants_identity ON control_role_grants(tenant_id, identity_id);
CREATE INDEX idx_control_policy_decisions_resource ON control_policy_decisions(tenant_id, resource_type, resource_id, decided_at DESC);

DROP TRIGGER IF EXISTS control_policy_decisions_append_only ON control_policy_decisions;
CREATE TRIGGER control_policy_decisions_append_only
BEFORE UPDATE OR DELETE ON control_policy_decisions
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
DROP TRIGGER IF EXISTS control_policy_decisions_truncate_guard ON control_policy_decisions;
CREATE TRIGGER control_policy_decisions_truncate_guard
BEFORE TRUNCATE ON control_policy_decisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS control_approval_consumptions_append_only ON control_approval_consumptions;
CREATE TRIGGER control_approval_consumptions_append_only
BEFORE UPDATE OR DELETE ON control_approval_consumptions
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
DROP TRIGGER IF EXISTS control_approval_consumptions_truncate_guard ON control_approval_consumptions;
CREATE TRIGGER control_approval_consumptions_truncate_guard
BEFORE TRUNCATE ON control_approval_consumptions
FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
