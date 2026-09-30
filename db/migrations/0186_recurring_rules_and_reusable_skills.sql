-- M6: owner-authored recurring proposal rules and immutable reusable text skills.
-- Neither table family grants execution authority. A due rule can only call the
-- existing proposal-only S1 work-batch intake.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_skills (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  skill_id text NOT NULL CHECK (skill_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  current_version bigint NOT NULL CHECK (current_version >= 1),
  state text NOT NULL CHECK (state IN ('active','retired')),
  created_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id,project_id,skill_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE control_skill_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  skill_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 12000),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,skill_id,version),
  FOREIGN KEY (tenant_id,project_id,skill_id) REFERENCES control_skills(tenant_id,project_id,skill_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER control_skill_versions_append_only BEFORE UPDATE OR DELETE ON control_skill_versions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_skill_versions_truncate_guard BEFORE TRUNCATE ON control_skill_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE FUNCTION guard_control_skill_head_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.project_id,NEW.skill_id,NEW.name,NEW.created_by_identity_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.project_id,OLD.skill_id,OLD.name,OLD.created_by_identity_id,OLD.created_at)
    OR NEW.updated_at < OLD.updated_at
    OR (NEW.current_version <> OLD.current_version AND NEW.current_version <> OLD.current_version + 1)
    OR OLD.state='retired' THEN
    RAISE EXCEPTION 'skill head update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_control_skill_head_update() FROM PUBLIC;
CREATE TRIGGER control_skills_update_guard BEFORE UPDATE ON control_skills
  FOR EACH ROW EXECUTE FUNCTION guard_control_skill_head_update();

CREATE TABLE control_task_skill_bindings (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  skill_id text NOT NULL,
  skill_version bigint NOT NULL CHECK (skill_version >= 1),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  bound_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,job_id,skill_id),
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id,skill_id,skill_version)
    REFERENCES control_skill_versions(tenant_id,project_id,skill_id,version) ON DELETE RESTRICT
);
CREATE TRIGGER control_task_skill_bindings_append_only BEFORE UPDATE OR DELETE ON control_task_skill_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_task_skill_bindings_truncate_guard BEFORE TRUNCATE ON control_task_skill_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE control_recurring_rules (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  rule_id text NOT NULL CHECK (rule_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  state text NOT NULL CHECK (state IN ('active','paused')),
  plain_schedule text NOT NULL CHECK (char_length(plain_schedule) BETWEEN 1 AND 120),
  cron_expression text NOT NULL CHECK (char_length(cron_expression) BETWEEN 9 AND 80),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 80),
  task_template jsonb NOT NULL CHECK (jsonb_typeof(task_template)='object'),
  version bigint NOT NULL CHECK (version >= 1),
  created_by_identity_id text NOT NULL,
  updated_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  last_evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,rule_id),
  UNIQUE (tenant_id,project_id,rule_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,updated_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX control_recurring_rules_due ON control_recurring_rules(tenant_id,state,last_evaluated_at,rule_id);

CREATE TABLE control_recurring_proposals (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  rule_id text NOT NULL,
  occurrence_key text NOT NULL CHECK (char_length(occurrence_key) BETWEEN 3 AND 240),
  scheduled_for timestamptz NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 12 AND 180),
  state text NOT NULL CHECK (state IN ('pending','proposed','failed')),
  attempt_count bigint NOT NULL CHECK (attempt_count >= 1),
  batch_id text,
  safe_reason_code text CHECK (safe_reason_code IS NULL OR safe_reason_code IN ('operations_mode','proposal_failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id,rule_id,occurrence_key),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,project_id,rule_id) REFERENCES control_recurring_rules(tenant_id,project_id,rule_id) ON DELETE RESTRICT,
  CHECK ((state='proposed') = (batch_id IS NOT NULL)),
  CHECK ((state='failed') = (safe_reason_code IS NOT NULL))
);

-- Keep S1 lineage exact without making the older work-batch migration own a
-- dependency created here. This lets each migration's empty downgrade remove
-- only its own objects while still refusing a missing or cross-project batch.
CREATE FUNCTION guard_recurring_proposal_batch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state='proposed' AND NOT EXISTS (
    SELECT 1 FROM work_batches b
    WHERE b.tenant_id=NEW.tenant_id AND b.project_id=NEW.project_id AND b.id=NEW.batch_id
  ) THEN
    RAISE EXCEPTION 'recurring proposal batch rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_recurring_proposal_batch() FROM PUBLIC;
CREATE TRIGGER control_recurring_proposals_batch_guard BEFORE INSERT OR UPDATE ON control_recurring_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_recurring_proposal_batch();

CREATE FUNCTION guard_recurring_proposal_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF ROW(NEW.tenant_id,NEW.project_id,NEW.rule_id,NEW.occurrence_key,NEW.scheduled_for,
      NEW.definition_digest,NEW.idempotency_key,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.project_id,OLD.rule_id,OLD.occurrence_key,OLD.scheduled_for,
      OLD.definition_digest,OLD.idempotency_key,OLD.created_at)
    OR OLD.state='proposed' AND ROW(NEW.state,NEW.batch_id,NEW.safe_reason_code)
      IS DISTINCT FROM ROW(OLD.state,OLD.batch_id,OLD.safe_reason_code)
    OR NEW.attempt_count < OLD.attempt_count OR NEW.attempt_count > OLD.attempt_count + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'recurring proposal update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_recurring_proposal_update() FROM PUBLIC;
CREATE TRIGGER control_recurring_proposals_update_guard BEFORE UPDATE ON control_recurring_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_recurring_proposal_update();
CREATE TRIGGER control_recurring_proposals_delete_guard BEFORE DELETE ON control_recurring_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_recurring_proposals_truncate_guard BEFORE TRUNCATE ON control_recurring_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
