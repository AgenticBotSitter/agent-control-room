-- P72: explicit locks and single-request owner waivers. No existing copies change.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
ALTER TABLE control_loop_policy_layers ADD COLUMN locked_paths jsonb NOT NULL DEFAULT '[]';
ALTER TABLE control_loop_policy_layers ADD CONSTRAINT control_loop_policy_locked_paths_check
  CHECK (CASE WHEN jsonb_typeof(locked_paths)='array' THEN jsonb_array_length(locked_paths)<=100 ELSE false END
    AND (layer='project' OR locked_paths='[]'::jsonb)) NOT VALID;
CREATE FUNCTION guard_control_loop_policy_locked_paths() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE path text;
BEGIN
  IF jsonb_typeof(NEW.locked_paths) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid policy lock paths' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.locked_paths) AS e WHERE jsonb_typeof(e)<>'string') THEN
    RAISE EXCEPTION 'invalid policy lock paths' USING ERRCODE='23514';
  END IF;
  FOR path IN SELECT jsonb_array_elements_text(NEW.locked_paths) LOOP
    IF NOT (length(path) BETWEEN 1 AND 256 AND path ~ '^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$' AND path !~ '(^|\.)(__proto__|prototype|constructor)(\.|$)') THEN RAISE EXCEPTION 'invalid policy lock path' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF NEW.locked_paths IS DISTINCT FROM (SELECT coalesce(jsonb_agg(v ORDER BY v COLLATE "C"),'[]'::jsonb)
    FROM (SELECT DISTINCT jsonb_array_elements_text(NEW.locked_paths) AS v) AS paths) THEN
    RAISE EXCEPTION 'policy lock paths must be distinct and sorted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_loop_policy_locked_paths() FROM PUBLIC;
CREATE TRIGGER control_loop_policy_locked_paths_guard BEFORE INSERT OR UPDATE ON control_loop_policy_layers
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_policy_locked_paths();

CREATE TABLE control_loop_policy_waivers (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 256 AND path ~ '^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$' AND path !~ '(^|\.)(__proto__|prototype|constructor)(\.|$)'),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason ~ '[^[:space:]]'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  revoked_at timestamptz,
  consumed_by_request_id text,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,consumed_by_request_id) REFERENCES control_loop_improvement_requests(tenant_id,id) ON DELETE RESTRICT
);
CREATE FUNCTION guard_control_loop_policy_waiver() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.consumed_by_request_id IS NOT NULL THEN
      RAISE EXCEPTION 'new waiver must be unused' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM control_role_grants g WHERE g.tenant_id=NEW.tenant_id AND g.identity_id=NEW.created_by
      AND g.role_key='owner' AND g.risk_ceiling IN ('high','critical') AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
      AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'loop_policy.manage')
      AND (g.project_ids ? '*' OR g.project_ids ? NEW.project_id)) THEN
      RAISE EXCEPTION 'policy waiver needs current owner grant' USING ERRCODE='42501';
    END IF;
  ELSE
    IF (to_jsonb(NEW)-'revoked_at'-'consumed_by_request_id') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'consumed_by_request_id')
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
      OR (OLD.consumed_by_request_id IS NOT NULL AND NEW.consumed_by_request_id IS DISTINCT FROM OLD.consumed_by_request_id) THEN
      RAISE EXCEPTION 'policy waiver immutable transition' USING ERRCODE='23514';
    END IF;
    IF NEW.consumed_by_request_id IS DISTINCT FROM OLD.consumed_by_request_id THEN
      IF NEW.revoked_at IS NOT NULL OR NEW.expires_at <= statement_timestamp()
        OR NOT EXISTS(SELECT 1 FROM control_loop_improvement_requests r WHERE r.tenant_id=NEW.tenant_id
          AND r.id=NEW.consumed_by_request_id AND r.project_id=NEW.project_id) THEN
        RAISE EXCEPTION 'policy waiver consumption rejected' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_loop_policy_waiver() FROM PUBLIC;
CREATE TRIGGER control_loop_policy_waiver_guard BEFORE INSERT OR UPDATE ON control_loop_policy_waivers
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_policy_waiver();
CREATE TRIGGER control_loop_policy_waivers_immutable BEFORE DELETE ON control_loop_policy_waivers
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_waivers_no_truncate BEFORE TRUNCATE ON control_loop_policy_waivers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
ALTER TABLE control_loop_policy_input_sources DROP CONSTRAINT control_loop_policy_input_sources_waiver_id_check;
ALTER TABLE control_loop_policy_input_sources ADD CONSTRAINT control_loop_policy_sources_waiver_fk
  FOREIGN KEY (tenant_id,waiver_id) REFERENCES control_loop_policy_waivers(tenant_id,id) ON DELETE RESTRICT NOT VALID;
CREATE FUNCTION guard_control_loop_policy_source_waiver() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.waiver_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM control_loop_policy_waivers w
    JOIN control_loop_improvement_inputs i ON i.tenant_id=NEW.tenant_id AND i.request_id=NEW.request_id AND i.version=NEW.input_version
    WHERE w.tenant_id=NEW.tenant_id AND w.id=NEW.waiver_id AND w.project_id=i.project_id AND w.consumed_by_request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'policy source waiver scope rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_loop_policy_source_waiver() FROM PUBLIC;
CREATE TRIGGER control_loop_policy_source_waiver_guard BEFORE INSERT ON control_loop_policy_input_sources
  FOR EACH ROW EXECUTE FUNCTION guard_control_loop_policy_source_waiver();

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
        AND (NOT (binding->'body' ? 'waiverId') OR (jsonb_typeof(binding->'body'->'waiverId')='string'
          AND binding->'body'->>'waiverId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'))
        AND ((binding->'body') - ARRAY['description','settingsEdits','waiverId'])='{}'::jsonb
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
