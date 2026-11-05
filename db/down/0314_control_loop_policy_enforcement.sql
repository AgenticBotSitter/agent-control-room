BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_policy_layers,control_loop_policy_input_sources,control_loop_policy_waivers,control_loop_improvement_commands IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM control_loop_policy_waivers)
    OR EXISTS(SELECT 1 FROM control_loop_policy_layers)
    OR EXISTS(SELECT 1 FROM control_loop_improvement_commands WHERE binding->'body' ? 'waiverId') THEN
    RAISE EXCEPTION 'loop policy enforcement retained' USING ERRCODE='23514';
  END IF;
END $$;
DROP TRIGGER control_loop_policy_source_waiver_guard ON control_loop_policy_input_sources;
DROP FUNCTION guard_control_loop_policy_source_waiver();
ALTER TABLE control_loop_policy_input_sources DROP CONSTRAINT control_loop_policy_sources_waiver_fk;
ALTER TABLE control_loop_policy_input_sources ADD CONSTRAINT control_loop_policy_input_sources_waiver_id_check CHECK (waiver_id IS NULL);
DROP TABLE control_loop_policy_waivers RESTRICT;
DROP FUNCTION guard_control_loop_policy_waiver();
DROP TRIGGER control_loop_policy_locked_paths_guard ON control_loop_policy_layers;
DROP FUNCTION guard_control_loop_policy_locked_paths();
-- Rebuild only the empty layer table. DROP COLUMN leaves a physical attnum hole;
-- re-adding locked_paths would otherwise violate the exact release schema pin.
-- The retained-row guard above and the access-exclusive lock forbid data loss.
DROP TABLE control_loop_policy_layers RESTRICT;
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
ALTER TABLE control_loop_policy_layers OWNER TO control_room_schema_owner;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    GRANT SELECT, INSERT ON control_loop_policy_layers TO control_room_private_web;
    GRANT UPDATE (version,settings_text,settings_sha256,updated_by,updated_at,last_idempotency_key,last_request_digest)
      ON control_loop_policy_layers TO control_room_private_web;
  END IF;
END $$;

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
  ) IS TRUE);
COMMIT;
