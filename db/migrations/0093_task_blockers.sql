-- Durable structured blockers and linked, non-executing owner hand-offs.
ALTER TABLE control_jobs DROP CONSTRAINT control_jobs_state_check;
ALTER TABLE control_jobs ADD CONSTRAINT control_jobs_state_check CHECK
  (state IN ('proposed','ready','leased','running','waiting_approval','blocked','succeeded','failed','cancelled','orphaned','rejected'));

ALTER TABLE control_attempts DROP CONSTRAINT control_attempts_state_check;
ALTER TABLE control_attempts ADD CONSTRAINT control_attempts_state_check CHECK
  (state IN ('offered','leased','running','waiting','blocked','succeeded','failed','cancelled','orphaned'));

CREATE TABLE control_task_blockers (
  id text NOT NULL,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  worker_id text NOT NULL,
  task_owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('owner_decision','credential_or_permission','dependency','environment_broken','out_of_scope')),
  state text NOT NULL CHECK (state IN ('open','handoff_pending','resolved','handed_off','cancelled')),
  reported_at timestamptz NOT NULL,
  resolved_at timestamptz,
  payload jsonb NOT NULL,
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  disposition_digest text CHECK (disposition_digest IS NULL OR disposition_digest ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,job_id,project_id) REFERENCES control_jobs(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,task_owner_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='open') = (resolved_at IS NULL)),
  CHECK ((state='open') = (disposition_digest IS NULL))
);
CREATE INDEX idx_control_task_blockers_open ON control_task_blockers(tenant_id,task_owner_id,state,reported_at DESC,id);
CREATE UNIQUE INDEX uq_control_task_blockers_current_attempt
  ON control_task_blockers(tenant_id,job_id,attempt_id) WHERE state IN ('open','handoff_pending');

CREATE TABLE control_task_blocker_events (
  event_id text NOT NULL,
  tenant_id text NOT NULL,
  blocker_id text NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('reported','unblock','handoff','cancel')),
  actor_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent')),
  occurred_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,event_id),
  FOREIGN KEY (tenant_id,blocker_id) REFERENCES control_task_blockers(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,blocker_id,event_kind)
);
CREATE TRIGGER control_task_blocker_events_append_only
BEFORE UPDATE OR DELETE ON control_task_blocker_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_task_blocker_handoffs (
  tenant_id text NOT NULL,
  blocker_id text NOT NULL,
  job_id text NOT NULL,
  prior_attempt_id text NOT NULL,
  target_node_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,blocker_id),
  UNIQUE (tenant_id,job_id,prior_attempt_id),
  FOREIGN KEY (tenant_id,blocker_id) REFERENCES control_task_blockers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,prior_attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,target_node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_task_blocker_handoffs_append_only
BEFORE UPDATE OR DELETE ON control_task_blocker_handoffs
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_task_blocker_handoff_completions (
  tenant_id text NOT NULL,
  blocker_id text NOT NULL,
  prior_attempt_id text NOT NULL,
  next_attempt_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,blocker_id),
  UNIQUE (tenant_id,next_attempt_id),
  FOREIGN KEY (tenant_id,blocker_id) REFERENCES control_task_blocker_handoffs(tenant_id,blocker_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,prior_attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,next_attempt_id) REFERENCES control_attempts(tenant_id,id) ON DELETE RESTRICT,
  CHECK (prior_attempt_id <> next_attempt_id)
);
CREATE TRIGGER control_task_blocker_handoff_completions_append_only
BEFORE UPDATE OR DELETE ON control_task_blocker_handoff_completions
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
