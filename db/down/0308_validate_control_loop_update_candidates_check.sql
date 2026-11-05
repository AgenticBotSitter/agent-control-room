SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE control_loop_update_candidates
  DROP CONSTRAINT control_loop_update_candidates_check,
  ADD CONSTRAINT control_loop_update_candidates_check
  CHECK ((
    jsonb_typeof(payload)='object'
    AND octet_length(payload::text)<=65536
    AND payload ?& ARRAY['schemaVersion','binding','summary','changedAreas','databaseChanges','checks','reviews','findings','rounds','timing','assumptions','validations','overrides','completionDigest','retentionDigest']
    AND (payload - ARRAY['schemaVersion','binding','summary','changedAreas','databaseChanges','checks','reviews','findings','rounds','timing','assumptions','validations','overrides','completionDigest','retentionDigest'])='{}'::jsonb
    AND payload->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(payload->'binding')='object'
    AND payload->'binding' ?& ARRAY['projectId','requestId','runLinkId','localVersion','adapterId','loopRunId','toolingRevision','a2SchemaVersion','a2InputVersion','engineRevision','requestSha256','settingsSha256','baseRevision','candidateRevision','inputsDigest','recipeDigest','environmentDigest']
    AND ((payload->'binding') - ARRAY['projectId','requestId','runLinkId','localVersion','adapterId','loopRunId','toolingRevision','a2SchemaVersion','a2InputVersion','engineRevision','requestSha256','settingsSha256','baseRevision','candidateRevision','inputsDigest','recipeDigest','environmentDigest'])='{}'::jsonb
    AND jsonb_typeof(payload->'binding'->'projectId')='string'
    AND payload->'binding'->>'projectId'=project_id
    AND jsonb_typeof(payload->'binding'->'requestId')='string'
    AND payload->'binding'->>'requestId'=request_id
    AND jsonb_typeof(payload->'binding'->'runLinkId')='string'
    AND payload->'binding'->>'runLinkId'=run_link_id
    AND jsonb_typeof(payload->'binding'->'candidateRevision')='string'
    AND payload->'binding'->>'candidateRevision'=candidate_revision
    AND payload->'binding'->'localVersion'=to_jsonb(local_version)
    AND payload->'binding'->'a2InputVersion'=a2_input_version
    AND payload->'binding'->'a2SchemaVersion'='1'::jsonb
    AND payload->>'completionDigest'=completion_digest
    AND payload->>'retentionDigest'=retention_digest
    AND jsonb_typeof(payload->'binding'->'adapterId')='string'
    AND payload->'binding'->>'adapterId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
    AND jsonb_typeof(payload->'binding'->'loopRunId')='string'
    AND payload->'binding'->>'loopRunId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
    AND jsonb_typeof(payload->'binding'->'toolingRevision')='string'
    AND payload->'binding'->>'toolingRevision' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(payload->'binding'->'inputsDigest')='string'
    AND payload->'binding'->>'inputsDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(payload->'binding'->'recipeDigest')='string'
    AND payload->'binding'->>'recipeDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(payload->'binding'->'environmentDigest')='string'
    AND payload->'binding'->>'environmentDigest' ~ '^sha256:[a-f0-9]{64}$'
    AND jsonb_typeof(payload->'binding'->'requestSha256')='string'
    AND payload->'binding'->>'requestSha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(payload->'binding'->'settingsSha256')='string'
    AND payload->'binding'->>'settingsSha256' ~ '^[a-f0-9]{64}$'
    AND payload->'binding'->>'baseRevision' ~ '^[a-f0-9]{40}$'
    AND payload->'binding'->>'baseRevision'<>candidate_revision
    AND jsonb_typeof(payload->'binding'->'engineRevision')='number'
    AND payload->'binding'->>'engineRevision' ~ '^(0|[1-9][0-9]{0,15})$'
    AND (payload->'binding'->>'engineRevision')::numeric<=9007199254740991
    AND CASE jsonb_typeof(payload->'summary') WHEN 'null' THEN true
      WHEN 'string' THEN length(payload->>'summary') BETWEEN 1 AND 4000 ELSE false END
    AND CASE jsonb_typeof(payload->'changedAreas') WHEN 'null' THEN true
      WHEN 'array' THEN jsonb_array_length(payload->'changedAreas') BETWEEN 1 AND 100 ELSE false END
    AND jsonb_typeof(payload->'checks')='array'
    AND jsonb_array_length(payload->'checks') BETWEEN 1 AND 32
    AND jsonb_typeof(payload->'reviews')='array'
    AND jsonb_array_length(payload->'reviews') BETWEEN 1 AND 32
    AND jsonb_typeof(payload->'findings')='array'
    AND jsonb_array_length(payload->'findings') BETWEEN 0 AND 100
    AND CASE jsonb_typeof(payload->'assumptions') WHEN 'null' THEN true
      WHEN 'array' THEN jsonb_array_length(payload->'assumptions') BETWEEN 0 AND 32 ELSE false END
    AND CASE jsonb_typeof(payload->'validations') WHEN 'null' THEN true
      WHEN 'array' THEN jsonb_array_length(payload->'validations') BETWEEN 0 AND 32 ELSE false END
    AND jsonb_typeof(payload->'databaseChanges') IN ('object','null')
    AND jsonb_typeof(payload->'rounds')='object'
    AND jsonb_typeof(payload->'timing')='object'
    AND jsonb_typeof(payload->'overrides')='object'
  ) IS TRUE) NOT VALID;
