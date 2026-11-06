-- P71: one shared project and selection layer; old signed inputs are untouched.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_policy_layers (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  layer text NOT NULL CHECK (layer IN ('project','selection')),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  settings_text text NOT NULL CHECK (octet_length(settings_text) <= 65536 AND jsonb_typeof(settings_text::jsonb) = 'object'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[a-f0-9]{64}$'),
  updated_by text NOT NULL CHECK (updated_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  updated_at timestamptz NOT NULL,
  last_idempotency_key text NOT NULL CHECK (last_idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  last_request_digest text NOT NULL CHECK (last_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,project_id,layer),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE control_loop_policy_events (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  layer text NOT NULL CHECK (layer IN ('project','selection')),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  before_sha256 text CHECK (before_sha256 ~ '^[a-f0-9]{64}$'),
  after_sha256 text NOT NULL CHECK (after_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id text NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,id),
  UNIQUE (tenant_id,project_id,layer,version),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE control_loop_policy_input_sources (
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  input_version bigint NOT NULL CHECK (input_version BETWEEN 1 AND 9007199254740991),
  defaults_sha256 text NOT NULL CHECK (defaults_sha256 ~ '^[a-f0-9]{64}$'),
  layer_versions jsonb NOT NULL CHECK (octet_length(layer_versions::text) <= 256 AND jsonb_typeof(layer_versions) = 'object'
    AND layer_versions ? 'project' AND layer_versions ? 'selection' AND layer_versions - 'project' - 'selection' = '{}'::jsonb
    AND jsonb_typeof(layer_versions->'project') = 'number' AND jsonb_typeof(layer_versions->'selection') = 'number'
    AND (layer_versions->>'project')::numeric BETWEEN 0 AND 9007199254740991
    AND (layer_versions->>'selection')::numeric BETWEEN 0 AND 9007199254740991
    AND (layer_versions->>'project')::numeric = trunc((layer_versions->>'project')::numeric)
    AND (layer_versions->>'selection')::numeric = trunc((layer_versions->>'selection')::numeric)),
  waiver_id text CHECK (waiver_id IS NULL),
  PRIMARY KEY (tenant_id,request_id,input_version),
  FOREIGN KEY (tenant_id,request_id,input_version) REFERENCES control_loop_improvement_inputs(tenant_id,request_id,version) ON DELETE RESTRICT
);
CREATE TRIGGER control_loop_policy_events_immutable BEFORE UPDATE OR DELETE ON control_loop_policy_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_events_no_truncate BEFORE TRUNCATE ON control_loop_policy_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_sources_immutable BEFORE UPDATE OR DELETE ON control_loop_policy_input_sources
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_sources_no_truncate BEFORE TRUNCATE ON control_loop_policy_input_sources
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- The intake body remains closed while admitting the explicit P71 edits string.
-- Keep every other operation's 0302 body predicate unchanged.
ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_check1;
ALTER TABLE control_loop_improvement_commands ADD CONSTRAINT control_loop_improvement_commands_check1
CHECK ((
    (operation IN ('intake','stop') OR (
      jsonb_typeof(binding->'body'->'expectedVersion')='number'
      AND binding->'body'->>'expectedVersion' ~ '^[1-9][0-9]{0,15}$'
      AND (binding->'body'->>'expectedVersion')::numeric<=9007199254740991
      AND jsonb_typeof(binding->'body'->'expectedRevision')='number'
      AND binding->'body'->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (binding->'body'->>'expectedRevision')::numeric<=9007199254740991))
    AND (operation NOT IN ('approve','answer') OR (
      (jsonb_typeof(binding->'body'->'inputVersion')='string' AND length(binding->'body'->>'inputVersion') BETWEEN 1 AND 180)
      OR (jsonb_typeof(binding->'body'->'inputVersion')='number' AND binding->'body'->>'inputVersion' ~ '^[1-9][0-9]{0,15}$'
        AND (binding->'body'->>'inputVersion')::numeric<=9007199254740991)))
    AND CASE operation
      WHEN 'intake' THEN jsonb_typeof(binding->'body'->'description')='string'
        AND length(binding->'body'->>'description') BETWEEN 1 AND 8000 AND btrim(binding->'body'->>'description')<>''
        AND (NOT (binding->'body' ? 'settingsEdits') OR jsonb_typeof(binding->'body'->'settingsEdits')='string')
        AND ((binding->'body') - ARRAY['description','settingsEdits'])='{}'::jsonb
      WHEN 'confirm' THEN binding->'body'->>'requestSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(binding->'body'->'requestSha256')='string'
        AND binding->'body'->>'settingsSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(binding->'body'->'settingsSha256')='string'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','requestSha256','settingsSha256'])='{}'::jsonb
      WHEN 'start' THEN jsonb_typeof(binding->'body'->'runLinkId')='string'
        AND binding->'body'->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','runLinkId'])='{}'::jsonb
      WHEN 'stop' THEN jsonb_typeof(binding->'body'->'runLinkId')='string'
        AND binding->'body'->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
        AND ((binding->'body') - ARRAY['runLinkId'])='{}'::jsonb
      WHEN 'approve' THEN binding->'body'->>'step' IN ('plan','spec')
        AND jsonb_typeof(binding->'body'->'head')='string' AND binding->'body'->>'head' ~ '^[a-f0-9]{40}$'
        AND jsonb_typeof(binding->'body'->'reportSha256')='string' AND binding->'body'->>'reportSha256' ~ '^[a-f0-9]{64}$'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','step','inputVersion','head','reportSha256'])='{}'::jsonb
      WHEN 'answer' THEN jsonb_typeof(binding->'body'->'questionId')='string'
        AND binding->'body'->>'questionId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
        AND jsonb_typeof(binding->'body'->'questionReportSha256')='string' AND binding->'body'->>'questionReportSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(binding->'body'->'text')='string' AND length(binding->'body'->>'text') BETWEEN 1 AND 8000
        AND btrim(binding->'body'->>'text')<>''
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','questionId','inputVersion','questionReportSha256','text'])='{}'::jsonb
    END
  ) IS TRUE) NOT VALID;
