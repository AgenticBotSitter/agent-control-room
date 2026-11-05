-- Additive owner-command journal. The production migrator owns transaction/ledger.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_improvement_commands (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  command_id text NOT NULL CHECK (command_id ~ '^loop-command:[a-f0-9]{32}$'),
  entry_kind text NOT NULL CHECK (entry_kind IN ('claim','result')),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  operation text NOT NULL CHECK (operation IN ('intake','confirm','start','stop','approve','answer')),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  binding jsonb NOT NULL CHECK ((
    jsonb_typeof(binding)='object' AND octet_length(binding::text)<=65536
    AND jsonb_typeof(binding->'schemaVersion')='number' AND binding->>'schemaVersion'='1'
    AND jsonb_typeof(binding->'body')='object'
    AND jsonb_typeof(binding->'localVersion')='number' AND binding->>'localVersion' ~ '^[1-9][0-9]{0,15}$'
    AND (binding->>'localVersion')::numeric<=9007199254740991
    AND jsonb_typeof(binding->'adapterId')='string' AND binding->>'adapterId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
    AND jsonb_typeof(binding->'loopRunId')='string' AND binding->>'loopRunId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
    AND jsonb_typeof(binding->'toolingRevision')='string' AND binding->>'toolingRevision' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(binding->'schemaDigest')='string' AND binding->>'schemaDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(binding->'a2SchemaVersion')='number' AND binding->>'a2SchemaVersion'='1'
    AND jsonb_typeof(binding->'requestSha256')='string' AND binding->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(binding->'settingsSha256')='string' AND binding->>'settingsSha256' ~ '^[a-f0-9]{64}$'
    AND binding ?& ARRAY['schemaVersion','body','localVersion','adapterId','loopRunId','toolingRevision','a2SchemaVersion',
      'schemaDigest','requestSha256','settingsSha256','runLinkId','authorizationId','inputVersion','expectedRevision','evidence']
    AND (binding - ARRAY['schemaVersion','body','localVersion','adapterId','loopRunId','toolingRevision','a2SchemaVersion',
      'schemaDigest','requestSha256','settingsSha256','runLinkId','authorizationId','inputVersion','expectedRevision','evidence'])='{}'::jsonb
    AND (jsonb_typeof(binding->'runLinkId')='null' OR jsonb_typeof(binding->'runLinkId')='string' AND binding->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
    AND (jsonb_typeof(binding->'authorizationId')='null' OR jsonb_typeof(binding->'authorizationId')='string' AND binding->>'authorizationId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
    AND (jsonb_typeof(binding->'evidence')='null' OR jsonb_typeof(binding->'evidence')='string' AND binding->>'evidence' ~ '^sha256:[a-f0-9]{64}$')
    AND (jsonb_typeof(binding->'expectedRevision')='null' OR (jsonb_typeof(binding->'expectedRevision')='number'
      AND binding->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,15})$' AND (binding->>'expectedRevision')::numeric<=9007199254740991))
    AND (jsonb_typeof(binding->'inputVersion')='null' OR (jsonb_typeof(binding->'inputVersion')='string'
      AND length(binding->>'inputVersion') BETWEEN 1 AND 180) OR (jsonb_typeof(binding->'inputVersion')='number'
      AND binding->>'inputVersion' ~ '^[1-9][0-9]{0,15}$' AND (binding->>'inputVersion')::numeric<=9007199254740991))
  ) IS TRUE),
  result jsonb CHECK ((result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=65536
    AND result->>'state' IN ('accepted','waiting','refused')
    AND jsonb_typeof(result->'revision')='number' AND result->>'revision' ~ '^(0|[1-9][0-9]{0,15})$'
    AND (result->>'revision')::numeric<=9007199254740991
    AND result->>'adapterId'=binding->>'adapterId' AND result->>'loopRunId'=binding->>'loopRunId'
    AND result->>'toolingRevision'=binding->>'toolingRevision'
    AND result->>'evidenceDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND result ?& ARRAY['state','revision','adapterId','loopRunId','toolingRevision','evidenceDigest','error']
    AND (result - ARRAY['state','revision','adapterId','loopRunId','toolingRevision','evidenceDigest','error'])='{}'::jsonb
    AND (jsonb_typeof(result->'error')='null' OR result->>'error' IN ('REFUSED','INELIGIBLE')))) IS TRUE),
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
        AND ((binding->'body') - ARRAY['description'])='{}'::jsonb
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
  ) IS TRUE),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,command_id,entry_kind),
  FOREIGN KEY (tenant_id,request_id,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_requests(tenant_id,id,project_id,owner_identity_id) ON DELETE RESTRICT,
  CHECK ((entry_kind='claim' AND result IS NULL) OR (entry_kind='result' AND result IS NOT NULL))
);
CREATE UNIQUE INDEX control_loop_commands_owner_key ON control_loop_improvement_commands(tenant_id,owner_identity_id,idempotency_key)
  WHERE entry_kind='claim';
CREATE UNIQUE INDEX control_loop_commands_intake ON control_loop_improvement_commands(tenant_id,request_id)
  WHERE entry_kind='claim' AND operation='intake';
CREATE UNIQUE INDEX control_loop_commands_start ON control_loop_improvement_commands(tenant_id,request_id)
  WHERE entry_kind='claim' AND operation='start';
CREATE UNIQUE INDEX control_loop_commands_reserved_run ON control_loop_improvement_commands
  (tenant_id,(binding->>'adapterId'),(binding->>'loopRunId')) WHERE entry_kind='claim' AND operation='intake';
CREATE INDEX control_loop_commands_request ON control_loop_improvement_commands(tenant_id,request_id,created_at,command_id);
CREATE TRIGGER control_loop_commands_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON control_loop_improvement_commands
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
REVOKE ALL ON control_loop_improvement_commands FROM PUBLIC;
