-- Proposal-only agent work intake. These records cannot create a canonical task,
-- queue delivery, assignment, approval, effect, or execution authority.

CREATE TABLE work_batches (
  id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  proposed_by_identity_id text NOT NULL,
  proposed_by_actor_type text NOT NULL CHECK (proposed_by_actor_type='agent'),
  proposed_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','approved','partially_approved','rejected','superseded')),
  approval_identity_id text,
  approved_at timestamptz,
  decision_reason_code text,
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  queue_depth_limit integer NOT NULL CHECK (queue_depth_limit BETWEEN 1 AND 20),
  batch_digest text NOT NULL CHECK (batch_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  version bigint NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,proposed_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,approval_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='proposed' AND approval_identity_id IS NULL AND approved_at IS NULL)
    OR state<>'proposed'),
  CHECK (approved_at IS NULL OR approved_at >= proposed_at)
);

CREATE TABLE work_batch_revisions (
  id text NOT NULL,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  edited_by_identity_id text NOT NULL,
  edited_at timestamptz NOT NULL,
  reason_code text NOT NULL,
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  revision_digest text NOT NULL CHECK (revision_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,batch_id,revision),
  FOREIGN KEY (tenant_id,batch_id) REFERENCES work_batches(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,edited_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION guard_proposal_only_work_batch_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state<>'proposed' OR NEW.proposed_by_actor_type<>'agent' OR NEW.version<>1
    OR NEW.approval_identity_id IS NOT NULL OR NEW.approved_at IS NOT NULL
    OR NEW.decision_reason_code IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM control_identities i
      JOIN control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.proposed_by_identity_id
        AND i.actor_type='agent' AND i.state='active'
        AND g.role_key='work_batch_proposer'
        AND g.allowed_actions='["work_batches.propose"]'::jsonb
        AND g.risk_ceiling='low' AND NOT g.allow_external_effects AND NOT g.require_strong_factor
        AND (g.project_ids @> to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.revoked_at IS NULL OR g.revoked_at>statement_timestamp())
        AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
      FOR SHARE OF i,g
    ) THEN
    RAISE EXCEPTION 'proposal-only work batch insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_proposal_only_work_batch_insert() FROM PUBLIC;
CREATE TRIGGER work_batches_proposal_only BEFORE INSERT ON work_batches
  FOR EACH ROW EXECUTE FUNCTION guard_proposal_only_work_batch_insert();

CREATE FUNCTION guard_initial_work_batch_revision_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision<>1 OR NEW.reason_code<>'submitted' OR NOT EXISTS (
    SELECT 1 FROM work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id
      AND b.proposed_by_identity_id=NEW.edited_by_identity_id AND b.proposal=NEW.proposal
      AND b.batch_digest=NEW.revision_digest
  ) THEN
    RAISE EXCEPTION 'initial work batch revision insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_initial_work_batch_revision_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_revisions_initial_only BEFORE INSERT ON work_batch_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_initial_work_batch_revision_insert();

CREATE TRIGGER work_batch_revisions_append_only BEFORE UPDATE OR DELETE ON work_batch_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER work_batch_revisions_truncate_guard BEFORE TRUNCATE ON work_batch_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- A down migration is intentionally operator-authored and data refusing:
-- it must first lock both tables and raise when work_batches contains any row.
-- Production recovery never silently drops these records.
