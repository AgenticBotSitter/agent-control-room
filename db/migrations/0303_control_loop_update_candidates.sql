-- Immutable retained loop candidates. The production applier owns transaction/ledger.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_update_candidates (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  run_link_id text NOT NULL CHECK (run_link_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  local_version bigint NOT NULL CHECK (local_version BETWEEN 1 AND 9007199254740991),
  a2_input_version jsonb NOT NULL CHECK (((jsonb_typeof(a2_input_version)='string' AND length(a2_input_version #>> '{}') BETWEEN 1 AND 180) OR (jsonb_typeof(a2_input_version)='number' AND a2_input_version::text ~ '^[1-9][0-9]{0,15}$' AND a2_input_version::numeric<=9007199254740991)) IS TRUE),
  candidate_revision text NOT NULL CHECK (candidate_revision ~ '^[a-f0-9]{40}$'),
  completion_digest text NOT NULL CHECK (completion_digest ~ '^sha256:[a-f0-9]{64}$'),
  retention_digest text NOT NULL CHECK (retention_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
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
    AND jsonb_typeof(payload->'summary')='string'
    AND length(payload->>'summary') BETWEEN 1 AND 4000
    AND jsonb_typeof(payload->'changedAreas')='array'
    AND jsonb_array_length(payload->'changedAreas') BETWEEN 1 AND 100
    AND jsonb_typeof(payload->'checks')='array'
    AND jsonb_array_length(payload->'checks') BETWEEN 1 AND 32
    AND jsonb_typeof(payload->'reviews')='array'
    AND jsonb_array_length(payload->'reviews') BETWEEN 1 AND 32
    AND jsonb_typeof(payload->'findings')='array'
    AND jsonb_array_length(payload->'findings') BETWEEN 0 AND 100
    AND jsonb_typeof(payload->'assumptions')='array'
    AND jsonb_array_length(payload->'assumptions') BETWEEN 0 AND 32
    AND jsonb_typeof(payload->'validations')='array'
    AND jsonb_array_length(payload->'validations') BETWEEN 0 AND 32
    AND jsonb_typeof(payload->'databaseChanges')='object'
    AND jsonb_typeof(payload->'rounds')='object'
    AND jsonb_typeof(payload->'timing')='object'
    AND jsonb_typeof(payload->'overrides')='object'
  ) IS TRUE),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,run_link_id,local_version,a2_input_version),
  UNIQUE (tenant_id,id,project_id,owner_identity_id),
  FOREIGN KEY (tenant_id,request_id,local_version,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_inputs(tenant_id,request_id,version,project_id,owner_identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_link_id,request_id,project_id,owner_identity_id)
    REFERENCES control_loop_improvement_run_links(tenant_id,id,request_id,project_id,owner_identity_id) ON DELETE RESTRICT
);
CREATE TABLE control_loop_update_candidate_decisions (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  project_id text NOT NULL CHECK (project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  owner_identity_id text NOT NULL CHECK (owner_identity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  candidate_record_digest text NOT NULL CHECK (candidate_record_digest ~ '^sha256:[a-f0-9]{64}$'),
  candidate_revision text NOT NULL CHECK (candidate_revision ~ '^[a-f0-9]{40}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  decision text NOT NULL CHECK (decision IN ('accept','decline')),
  decision_digest text NOT NULL CHECK (decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  candidate_version bigint NOT NULL CHECK (candidate_version=1),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,candidate_id),
  UNIQUE (tenant_id,owner_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,candidate_id,project_id,owner_identity_id)
    REFERENCES control_loop_update_candidates(tenant_id,id,project_id,owner_identity_id) ON DELETE RESTRICT
);
CREATE INDEX control_loop_update_candidates_owner ON control_loop_update_candidates(tenant_id,owner_identity_id,created_at DESC,id DESC);
CREATE FUNCTION guard_control_loop_update_candidate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE item jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'checks') LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['id','required','commandLabel','receiptDigest','outputDigest','candidateRevision','status','exitCode','completed','passed','failed','skipped','durationMs','startedAt','endedAt']
      AND (item - ARRAY['id','required','commandLabel','receiptDigest','outputDigest','candidateRevision','status','exitCode','completed','passed','failed','skipped','durationMs','startedAt','endedAt'])='{}'::jsonb
      AND jsonb_typeof(item->'id') IN ('string')
      AND jsonb_typeof(item->'required') IN ('boolean')
      AND jsonb_typeof(item->'commandLabel') IN ('string')
      AND jsonb_typeof(item->'receiptDigest') IN ('string')
      AND item->>'receiptDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(item->'outputDigest') IN ('string')
      AND item->>'outputDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(item->'candidateRevision') IN ('string')
      AND item->>'candidateRevision' ~ '^[a-f0-9]{40}$'
      AND jsonb_typeof(item->'status') IN ('string')
      AND jsonb_typeof(item->'exitCode') IN ('number','null')
      AND jsonb_typeof(item->'completed') IN ('number')
      AND item->>'completed' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'completed')::numeric<=9007199254740991
      AND jsonb_typeof(item->'passed') IN ('number')
      AND item->>'passed' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'passed')::numeric<=9007199254740991
      AND jsonb_typeof(item->'failed') IN ('number')
      AND item->>'failed' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'failed')::numeric<=9007199254740991
      AND jsonb_typeof(item->'skipped') IN ('number')
      AND item->>'skipped' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'skipped')::numeric<=9007199254740991
      AND jsonb_typeof(item->'durationMs') IN ('number')
      AND item->>'durationMs' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'durationMs')::numeric<=9007199254740991
      AND jsonb_typeof(item->'startedAt') IN ('string')
      AND jsonb_typeof(item->'endedAt') IN ('string')
      AND length(item->>'commandLabel') BETWEEN 1 AND 240
      AND item->>'status' IN ('PASS','FAIL','INCOMPLETE','NOT RUN')
      AND (item->>'completed')::numeric=(item->>'passed')::numeric+(item->>'failed')::numeric+(item->>'skipped')::numeric
      AND item->>'candidateRevision'=NEW.candidate_revision
      AND (item->>'required'='false' OR (item->>'status'='PASS' AND item->>'exitCode'='0' AND (item->>'completed')::numeric>0 AND item->>'failed'='0' AND item->>'skipped'='0'))
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate checks shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'reviews') LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['current','stepId','role','attempt','requestedModel','observedModel','identityVerified','family','verdict','candidateRevision','inputVersion','reportDigest','sidecarDigest','startedAt','endedAt']
      AND (item - ARRAY['current','stepId','role','attempt','requestedModel','observedModel','identityVerified','family','verdict','candidateRevision','inputVersion','reportDigest','sidecarDigest','startedAt','endedAt'])='{}'::jsonb
      AND jsonb_typeof(item->'current') IN ('boolean')
      AND jsonb_typeof(item->'stepId') IN ('string')
      AND jsonb_typeof(item->'role') IN ('string')
      AND jsonb_typeof(item->'attempt') IN ('number')
      AND item->>'attempt' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'attempt')::numeric<=9007199254740991
      AND jsonb_typeof(item->'requestedModel') IN ('string','null')
      AND jsonb_typeof(item->'observedModel') IN ('string','null')
      AND jsonb_typeof(item->'identityVerified') IN ('boolean')
      AND jsonb_typeof(item->'family') IN ('string','null')
      AND jsonb_typeof(item->'verdict') IN ('string')
      AND jsonb_typeof(item->'candidateRevision') IN ('string')
      AND item->>'candidateRevision' ~ '^[a-f0-9]{40}$'
      AND jsonb_typeof(item->'inputVersion') IN ('string','number')
      AND jsonb_typeof(item->'reportDigest') IN ('string')
      AND item->>'reportDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(item->'sidecarDigest') IN ('string')
      AND item->>'sidecarDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(item->'startedAt') IN ('string')
      AND jsonb_typeof(item->'endedAt') IN ('string')
      AND (item->>'attempt')::numeric>=1
      AND item->>'verdict' IN ('CLEAN','NEEDS-FIX')
      AND (item->>'current'='false' OR (item->>'verdict'='CLEAN' AND item->>'candidateRevision'=NEW.candidate_revision AND item->'inputVersion'=NEW.a2_input_version))
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate reviews shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'findings') LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['origin','id','severity','disposition','summary','evidenceDigest']
      AND (item - ARRAY['origin','id','severity','disposition','summary','evidenceDigest'])='{}'::jsonb
      AND jsonb_typeof(item->'origin') IN ('string')
      AND jsonb_typeof(item->'id') IN ('string')
      AND jsonb_typeof(item->'severity') IN ('string')
      AND jsonb_typeof(item->'disposition') IN ('string')
      AND jsonb_typeof(item->'summary') IN ('string')
      AND jsonb_typeof(item->'evidenceDigest') IN ('string')
      AND item->>'evidenceDigest' ~ '^sha256:[a-f0-9]{64}$'
      AND item->>'severity' IN ('HIGH','MEDIUM','LOW')
      AND item->>'disposition' IN ('OPEN','FIXED','REJECTED_WITH_EVIDENCE')
      AND NOT (item->>'severity' IN ('HIGH','MEDIUM') AND item->>'disposition'='OPEN')
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate findings shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'assumptions') LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['id','text','status','evidenceDigest']
      AND (item - ARRAY['id','text','status','evidenceDigest'])='{}'::jsonb
      AND jsonb_typeof(item->'id') IN ('string')
      AND jsonb_typeof(item->'text') IN ('string')
      AND jsonb_typeof(item->'status') IN ('string')
      AND jsonb_typeof(item->'evidenceDigest') IN ('string','null')
      AND item->>'status' IN ('validated','unverified')
      AND (item->>'status'<>'validated' OR jsonb_typeof(item->'evidenceDigest')='string')
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate assumptions shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'validations') LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['id','text','status','evidenceDigest']
      AND (item - ARRAY['id','text','status','evidenceDigest'])='{}'::jsonb
      AND jsonb_typeof(item->'id') IN ('string')
      AND jsonb_typeof(item->'text') IN ('string')
      AND jsonb_typeof(item->'status') IN ('string')
      AND jsonb_typeof(item->'evidenceDigest') IN ('string','null')
      AND item->>'status' IN ('PASS','FAIL','INCOMPLETE','NOT RUN')
      AND (item->>'status'<>'PASS' OR jsonb_typeof(item->'evidenceDigest')='string')
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate validations shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT NEW.payload->'rounds' LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['attempts','reviewRejections','repairs','redesigns']
      AND (item - ARRAY['attempts','reviewRejections','repairs','redesigns'])='{}'::jsonb
      AND jsonb_typeof(item->'attempts') IN ('number')
      AND item->>'attempts' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'attempts')::numeric<=9007199254740991
      AND jsonb_typeof(item->'reviewRejections') IN ('number')
      AND item->>'reviewRejections' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'reviewRejections')::numeric<=9007199254740991
      AND jsonb_typeof(item->'repairs') IN ('number')
      AND item->>'repairs' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'repairs')::numeric<=9007199254740991
      AND jsonb_typeof(item->'redesigns') IN ('number')
      AND item->>'redesigns' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'redesigns')::numeric<=9007199254740991
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate rounds shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT NEW.payload->'timing' LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['startedAt','finishedAt','durationMs']
      AND (item - ARRAY['startedAt','finishedAt','durationMs'])='{}'::jsonb
      AND jsonb_typeof(item->'startedAt') IN ('string')
      AND jsonb_typeof(item->'finishedAt') IN ('string')
      AND jsonb_typeof(item->'durationMs') IN ('number')
      AND item->>'durationMs' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (item->>'durationMs')::numeric<=9007199254740991
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate timing shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT NEW.payload->'overrides' LOOP
    IF NOT ((jsonb_typeof(item)='object'
      AND item ?& ARRAY['allowSameFamilyReview','allowStandardFinal','waivedConflicts','fallback']
      AND (item - ARRAY['allowSameFamilyReview','allowStandardFinal','waivedConflicts','fallback'])='{}'::jsonb
      AND jsonb_typeof(item->'allowSameFamilyReview') IN ('boolean')
      AND jsonb_typeof(item->'allowStandardFinal') IN ('boolean')
      AND jsonb_typeof(item->'waivedConflicts') IN ('array')
      AND jsonb_typeof(item->'fallback') IN ('string','null')
    ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate overrides shape rejected' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'changedAreas') LOOP
    IF NOT ((jsonb_typeof(item)='string' AND length(item #>> '{}') BETWEEN 1 AND 240) IS TRUE) THEN
      RAISE EXCEPTION 'loop candidate changed area rejected' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF jsonb_array_length(NEW.payload->'overrides'->'waivedConflicts')>32 THEN
    RAISE EXCEPTION 'loop candidate waiver limit rejected' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.payload->'overrides'->'waivedConflicts') LOOP
    IF NOT ((jsonb_typeof(item)='string' AND length(item #>> '{}') BETWEEN 1 AND 240) IS TRUE) THEN
      RAISE EXCEPTION 'loop candidate waiver rejected' USING ERRCODE='23514';
    END IF;
  END LOOP;
  item:=NEW.payload->'databaseChanges';
  IF NOT ((
    (item->>'kind'='none' AND item ? 'kind' AND item-ARRAY['kind']='{}'::jsonb)
    OR (item->>'kind' IN ('migrations','changes')
      AND item ?& ARRAY['kind','migrationIds','summary','compatibilityNotes','rollbackNotes']
      AND jsonb_typeof(item->'migrationIds')='array' AND jsonb_array_length(item->'migrationIds')<=32
      AND jsonb_typeof(item->'summary')='string' AND length(item->>'summary') BETWEEN 1 AND 1000
      AND jsonb_typeof(item->'compatibilityNotes')='string' AND length(item->>'compatibilityNotes') BETWEEN 1 AND 1000
      AND jsonb_typeof(item->'rollbackNotes')='string' AND length(item->>'rollbackNotes') BETWEEN 1 AND 1000
      AND ((item->>'kind'='migrations' AND jsonb_array_length(item->'migrationIds')>=1
        AND item-ARRAY['kind','migrationIds','summary','compatibilityNotes','rollbackNotes']='{}'::jsonb)
       OR (item->>'kind'='changes' AND item ? 'changedPaths' AND jsonb_typeof(item->'changedPaths')='array'
        AND jsonb_array_length(item->'changedPaths') BETWEEN 1 AND 1000
        AND item-ARRAY['kind','migrationIds','summary','compatibilityNotes','rollbackNotes','changedPaths']='{}'::jsonb)))
  ) IS TRUE) THEN RAISE EXCEPTION 'loop candidate database notes rejected' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'checks') c WHERE c->>'required'='true')
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'reviews') r WHERE r->>'current'='true' AND r->>'role'='final') THEN
    RAISE EXCEPTION 'loop candidate required proof absent' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM control_identities WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_identity_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM control_loop_improvement_inputs i
    JOIN control_loop_improvement_run_links l ON l.tenant_id=i.tenant_id AND l.request_id=i.request_id
      AND l.project_id=i.project_id AND l.owner_identity_id=i.owner_identity_id
    WHERE i.tenant_id=NEW.tenant_id AND i.request_id=NEW.request_id AND i.project_id=NEW.project_id
      AND i.owner_identity_id=NEW.owner_identity_id AND i.version=NEW.local_version AND l.id=NEW.run_link_id
      AND i.version=(SELECT max(version) FROM control_loop_improvement_inputs WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
      AND i.request_sha256=NEW.payload->'binding'->>'requestSha256' AND i.settings_sha256=NEW.payload->'binding'->>'settingsSha256'
      AND l.adapter_id=NEW.payload->'binding'->>'adapterId' AND l.loop_run_id=NEW.payload->'binding'->>'loopRunId'
      AND l.tooling_revision=NEW.payload->'binding'->>'toolingRevision')
    OR NOT EXISTS (SELECT 1 FROM control_loop_improvement_commands c
      JOIN control_loop_improvement_commands r ON r.tenant_id=c.tenant_id AND r.command_id=c.command_id AND r.entry_kind='result'
      JOIN control_loop_improvement_authorizations a ON a.tenant_id=c.tenant_id AND a.id=c.binding->>'authorizationId'
      WHERE c.tenant_id=NEW.tenant_id AND c.request_id=NEW.request_id AND c.project_id=NEW.project_id
        AND c.owner_identity_id=NEW.owner_identity_id AND c.operation='start' AND c.entry_kind='claim'
        AND c.binding->>'runLinkId'=NEW.run_link_id AND a.run_link_id=NEW.run_link_id
        AND a.input_version=(c.binding->>'localVersion')::bigint AND a.start_key=c.idempotency_key
        AND r.binding=c.binding AND r.owner_identity_id=c.owner_identity_id AND r.project_id=c.project_id
        AND r.request_id=c.request_id AND r.operation='start' AND r.result->>'state'='accepted') THEN
    RAISE EXCEPTION 'loop candidate current binding rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION guard_control_loop_update_candidate_decision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM control_identities WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_identity_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM control_loop_update_candidates c
    JOIN control_loop_improvement_inputs i ON i.tenant_id=c.tenant_id AND i.request_id=c.request_id AND i.version=c.local_version
    WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.candidate_id AND c.project_id=NEW.project_id AND c.owner_identity_id=NEW.owner_identity_id
      AND c.record_digest=NEW.candidate_record_digest AND c.candidate_revision=NEW.candidate_revision
      AND c.local_version=(SELECT max(version) FROM control_loop_improvement_inputs WHERE tenant_id=c.tenant_id AND request_id=c.request_id)
      AND NOT EXISTS (SELECT 1 FROM control_loop_update_candidates n WHERE n.tenant_id=c.tenant_id
        AND n.run_link_id=c.run_link_id AND n.local_version=c.local_version AND n.id<>c.id
        AND (n.payload->'binding'->>'engineRevision')::bigint >= (c.payload->'binding'->>'engineRevision')::bigint))
    OR EXISTS (SELECT 1 FROM control_loop_update_candidate_decisions WHERE tenant_id=NEW.tenant_id AND candidate_id=NEW.candidate_id) THEN
    RAISE EXCEPTION 'loop candidate decision current binding rejected' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_role_grants g JOIN control_identities i ON i.tenant_id=g.tenant_id AND i.id=g.identity_id
    WHERE g.tenant_id=NEW.tenant_id AND g.identity_id=NEW.owner_identity_id AND i.actor_type='human' AND i.state='active'
      AND g.role_key='owner' AND g.risk_ceiling IN ('high','critical') AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())
      AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'updates.decide')
      AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)) THEN
    RAISE EXCEPTION 'loop candidate decision owner grant rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_loop_update_candidate_insert(), guard_control_loop_update_candidate_decision_insert() FROM PUBLIC;
CREATE TRIGGER control_loop_update_candidates_binding BEFORE INSERT ON control_loop_update_candidates
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_update_candidate_insert();
CREATE TRIGGER control_loop_update_candidate_decisions_binding BEFORE INSERT ON control_loop_update_candidate_decisions
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_update_candidate_decision_insert();
CREATE TRIGGER control_loop_update_candidates_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON control_loop_update_candidates
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_update_candidate_decisions_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON control_loop_update_candidate_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
REVOKE ALL ON control_loop_update_candidates, control_loop_update_candidate_decisions FROM PUBLIC;
