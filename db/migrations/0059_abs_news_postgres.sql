-- Operational news metadata uses the existing PostgreSQL authority. These rows
-- are source/proposal data, never agent execution or publication permissions.
CREATE TABLE control_abs_story_versions (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  story_digest text NOT NULL CHECK (story_digest ~ '^sha256:[a-f0-9]{64}$'),
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, project_id, story_id, story_digest),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX control_abs_story_latest ON control_abs_story_versions
  (tenant_id, workspace_id, project_id, story_id, sequence DESC);
CREATE TRIGGER control_abs_story_immutable BEFORE UPDATE OR DELETE ON control_abs_story_versions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_abs_research_proposals (
  tenant_id text NOT NULL,
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_digest text NOT NULL CHECK (proposal_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^sha256:[a-f0-9]{64}$'),
  story_id text NOT NULL,
  story_digest text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, project_id, proposal_id),
  UNIQUE (tenant_id, workspace_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id,workspace_id,project_id,story_id,story_digest)
    REFERENCES control_abs_story_versions(tenant_id,workspace_id,project_id,story_id,story_digest) ON DELETE RESTRICT
);
CREATE TRIGGER control_abs_proposal_immutable BEFORE UPDATE OR DELETE ON control_abs_research_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
-- No role grants here. Authenticated application composition must explicitly
-- select read/ingestion/proposal rights; this migration does not enable a feed.
