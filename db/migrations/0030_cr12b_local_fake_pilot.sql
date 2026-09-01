-- CR12B-IDEA-060: local-only, repository-fake owner session and catalog truth.

CREATE TABLE control_local_pilot_bootstrap_claims (
  code_digest text PRIMARY KEY CHECK (code_digest ~ '^sha256:[a-f0-9]{64}$'),
  tenant_id text NOT NULL,
  session_id text NOT NULL UNIQUE,
  claim_auth_tag text NOT NULL CHECK (claim_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  claimed_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE TABLE control_local_pilot_owner_sessions (
  session_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  identity_id text NOT NULL,
  provider text NOT NULL,
  subject text NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  session_digest text NOT NULL UNIQUE CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  session_auth_tag text NOT NULL CHECK (session_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > authenticated_at),
  FOREIGN KEY (tenant_id,identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_local_pilot_catalog_revisions (
  catalog_id text NOT NULL,
  tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  catalog_digest text NOT NULL UNIQUE CHECK (catalog_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_id,revision),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE TABLE control_local_pilot_catalog_high_water (
  catalog_id text NOT NULL,
  tenant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  checkpoint_digest text NOT NULL UNIQUE CHECK (checkpoint_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (catalog_id,revision),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE TRIGGER control_local_pilot_bootstrap_claims_append_only BEFORE UPDATE OR DELETE ON control_local_pilot_bootstrap_claims FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_bootstrap_claims_truncate_guard BEFORE TRUNCATE ON control_local_pilot_bootstrap_claims FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_owner_sessions_append_only BEFORE UPDATE OR DELETE ON control_local_pilot_owner_sessions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_owner_sessions_truncate_guard BEFORE TRUNCATE ON control_local_pilot_owner_sessions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_catalog_revisions_append_only BEFORE UPDATE OR DELETE ON control_local_pilot_catalog_revisions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_catalog_revisions_truncate_guard BEFORE TRUNCATE ON control_local_pilot_catalog_revisions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_catalog_high_water_append_only BEFORE UPDATE OR DELETE ON control_local_pilot_catalog_high_water FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_local_pilot_catalog_high_water_truncate_guard BEFORE TRUNCATE ON control_local_pilot_catalog_high_water FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
