-- Paid admission only, no paid execution.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
-- Validate 0314 constraints in the following migration transaction, as in 0308.
ALTER TABLE control_loop_policy_layers VALIDATE CONSTRAINT control_loop_policy_locked_paths_check;
ALTER TABLE control_loop_policy_input_sources VALIDATE CONSTRAINT control_loop_policy_sources_waiver_fk;
ALTER TABLE control_loop_improvement_commands VALIDATE CONSTRAINT control_loop_improvement_commands_check1;
-- Names measured in migrated pg_constraint; retain stable names for earlier downs.
ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_binding_check;
-- Validate signed history atomically with both replacements; lock and statement waits are bounded above.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE control_loop_improvement_commands ADD CONSTRAINT control_loop_improvement_commands_binding_check CHECK ((
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
      'schemaDigest','requestSha256','settingsSha256','runLinkId','authorizationId','inputVersion','expectedRevision','evidence','paidPin'])='{}'::jsonb
    AND (jsonb_typeof(binding->'runLinkId')='null' OR jsonb_typeof(binding->'runLinkId')='string' AND binding->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
    AND (jsonb_typeof(binding->'authorizationId')='null' OR jsonb_typeof(binding->'authorizationId')='string' AND binding->>'authorizationId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
    AND (jsonb_typeof(binding->'evidence')='null' OR jsonb_typeof(binding->'evidence')='string' AND binding->>'evidence' ~ '^sha256:[a-f0-9]{64}$')
    AND (jsonb_typeof(binding->'expectedRevision')='null' OR (jsonb_typeof(binding->'expectedRevision')='number'
      AND binding->>'expectedRevision' ~ '^(0|[1-9][0-9]{0,15})$' AND (binding->>'expectedRevision')::numeric<=9007199254740991))
    AND (jsonb_typeof(binding->'inputVersion')='null' OR (jsonb_typeof(binding->'inputVersion')='string'
      AND length(binding->>'inputVersion') BETWEEN 1 AND 180) OR (jsonb_typeof(binding->'inputVersion')='number'
      AND binding->>'inputVersion' ~ '^[1-9][0-9]{0,15}$' AND (binding->>'inputVersion')::numeric<=9007199254740991))

    AND ((binding ? 'paidPin') = (operation='start' AND (binding->'body' ? 'paid')))
    AND (NOT (binding ? 'paidPin') OR (
      jsonb_typeof(binding->'paidPin')='object'
      AND binding->'paidPin' ?& ARRAY['providerId','model','servedModelId','providerVersion','priceRowDigest','capNanoUsd']
      AND ((binding->'paidPin') - ARRAY['providerId','model','servedModelId','providerVersion','priceRowDigest','capNanoUsd'])='{}'::jsonb
      AND jsonb_typeof(binding->'paidPin'->'providerId')='string'
      AND binding->'paidPin'->>'providerId' ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
      AND jsonb_typeof(binding->'paidPin'->'model')='string'
      AND length(binding->'paidPin'->>'model') BETWEEN 1 AND 180
      AND binding->'paidPin'->>'model' !~ '[[:cntrl:]]'
      AND jsonb_typeof(binding->'paidPin'->'servedModelId')='string'
      AND binding->'paidPin'->>'servedModelId' ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$'
      AND jsonb_typeof(binding->'paidPin'->'providerVersion')='number'
      AND binding->'paidPin'->>'providerVersion' ~ '^[1-9][0-9]{0,15}$'
      AND (binding->'paidPin'->>'providerVersion')::numeric<=9007199254740991
      AND jsonb_typeof(binding->'paidPin'->'priceRowDigest')='string'
      AND binding->'paidPin'->>'priceRowDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(binding->'paidPin'->'capNanoUsd')='string'
      AND binding->'paidPin'->>'capNanoUsd' ~ '^[1-9][0-9]{0,29}$'
      AND binding->'paidPin'->>'providerId'=binding->'body'->'route'->>'providerId'
      AND binding->'paidPin'->>'model'=binding->'body'->'route'->>'model'
      AND binding->'paidPin'->>'capNanoUsd'=binding->'body'->'paid'->>'capNanoUsd'
    ))
  ) IS TRUE);
ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_check1;
-- Validate signed history atomically with both replacements; lock and statement waits are bounded above.
-- squawk-ignore constraint-missing-not-valid
ALTER TABLE control_loop_improvement_commands ADD CONSTRAINT control_loop_improvement_commands_check1 CHECK ((
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
        AND (NOT (binding->'body' ? 'waiverId') OR (jsonb_typeof(binding->'body'->'waiverId')='string'
          AND binding->'body'->>'waiverId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'))
        AND ((binding->'body') - ARRAY['description','settingsEdits','waiverId'])='{}'::jsonb
      WHEN 'confirm' THEN binding->'body'->>'requestSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(binding->'body'->'requestSha256')='string'
        AND binding->'body'->>'settingsSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(binding->'body'->'settingsSha256')='string'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','requestSha256','settingsSha256'])='{}'::jsonb
      WHEN 'start' THEN jsonb_typeof(binding->'body'->'runLinkId')='string'
        AND binding->'body'->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','runLinkId','route','paid'])='{}'::jsonb
        AND (NOT (binding->'body' ? 'route') OR (
          jsonb_typeof(binding->'body'->'route')='object'
          AND binding->'body'->'route' ?& ARRAY['providerId','model']
          AND ((binding->'body'->'route') - ARRAY['providerId','model'])='{}'::jsonb
          AND jsonb_typeof(binding->'body'->'route'->'providerId')='string'
          AND binding->'body'->'route'->>'providerId' ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
          AND jsonb_typeof(binding->'body'->'route'->'model')='string'
          AND length(binding->'body'->'route'->>'model') BETWEEN 1 AND 180
          AND binding->'body'->'route'->>'model' !~ '[[:cntrl:]]'
        ))
        AND (NOT (binding->'body' ? 'paid') OR (
          binding->'body' ? 'route'
          AND jsonb_typeof(binding->'body'->'paid')='object'
          AND binding->'body'->'paid' ?& ARRAY['optIn','capNanoUsd']
          AND ((binding->'body'->'paid') - ARRAY['optIn','capNanoUsd'])='{}'::jsonb
          AND binding->'body'->'paid'->'optIn'='true'::jsonb
          AND jsonb_typeof(binding->'body'->'paid'->'capNanoUsd')='string'
          AND binding->'body'->'paid'->>'capNanoUsd' ~ '^[1-9][0-9]{0,29}$'
        ))
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
