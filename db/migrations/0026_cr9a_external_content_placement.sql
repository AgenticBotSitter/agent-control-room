-- CR-9A CB-060: protected, fake-backed external content placement command ledger.
-- These tables contain contract records and digest-only effect evidence. They do
-- not contain an endpoint, credential, source lease, source content, or network authority.

CREATE TABLE control_external_content_placement_declarations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  declaration_id text NOT NULL,
  declaration_digest text NOT NULL CHECK (declaration_digest ~ '^sha256:[a-f0-9]{64}$'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  release_digest text NOT NULL CHECK (release_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,declaration_digest),
  UNIQUE (tenant_id,declaration_id),
  FOREIGN KEY (tenant_id,release_digest) REFERENCES control_external_content_releases(tenant_id,release_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_requests (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  adapter_id text NOT NULL,
  declaration_digest text NOT NULL CHECK (declaration_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^cb-placement:[a-f0-9]{64}$'),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,request_digest),
  UNIQUE (tenant_id,request_id),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,operation_digest),
  FOREIGN KEY (tenant_id,declaration_digest) REFERENCES control_external_content_placement_declarations(tenant_id,declaration_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_authorizations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  authorization_id text NOT NULL,
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_request_digest text NOT NULL CHECK (approval_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  approval_decision_digest text NOT NULL CHECK (approval_decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  approval_request_payload jsonb NOT NULL,
  approval_decision_payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  authorized_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,authorization_digest),
  UNIQUE (tenant_id,authorization_id),
  UNIQUE (tenant_id,request_digest),
  FOREIGN KEY (tenant_id,request_digest) REFERENCES control_external_content_placement_requests(tenant_id,request_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_node_attestations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  evidence_id text NOT NULL,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^sha256:[a-f0-9]{64}$'),
  node_id text NOT NULL,
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,evidence_digest),
  UNIQUE (tenant_id,evidence_id),
  UNIQUE (tenant_id,nonce_digest),
  FOREIGN KEY (tenant_id,request_digest) REFERENCES control_external_content_placement_requests(tenant_id,request_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_effect_claims (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  claim_key text NOT NULL CHECK (claim_key ~ '^sha256:[a-f0-9]{64}$'),
  claim_id text NOT NULL,
  claim_digest text NOT NULL CHECK (claim_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  authorization_digest text NOT NULL CHECK (authorization_digest ~ '^sha256:[a-f0-9]{64}$'),
  node_attestation_digest text NOT NULL CHECK (node_attestation_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^cb-placement:[a-f0-9]{64}$'),
  operation_digest text NOT NULL CHECK (operation_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('claimed','executing','accepted','already_applied','rejected','ambiguous')),
  marker_digest text CHECK (marker_digest IS NULL OR marker_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome_digest text CHECK (outcome_digest IS NULL OR outcome_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  version bigint NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  effective_deadline timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,claim_key),
  UNIQUE (tenant_id,claim_id),
  UNIQUE (tenant_id,request_digest),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,operation_digest),
  FOREIGN KEY (tenant_id,request_digest) REFERENCES control_external_content_placement_requests(tenant_id,request_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,authorization_digest) REFERENCES control_external_content_placement_authorizations(tenant_id,authorization_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,node_attestation_digest) REFERENCES control_external_content_placement_node_attestations(tenant_id,evidence_digest) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_pre_effect_markers (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  marker_id text NOT NULL,
  marker_digest text NOT NULL CHECK (marker_digest ~ '^sha256:[a-f0-9]{64}$'),
  claim_key text NOT NULL CHECK (claim_key ~ '^sha256:[a-f0-9]{64}$'),
  claim_digest text NOT NULL CHECK (claim_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  marked_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,marker_digest),
  UNIQUE (tenant_id,marker_id),
  UNIQUE (tenant_id,claim_key),
  FOREIGN KEY (tenant_id,claim_key) REFERENCES control_external_content_placement_effect_claims(tenant_id,claim_key) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_outcomes (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  receipt_id text NOT NULL,
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^sha256:[a-f0-9]{64}$'),
  claim_key text NOT NULL CHECK (claim_key ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('accepted','already_applied','rejected','ambiguous')),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,receipt_digest),
  UNIQUE (tenant_id,receipt_id),
  UNIQUE (tenant_id,claim_key),
  UNIQUE (tenant_id,request_digest),
  FOREIGN KEY (tenant_id,claim_key) REFERENCES control_external_content_placement_effect_claims(tenant_id,claim_key) ON DELETE RESTRICT
);

CREATE TABLE control_external_content_placement_tombstones (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tombstone_id text NOT NULL,
  tombstone_digest text NOT NULL CHECK (tombstone_digest ~ '^sha256:[a-f0-9]{64}$'),
  claim_key text NOT NULL CHECK (claim_key ~ '^sha256:[a-f0-9]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^cb-placement:[a-f0-9]{64}$'),
  outcome_digest text NOT NULL CHECK (outcome_digest ~ '^sha256:[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK (disposition IN ('accepted','already_applied','rejected','ambiguous')),
  payload jsonb NOT NULL,
  record_auth_tag text NOT NULL CHECK (record_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  sealed_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,tombstone_digest),
  UNIQUE (tenant_id,tombstone_id),
  UNIQUE (tenant_id,claim_key),
  UNIQUE (tenant_id,request_digest),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,claim_key) REFERENCES control_external_content_placement_effect_claims(tenant_id,claim_key) ON DELETE RESTRICT
);

CREATE TRIGGER control_external_content_placement_declarations_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_declarations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_requests_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_requests
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_authorizations_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_node_attestations_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_node_attestations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_effect_claims_delete_guard
  BEFORE DELETE ON control_external_content_placement_effect_claims
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_pre_effect_markers_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_pre_effect_markers
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_outcomes_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_tombstones_append_only
  BEFORE UPDATE OR DELETE ON control_external_content_placement_tombstones
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_external_content_placement_declarations_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_declarations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_requests_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_authorizations_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_node_attestations_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_node_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_effect_claims_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_effect_claims
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_pre_effect_markers_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_pre_effect_markers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_outcomes_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_outcomes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_external_content_placement_tombstones_truncate_guard
  BEFORE TRUNCATE ON control_external_content_placement_tombstones
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
