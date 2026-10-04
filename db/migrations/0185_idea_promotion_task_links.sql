-- Idea promotion creates one normal project and one ordinary proposed first task.
-- This append-only link preserves provenance; it is not an assignment, approval,
-- queue entry, execution permit, or retry authority.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_idea_promotion_task_links (
  tenant_id text NOT NULL,
  session_id text NOT NULL,
  decision_digest text NOT NULL CHECK (decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  project_id text NOT NULL,
  job_id text NOT NULL,
  request_id text NOT NULL,
  link_digest text NOT NULL CHECK (link_digest ~ '^sha256:[a-f0-9]{64}$'),
  link_auth_tag text NOT NULL CHECK (link_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,session_id),
  UNIQUE (tenant_id,decision_digest),
  UNIQUE (tenant_id,job_id),
  FOREIGN KEY (tenant_id,session_id)
    REFERENCES control_idea_decisions(tenant_id,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,decision_digest)
    REFERENCES control_idea_decisions(tenant_id,decision_digest) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id,project_id)
    REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id)
    REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);

REVOKE ALL ON control_idea_promotion_task_links FROM PUBLIC;
CREATE TRIGGER control_idea_promotion_task_links_append_only
  BEFORE UPDATE OR DELETE ON control_idea_promotion_task_links
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_idea_promotion_task_links_no_truncate
  BEFORE TRUNCATE ON control_idea_promotion_task_links
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_idea_promotion_task_links TO control_room_private_web';
  END IF;
END $$;
