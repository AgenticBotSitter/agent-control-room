-- Canonical Idea Lab work remains ordinary Control Room work. These append-only
-- links preserve discussion provenance and the one selected ordinary project;
-- they are not a queue, task state, result ledger, permission grant, or retry
-- mechanism.
CREATE TABLE control_idea_canonical_task_sessions (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  session_digest text NOT NULL CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  binding_auth_tag text NOT NULL CHECK (binding_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_id),
  UNIQUE (tenant_id, binding_digest),
  FOREIGN KEY (tenant_id, session_id) REFERENCES control_idea_sessions(tenant_id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_digest) REFERENCES control_idea_sessions(tenant_id, session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE control_idea_canonical_task_links (
  tenant_id text NOT NULL,
  task_key text NOT NULL,
  session_id text NOT NULL,
  session_digest text NOT NULL CHECK (session_digest ~ '^sha256:[a-f0-9]{64}$'),
  workspace_id text NOT NULL,
  project_id text NOT NULL,
  participant_id text NOT NULL,
  round integer NOT NULL CHECK (round BETWEEN 1 AND 3),
  task_plan_digest text NOT NULL CHECK (task_plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  task_input_digest text NOT NULL CHECK (task_input_digest ~ '^sha256:[a-f0-9]{64}$'),
  job_id text NOT NULL,
  request_id text NOT NULL,
  link_digest text NOT NULL CHECK (link_digest ~ '^sha256:[a-f0-9]{64}$'),
  link_auth_tag text NOT NULL CHECK (link_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, task_key),
  UNIQUE (tenant_id, link_digest),
  UNIQUE (tenant_id, session_id, participant_id, round),
  UNIQUE (tenant_id, job_id),
  FOREIGN KEY (tenant_id, session_id) REFERENCES control_idea_canonical_task_sessions(tenant_id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, session_digest) REFERENCES control_idea_sessions(tenant_id, session_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT
);

CREATE INDEX idx_control_idea_canonical_task_links_session
  ON control_idea_canonical_task_links(tenant_id, session_id, round, participant_id);

CREATE TRIGGER control_idea_canonical_task_sessions_append_only
  BEFORE UPDATE OR DELETE ON control_idea_canonical_task_sessions FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_canonical_task_links_append_only
  BEFORE UPDATE OR DELETE ON control_idea_canonical_task_links FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_canonical_task_sessions_no_truncate
  BEFORE TRUNCATE ON control_idea_canonical_task_sessions FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_canonical_task_links_no_truncate
  BEFORE TRUNCATE ON control_idea_canonical_task_links FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
