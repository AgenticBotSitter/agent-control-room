-- Saved loop lineage is inert, signed and append only. No pipeline or launch records.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_loop_improvement_requests (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id,owner_identity_id),
  UNIQUE (tenant_id,owner_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,owner_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_loop_improvement_inputs (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 8000 AND description ~ '[^[:space:]]'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  settings_text text NOT NULL CHECK (octet_length(settings_text) <= 65536 AND jsonb_typeof(settings_text::jsonb) = 'object'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,request_id,version),
  UNIQUE (tenant_id,request_id,version,project_id,owner_identity_id),
  UNIQUE (tenant_id,owner_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,request_id,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_requests(tenant_id,id,project_id,owner_identity_id) ON DELETE RESTRICT
);

CREATE TABLE control_loop_improvement_run_links (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  initial_input_version bigint NOT NULL CHECK (initial_input_version BETWEEN 1 AND 9007199254740991),
  adapter_id text NOT NULL CHECK (adapter_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  loop_run_id text NOT NULL CHECK (loop_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  tooling_revision text NOT NULL CHECK (tooling_revision ~ '^sha256:[a-f0-9]{64}$'),
  a2_schema_version integer NOT NULL CHECK (a2_schema_version = 1),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_id),
  UNIQUE (tenant_id,adapter_id,loop_run_id),
  UNIQUE (tenant_id,id,request_id,project_id,owner_identity_id),
  FOREIGN KEY (tenant_id,request_id,initial_input_version,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_inputs(tenant_id,request_id,version,project_id,owner_identity_id) ON DELETE RESTRICT
);

CREATE TABLE control_loop_improvement_authorizations (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  input_version bigint NOT NULL CHECK (input_version BETWEEN 1 AND 9007199254740991),
  run_link_id text NOT NULL CHECK (run_link_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  start_key text NOT NULL CHECK (start_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[a-f0-9]{64}$'),
  a2_input_version jsonb NOT NULL CHECK (jsonb_typeof(a2_input_version) IN ('string','number')),
  a2_settings_digest text NOT NULL CHECK (length(a2_settings_digest) BETWEEN 1 AND 180),
  observed_revision bigint NOT NULL CHECK (observed_revision BETWEEN 0 AND 9007199254740991),
  confirmation jsonb NOT NULL CHECK (jsonb_typeof(confirmation) = 'object'
    AND confirmation ?& ARRAY['path','sha256','at','who','input_version']
    AND confirmation - ARRAY['path','sha256','at','who','input_version'] = '{}'::jsonb
    AND jsonb_typeof(confirmation->'path') = 'string'
    AND length(confirmation->>'path') BETWEEN 1 AND 512
    AND confirmation->>'path' ~ '^[A-Za-z0-9._/-]+$'
    AND confirmation->>'path' !~ '(^/|(^|/)\.\.?(/|$))'
    AND jsonb_typeof(confirmation->'sha256') = 'string'
    AND confirmation->>'sha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(confirmation->'at') = 'string'
    AND confirmation->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
    AND jsonb_typeof(confirmation->'who') = 'string'
    AND confirmation->>'who' = 'owner'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,owner_identity_id,start_key),
  UNIQUE (tenant_id,request_id,input_version),
  FOREIGN KEY (tenant_id,run_link_id,request_id,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_run_links(tenant_id,id,request_id,project_id,owner_identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,request_id,input_version,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_inputs(tenant_id,request_id,version,project_id,owner_identity_id) ON DELETE RESTRICT
);

CREATE INDEX control_loop_improvement_requests_project_created
  ON control_loop_improvement_requests(tenant_id,project_id,created_at DESC,id DESC);

CREATE FUNCTION guard_control_loop_improvement_lineage_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- Serialize even direct INSERTs with the service's per-owner authority lock.
  PERFORM 1 FROM control_identities WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_identity_id FOR UPDATE;
  IF TG_TABLE_NAME = 'control_loop_improvement_requests' THEN
    IF NOT EXISTS (SELECT 1 FROM projects WHERE tenant_id=NEW.tenant_id AND id=NEW.project_id)
      OR NOT EXISTS (SELECT 1 FROM control_identities WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_identity_id) THEN
      RAISE EXCEPTION 'loop root binding rejected' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'control_loop_improvement_inputs' THEN
    IF NOT EXISTS (SELECT 1 FROM control_loop_improvement_requests WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id
      AND project_id=NEW.project_id AND owner_identity_id=NEW.owner_identity_id)
      OR NEW.version <> (SELECT coalesce(max(version),0)+1 FROM control_loop_improvement_inputs
        WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'loop input version or binding rejected' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'control_loop_improvement_run_links' THEN
    IF NOT EXISTS (SELECT 1 FROM control_loop_improvement_inputs WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id
      AND version=NEW.initial_input_version AND project_id=NEW.project_id AND owner_identity_id=NEW.owner_identity_id) THEN
      RAISE EXCEPTION 'loop run binding rejected' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'control_loop_improvement_authorizations' THEN
    IF NOT EXISTS (SELECT 1 FROM control_loop_improvement_inputs i
      JOIN control_loop_improvement_run_links l ON l.tenant_id=i.tenant_id AND l.request_id=i.request_id
        AND l.project_id=i.project_id AND l.owner_identity_id=i.owner_identity_id
      WHERE i.tenant_id=NEW.tenant_id AND i.request_id=NEW.request_id AND i.version=NEW.input_version
        AND i.project_id=NEW.project_id AND i.owner_identity_id=NEW.owner_identity_id AND l.id=NEW.run_link_id
        AND i.version=(SELECT max(version) FROM control_loop_improvement_inputs
          WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
        AND i.request_sha256=NEW.request_sha256 AND i.settings_sha256=NEW.settings_sha256)
      OR (NEW.confirmation->'input_version') IS DISTINCT FROM NEW.a2_input_version
      OR (NEW.confirmation->>'sha256') IS DISTINCT FROM NEW.request_sha256 THEN
      RAISE EXCEPTION 'loop authorization current binding rejected' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM control_role_grants g
      WHERE g.tenant_id=NEW.tenant_id AND g.identity_id=NEW.owner_identity_id AND g.role_key='owner'
        AND g.risk_ceiling IN ('high','critical') AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'tasks.propose')
        AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)) THEN
      RAISE EXCEPTION 'loop authorization needs current owner grant' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown loop lineage table' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_control_loop_improvement_lineage_insert() FROM PUBLIC;

CREATE TRIGGER control_loop_improvement_requests_insert_guard BEFORE INSERT ON control_loop_improvement_requests
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_improvement_lineage_insert();
CREATE TRIGGER control_loop_improvement_requests_immutable BEFORE UPDATE OR DELETE ON control_loop_improvement_requests
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_improvement_requests_no_truncate BEFORE TRUNCATE ON control_loop_improvement_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_loop_improvement_inputs_insert_guard BEFORE INSERT ON control_loop_improvement_inputs
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_improvement_lineage_insert();
CREATE TRIGGER control_loop_improvement_inputs_immutable BEFORE UPDATE OR DELETE ON control_loop_improvement_inputs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_improvement_inputs_no_truncate BEFORE TRUNCATE ON control_loop_improvement_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_loop_improvement_run_links_insert_guard BEFORE INSERT ON control_loop_improvement_run_links
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_improvement_lineage_insert();
CREATE TRIGGER control_loop_improvement_run_links_immutable BEFORE UPDATE OR DELETE ON control_loop_improvement_run_links
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_improvement_run_links_no_truncate BEFORE TRUNCATE ON control_loop_improvement_run_links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER control_loop_improvement_authorizations_insert_guard BEFORE INSERT ON control_loop_improvement_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_improvement_lineage_insert();
CREATE TRIGGER control_loop_improvement_authorizations_immutable BEFORE UPDATE OR DELETE ON control_loop_improvement_authorizations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_improvement_authorizations_no_truncate BEFORE TRUNCATE ON control_loop_improvement_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
