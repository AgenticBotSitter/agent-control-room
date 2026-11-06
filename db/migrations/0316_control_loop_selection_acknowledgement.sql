-- Additive acknowledgement and admission provenance constraints; no new tables and no signed history rewrite.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE FUNCTION control_loop_selection_ack_timestamp_v1(value text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE parts text[]; parsed timestamptz;
BEGIN
 parts := regexp_match(value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$');
 IF parts IS NULL OR parts[1]::int<1 OR parts[4]::int>23 OR parts[5]::int>59 OR parts[6]::int>59 THEN RETURN NULL; END IF;
 PERFORM make_date(parts[1]::int,parts[2]::int,parts[3]::int);
 IF parts[8]<>'Z' AND (substring(parts[8] from 2 for 2)::int>15 OR substring(parts[8] from 5 for 2)::int>59) THEN RETURN NULL; END IF;
 parsed := value::timestamptz;
 RETURN parsed;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION control_loop_selection_ack_timestamp_v1(text) FROM PUBLIC;
ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_binding_check;
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
      'schemaDigest','requestSha256','settingsSha256','runLinkId','authorizationId','inputVersion','expectedRevision','evidence','paidPin','sameFamilyAcknowledgement'])='{}'::jsonb
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

    AND ((binding ? 'sameFamilyAcknowledgement') IS NOT TRUE OR (
      operation IN ('intake','confirm','start')
      AND jsonb_typeof(binding->'sameFamilyAcknowledgement')='object'
      AND binding->'sameFamilyAcknowledgement' ?& ARRAY['schema_version','rule','run','by','accepted_at','acknowledgement']
      AND ((binding->'sameFamilyAcknowledgement') - ARRAY['schema_version','rule','run','by','accepted_at','acknowledgement'])='{}'::jsonb
      AND binding->'sameFamilyAcknowledgement'->'schema_version'='1'::jsonb
      AND binding->'sameFamilyAcknowledgement'->'rule'='"R296"'::jsonb
      AND binding->'sameFamilyAcknowledgement'->'by'='"owner"'::jsonb
      AND binding->'sameFamilyAcknowledgement'->'run'=binding->'loopRunId'
      AND binding->'sameFamilyAcknowledgement'->'acknowledgement'='"same-family-risk-accepted"'::jsonb
      AND jsonb_typeof(binding->'sameFamilyAcknowledgement'->'accepted_at')='string'
      AND control_loop_selection_ack_timestamp_v1(binding->'sameFamilyAcknowledgement'->>'accepted_at') IS NOT NULL
      AND control_loop_selection_ack_timestamp_v1(binding->'sameFamilyAcknowledgement'->>'accepted_at')<=created_at
      AND (operation<>'intake' OR binding->'body'->'acceptSameFamilyRisk'='true'::jsonb)
      AND (entry_kind<>'claim' OR (binding->'body' ? 'acceptSameFamilyRisk') IS NOT TRUE
        OR created_at-control_loop_selection_ack_timestamp_v1(binding->'sameFamilyAcknowledgement'->>'accepted_at')<interval '5 seconds')
    ) IS TRUE)
    AND (((binding->'body') ? 'acceptSameFamilyRisk') IS NOT TRUE OR (
      operation IN ('intake','confirm','start') AND binding->'body'->'acceptSameFamilyRisk'='true'::jsonb
      AND (binding ? 'sameFamilyAcknowledgement') IS TRUE
    ) IS TRUE)
  ) IS TRUE) NOT VALID;
ALTER TABLE control_loop_improvement_commands DROP CONSTRAINT control_loop_improvement_commands_check1;
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
        AND ((binding->'body') - ARRAY['description','settingsEdits','waiverId','acceptSameFamilyRisk'])='{}'::jsonb
      WHEN 'confirm' THEN binding->'body'->>'requestSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(binding->'body'->'requestSha256')='string'
        AND binding->'body'->>'settingsSha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(binding->'body'->'settingsSha256')='string'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','requestSha256','settingsSha256','acceptSameFamilyRisk'])='{}'::jsonb
      WHEN 'start' THEN jsonb_typeof(binding->'body'->'runLinkId')='string'
        AND binding->'body'->>'runLinkId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
        AND ((binding->'body') - ARRAY['expectedVersion','expectedRevision','runLinkId','route','paid','acceptSameFamilyRisk'])='{}'::jsonb
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
  ) IS TRUE) NOT VALID;

-- Admission provenance is exactly one-to-one, including at transaction commit.
CREATE TABLE control_loop_policy_input_admissions (
 tenant_id text NOT NULL, request_id text NOT NULL, input_version bigint NOT NULL,
 admission_kind text NOT NULL,
 PRIMARY KEY (tenant_id,request_id,input_version),
 CONSTRAINT control_loop_policy_input_admissions_kind_check CHECK (admission_kind IN ('native-p71','product-b8'))
);
ALTER TABLE control_loop_policy_input_admissions ADD CONSTRAINT control_loop_policy_input_admissions_source_fk
 FOREIGN KEY (tenant_id,request_id,input_version)
 REFERENCES control_loop_policy_input_sources(tenant_id,request_id,input_version) ON DELETE RESTRICT NOT VALID;
CREATE TRIGGER control_loop_policy_input_admissions_immutable BEFORE UPDATE OR DELETE ON control_loop_policy_input_admissions
 FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_input_admissions_no_truncate BEFORE TRUNCATE ON control_loop_policy_input_admissions
 FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
-- Rollout requires verified absence of any previously deployed product-B8 writer.
INSERT INTO control_loop_policy_input_admissions (tenant_id,request_id,input_version,admission_kind)
 SELECT tenant_id,request_id,input_version,'native-p71' FROM control_loop_policy_input_sources;
ALTER TABLE control_loop_policy_input_sources ADD CONSTRAINT control_loop_policy_input_sources_admission_fk
 FOREIGN KEY (tenant_id,request_id,input_version)
 REFERENCES control_loop_policy_input_admissions(tenant_id,request_id,input_version)
 DEFERRABLE INITIALLY DEFERRED NOT VALID;
