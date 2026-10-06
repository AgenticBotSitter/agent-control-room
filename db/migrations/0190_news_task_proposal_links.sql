-- A normal task proposal may cite a retained news story. This immutable link
-- preserves that provenance without granting dispatch, network, or publication.
CREATE TABLE control_news_task_proposal_links (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^sha256:[a-f0-9]{64}$'),
  story_id text NOT NULL,
  story_digest text NOT NULL CHECK (story_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,workspace_id,project_id,job_id),
  UNIQUE (tenant_id,workspace_id,project_id,proposal_id),
  FOREIGN KEY (tenant_id,workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,workspace_id,project_id,story_id,story_digest)
    REFERENCES control_news_story_versions(tenant_id,workspace_id,project_id,story_id,story_digest) ON DELETE RESTRICT
);
CREATE TRIGGER control_news_task_proposal_links_immutable BEFORE UPDATE OR DELETE ON control_news_task_proposal_links
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_news_task_proposal_links_no_truncate BEFORE TRUNCATE ON control_news_task_proposal_links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
REVOKE ALL ON control_news_task_proposal_links FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_news_task_proposal_links TO control_room_private_web';
  END IF;
END $$;
