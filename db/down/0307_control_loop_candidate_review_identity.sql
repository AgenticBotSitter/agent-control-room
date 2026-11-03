-- Restore the exact 0305 insert validator. Retained candidate rows are unchanged.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE OR REPLACE FUNCTION guard_control_loop_update_candidate_insert() RETURNS trigger
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
  IF (jsonb_typeof(NEW.payload->'assumptions') IN ('array','null')) IS NOT TRUE THEN
    RAISE EXCEPTION 'loop candidate assumptions shape rejected' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NULLIF(NEW.payload->'assumptions','null'::jsonb)) LOOP
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
  IF (jsonb_typeof(NEW.payload->'validations') IN ('array','null')) IS NOT TRUE THEN
    RAISE EXCEPTION 'loop candidate validations shape rejected' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NULLIF(NEW.payload->'validations','null'::jsonb)) LOOP
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
      AND jsonb_typeof(item->'repairs') IN ('number','null')
      AND (jsonb_typeof(item->'repairs')='null' OR (item->>'repairs' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (item->>'repairs')::numeric<=9007199254740991))
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
  IF (jsonb_typeof(NEW.payload->'changedAreas') IN ('array','null')) IS NOT TRUE THEN
    RAISE EXCEPTION 'loop candidate changed area rejected' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NULLIF(NEW.payload->'changedAreas','null'::jsonb)) LOOP
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
  IF NOT ((item='null'::jsonb OR
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
        AND a.input_version=(c.binding->>'localVersion')::bigint
        AND a.request_id=c.request_id AND a.project_id=c.project_id AND a.owner_identity_id=c.owner_identity_id
        AND a.request_sha256=c.binding->>'requestSha256' AND a.settings_sha256=c.binding->>'settingsSha256'
        AND a.a2_input_version=c.binding->'inputVersion'
        AND r.binding=c.binding AND r.owner_identity_id=c.owner_identity_id AND r.project_id=c.project_id
        AND r.request_id=c.request_id AND r.operation='start' AND r.result->>'state'='accepted') THEN
    RAISE EXCEPTION 'loop candidate current binding rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_loop_update_candidate_insert() FROM PUBLIC;
