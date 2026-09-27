-- Owner-only batch revision and decision records. Approval materializes only
-- ordinary proposed tasks; this migration grants no queue or execution access.

ALTER TABLE work_batches
  ADD COLUMN decision_digest text CHECK (decision_digest IS NULL OR decision_digest ~ '^sha256:[a-f0-9]{64}$'),
  ADD COLUMN decision_auth_tag text CHECK (decision_auth_tag IS NULL OR decision_auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$');

CREATE TABLE work_batch_items (
  id text NOT NULL,
  tenant_id text NOT NULL,
  batch_id text NOT NULL,
  batch_revision bigint NOT NULL CHECK (batch_revision >= 1),
  project_id text NOT NULL,
  local_id text NOT NULL CHECK (local_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
  role text NOT NULL CHECK (role IN ('builder','checker','validator')),
  required_capability text NOT NULL,
  depends_on_local_ids text[] NOT NULL,
  requested_worker_kind text,
  requested_model_key text,
  acceptance_criteria text NOT NULL,
  acceptance_tests text NOT NULL,
  decision_state text NOT NULL CHECK (decision_state IN ('approved','rejected')),
  decision_reason_code text,
  job_id text,
  job_attempt_count integer NOT NULL DEFAULT 0 CHECK (job_attempt_count >= 0),
  item_digest text NOT NULL CHECK (item_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,batch_id,local_id),
  UNIQUE (tenant_id,batch_id,ordinal),
  UNIQUE (tenant_id,job_id),
  FOREIGN KEY (tenant_id,batch_id,project_id) REFERENCES work_batches(tenant_id,id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  CHECK (cardinality(depends_on_local_ids) <= 31),
  CHECK ((decision_state='approved' AND job_id IS NOT NULL AND decision_reason_code IS NULL)
    OR (decision_state='rejected' AND job_id IS NULL
      AND decision_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'))
);

CREATE FUNCTION guard_work_batch_item_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='control_room_work_intake'
      AND pg_has_role(session_user,r.oid,'member')
      AND EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper))
    OR NOT EXISTS (
      SELECT 1 FROM work_batches b
      WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id AND b.project_id=NEW.project_id
        AND b.state='proposed' AND b.version=NEW.batch_revision
    )
    OR (NEW.job_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM control_jobs j WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.job_id
        AND j.project_id=NEW.project_id AND j.state='proposed'
    )) THEN
    RAISE EXCEPTION 'work batch item insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_work_batch_item_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_items_guard BEFORE INSERT ON work_batch_items
  FOR EACH ROW EXECUTE FUNCTION guard_work_batch_item_insert();
CREATE TRIGGER work_batch_items_append_only BEFORE UPDATE OR DELETE ON work_batch_items
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER work_batch_items_truncate_guard BEFORE TRUNCATE ON work_batch_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

CREATE OR REPLACE FUNCTION guard_initial_work_batch_revision_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE batch work_batches%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM work_batches b
    WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'work batch revision insert rejected'; END IF;
  IF NEW.revision=1 THEN
    IF NEW.reason_code<>'submitted' OR batch.proposed_by_identity_id<>NEW.edited_by_identity_id
      OR batch.proposal<>NEW.proposal OR batch.batch_digest<>NEW.revision_digest THEN
      RAISE EXCEPTION 'initial work batch revision insert rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF batch.state<>'proposed' OR NEW.revision<>batch.version+1
    OR NEW.reason_code !~ '^[a-z][a-z0-9_]{2,63}$'
    OR NOT EXISTS (
      SELECT 1 FROM control_identities i JOIN control_role_grants g
        ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.edited_by_identity_id
        AND i.actor_type='human' AND i.state='active' AND g.role_key='owner'
        AND (g.project_ids @> to_jsonb(ARRAY[batch.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.allowed_actions @> '["work_batches.decide"]'::jsonb OR g.allowed_actions @> '["*"]'::jsonb)
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
    ) THEN
    RAISE EXCEPTION 'work batch revision insert rejected';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_work_batch_owner_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item_total integer; approved_total integer; rejected_total integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='control_room_work_intake'
      AND pg_has_role(session_user,r.oid,'member')
      AND EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper))
    OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.project_id<>OLD.project_id
    OR NEW.proposed_by_identity_id<>OLD.proposed_by_identity_id
    OR NEW.proposed_by_actor_type<>OLD.proposed_by_actor_type OR NEW.proposed_at<>OLD.proposed_at
    OR NEW.proposal<>OLD.proposal OR NEW.queue_depth_limit<>OLD.queue_depth_limit
    OR NEW.batch_digest<>OLD.batch_digest OR NEW.auth_tag<>OLD.auth_tag OR NEW.created_at<>OLD.created_at
    OR OLD.state<>'proposed' OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'work batch owner update rejected';
  END IF;
  IF NEW.state='proposed' THEN
    IF NEW.version<>OLD.version+1 OR NEW.approval_identity_id IS NOT NULL
      OR NEW.approved_at IS NOT NULL OR NEW.decision_reason_code IS NOT NULL
      OR NEW.decision_digest IS NOT NULL OR NEW.decision_auth_tag IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM work_batch_revisions r WHERE r.tenant_id=NEW.tenant_id
        AND r.batch_id=NEW.id AND r.revision=NEW.version) THEN
      RAISE EXCEPTION 'work batch revision update rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state NOT IN ('approved','partially_approved','rejected') OR NEW.version<>OLD.version
    OR NEW.approval_identity_id IS NULL OR NEW.approved_at IS NULL
    OR NEW.decision_digest IS NULL OR NEW.decision_auth_tag IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM control_identities i JOIN control_role_grants g
        ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      JOIN projects p ON p.tenant_id=i.tenant_id AND p.id=NEW.project_id
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.approval_identity_id
        AND i.actor_type='human' AND i.state='active' AND h.lifecycle='active'
        AND g.role_key='owner'
        AND (g.project_ids @> to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.allowed_actions @> '["work_batches.decide"]'::jsonb OR g.allowed_actions @> '["*"]'::jsonb)
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>statement_timestamp())
    ) THEN
    RAISE EXCEPTION 'work batch decision update rejected';
  END IF;
  SELECT count(*),count(*) FILTER (WHERE decision_state='approved'),
    count(*) FILTER (WHERE decision_state='rejected')
    INTO item_total,approved_total,rejected_total FROM work_batch_items
    WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.id AND batch_revision=NEW.version;
  IF item_total<>jsonb_array_length((SELECT proposal->'tasks' FROM work_batch_revisions
      WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.id AND revision=NEW.version))
    OR (NEW.state='approved' AND approved_total<>item_total)
    OR (NEW.state='rejected' AND rejected_total<>item_total)
    OR (NEW.state='partially_approved' AND (approved_total=0 OR rejected_total=0))
    OR (NEW.state='rejected' AND NEW.decision_reason_code IS NULL)
    OR (NEW.state<>'rejected' AND NEW.decision_reason_code IS NOT NULL) THEN
    RAISE EXCEPTION 'work batch decision items rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_work_batch_owner_update() FROM PUBLIC;
CREATE TRIGGER work_batches_owner_update BEFORE UPDATE ON work_batches
  FOR EACH ROW EXECUTE FUNCTION guard_work_batch_owner_update();

CREATE FUNCTION guard_work_batch_notification_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='control_room_work_intake'
      AND pg_has_role(session_user,r.oid,'member')
      AND EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper))
    AND (NEW.id IS DISTINCT FROM 'attention:work-batch:' || NEW.work_item_id
      OR NEW.kind IS DISTINCT FROM 'approval' OR NEW.state IS DISTINCT FROM 'open'
      OR NEW.delivery_state IS DISTINCT FROM 'delivered' OR NEW.expires_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.work_item_id
        AND b.project_id=NEW.project_id AND b.state='proposed')
      OR (NEW.payload - 'createdAt') IS DISTINCT FROM jsonb_build_object(
        'id',NEW.id,'tenantId',NEW.tenant_id,'projectId',NEW.project_id,'workItemId',NEW.work_item_id,
        'kind','approval','state','open','requestedAction','Review proposed work batch',
        'reasonCode','work_batch_proposed','blockedWorkItemIds','[]'::jsonb,
        'legalResponses',jsonb_build_array(jsonb_build_object('id','open:' || NEW.work_item_id,
          'kind','open_source','label','Open batch review','requiresConfirmation',false,'available',true)),
        'evidence','[]'::jsonb,'deliveryState','delivered')
      OR (NEW.payload->>'createdAt')::timestamptz IS DISTINCT FROM NEW.created_at) THEN
    RAISE EXCEPTION 'work batch notification insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_work_batch_notification_insert() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_work_batch_guard BEFORE INSERT ON control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION guard_work_batch_notification_insert();

CREATE FUNCTION guard_work_batch_notification_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='control_room_private_web'
      AND pg_has_role(session_user,r.oid,'member')
      AND EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper))
    AND OLD.id NOT LIKE 'attention:work-batch:%' THEN
    RAISE EXCEPTION 'private web action inbox update rejected';
  END IF;
  IF OLD.id LIKE 'attention:work-batch:%' AND (
    NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_item_id IS DISTINCT FROM OLD.work_item_id OR NEW.kind<>OLD.kind
    OR OLD.state<>'open' OR NEW.state<>'resolved' OR NEW.delivery_state<>OLD.delivery_state
    OR NEW.created_at<>OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.payload<>jsonb_set(OLD.payload,'{state}','"resolved"'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.work_item_id
      AND b.project_id=NEW.project_id AND b.state IN ('approved','partially_approved','rejected'))
  ) THEN RAISE EXCEPTION 'work batch notification update rejected'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_work_batch_notification_update() FROM PUBLIC;
CREATE TRIGGER control_action_inbox_work_batch_update_guard BEFORE UPDATE ON control_action_inbox
  FOR EACH ROW EXECUTE FUNCTION guard_work_batch_notification_update();
