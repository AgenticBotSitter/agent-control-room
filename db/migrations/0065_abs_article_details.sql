-- Extracted source material is not a native result or execution receipt.
CREATE TABLE control_abs_article_details (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  story_digest text NOT NULL,
  detail_digest text NOT NULL CHECK (detail_digest ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload jsonb NOT NULL CHECK (COALESCE(jsonb_typeof(payload) = 'object'
    AND payload->>'status' = 'extracted'
    AND jsonb_typeof(payload->'text') = 'string'
    AND octet_length(payload->>'text') BETWEEN 1 AND 131072, false)),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,workspace_id,project_id,story_id,story_digest,detail_digest),
  FOREIGN KEY (tenant_id,workspace_id,project_id,story_id,story_digest)
    REFERENCES control_abs_story_versions(tenant_id,workspace_id,project_id,story_id,story_digest) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_article_details_immutable BEFORE UPDATE OR DELETE ON control_abs_article_details
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_abs_article_details_no_truncate BEFORE TRUNCATE ON control_abs_article_details
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
-- No implicit grants. Web reads and trusted ingestion writes are separate roles.
