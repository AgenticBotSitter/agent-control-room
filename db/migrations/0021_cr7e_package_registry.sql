-- CR-7E: immutable procedure and knowledge versions, independent reviews,
-- verified harness mappings, and append-only promotion/rollback history.

CREATE TABLE control_package_versions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('procedure','knowledge')),
  name text NOT NULL,
  version text NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  package_auth_tag text NOT NULL CHECK (package_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  producer_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,project_id,kind,name,version),
  UNIQUE (tenant_id,project_id,package_digest),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_package_reviews (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  package_id text NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  producer_id text NOT NULL,
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','rejected')),
  review_digest text NOT NULL CHECK (review_digest ~ '^sha256:[a-f0-9]{64}$'),
  review_auth_tag text NOT NULL CHECK (review_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  reviewed_at timestamptz NOT NULL,
  CHECK (producer_id <> reviewer_id),
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,package_id) REFERENCES control_package_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id,package_digest) REFERENCES control_package_versions(tenant_id,project_id,package_digest) ON DELETE RESTRICT
);

CREATE TABLE control_package_harness_mappings (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  package_id text NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('verified','rejected')),
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  mapping_auth_tag text NOT NULL CHECK (mapping_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  verified_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,package_id) REFERENCES control_package_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id,package_digest) REFERENCES control_package_versions(tenant_id,project_id,package_digest) ON DELETE RESTRICT
);

CREATE TABLE control_package_channels (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('procedure','knowledge')),
  name text NOT NULL,
  active_package_id text NOT NULL,
  active_package_digest text NOT NULL CHECK (active_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  active_promotion_id text NOT NULL,
  active_promotion_digest text NOT NULL CHECK (active_promotion_digest ~ '^sha256:[a-f0-9]{64}$'),
  channel_auth_tag text NOT NULL CHECK (channel_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,kind,name),
  FOREIGN KEY (tenant_id,active_package_id) REFERENCES control_package_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id,active_package_digest) REFERENCES control_package_versions(tenant_id,project_id,package_digest) ON DELETE RESTRICT
);

CREATE TABLE control_package_promotions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('procedure','knowledge')),
  name text NOT NULL,
  package_id text NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  review_id text NOT NULL,
  mapping_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('promote','rollback')),
  prior_package_id text,
  prior_package_digest text CHECK (prior_package_digest IS NULL OR prior_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  channel_revision bigint NOT NULL CHECK (channel_revision > 0),
  command_digest text NOT NULL CHECK (command_digest ~ '^sha256:[a-f0-9]{64}$'),
  promotion_digest text NOT NULL CHECK (promotion_digest ~ '^sha256:[a-f0-9]{64}$'),
  promotion_auth_tag text NOT NULL CHECK (promotion_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  activated_at timestamptz NOT NULL,
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,promotion_digest),
  UNIQUE (tenant_id,project_id,kind,name,channel_revision),
  FOREIGN KEY (tenant_id,package_id) REFERENCES control_package_versions(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id,package_digest) REFERENCES control_package_versions(tenant_id,project_id,package_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,review_id) REFERENCES control_package_reviews(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,mapping_id) REFERENCES control_package_harness_mappings(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,prior_package_id) REFERENCES control_package_versions(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE control_package_channels
  ADD FOREIGN KEY (tenant_id,active_promotion_id) REFERENCES control_package_promotions(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE control_package_channels
  ADD FOREIGN KEY (tenant_id,active_promotion_digest) REFERENCES control_package_promotions(tenant_id,promotion_digest) ON DELETE RESTRICT;

CREATE INDEX idx_control_package_versions_name ON control_package_versions(tenant_id,project_id,kind,name,created_at DESC);
CREATE INDEX idx_control_package_promotions_channel ON control_package_promotions(tenant_id,project_id,activated_at DESC,id);

CREATE TRIGGER control_package_versions_append_only BEFORE UPDATE OR DELETE ON control_package_versions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_reviews_append_only BEFORE UPDATE OR DELETE ON control_package_reviews FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_harness_mappings_append_only BEFORE UPDATE OR DELETE ON control_package_harness_mappings FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_promotions_append_only BEFORE UPDATE OR DELETE ON control_package_promotions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_versions_truncate_guard BEFORE TRUNCATE ON control_package_versions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_reviews_truncate_guard BEFORE TRUNCATE ON control_package_reviews FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_harness_mappings_truncate_guard BEFORE TRUNCATE ON control_package_harness_mappings FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_package_promotions_truncate_guard BEFORE TRUNCATE ON control_package_promotions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
