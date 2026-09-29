-- S3: append-only per-agent admission order in front of the existing native
-- delivery queue. These records do not assign, lease, approve execution,
-- dispatch, or create a second pg-boss queue.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- Bind the owner's exact registered worker choice to the decided item. This
-- keeps the narrow web SQL role from inventing a different assignee later.
ALTER TABLE work_batch_items ADD COLUMN requested_worker_id text
  CHECK (requested_worker_id IS NULL OR requested_worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$');

CREATE TABLE work_batch_agent_queue_heads (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  worker_id text NOT NULL,
  next_position bigint NOT NULL CHECK (next_position >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,worker_id)
);

CREATE FUNCTION guard_work_batch_agent_queue_head_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.next_position<>1 THEN
      RAISE EXCEPTION 'work batch agent queue head insert rejected';
    END IF;
  ELSIF NEW.tenant_id<>OLD.tenant_id OR NEW.worker_id<>OLD.worker_id
    OR NEW.next_position<=OLD.next_position OR NEW.next_position>OLD.next_position+20
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'work batch agent queue head update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_batch_agent_queue_head_write() FROM PUBLIC;
CREATE TRIGGER work_batch_agent_queue_heads_guard
  BEFORE INSERT OR UPDATE ON public.work_batch_agent_queue_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_batch_agent_queue_head_write();
CREATE TRIGGER work_batch_agent_queue_heads_no_delete
  BEFORE DELETE ON public.work_batch_agent_queue_heads
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_batch_agent_queue_heads_no_truncate
  BEFORE TRUNCATE ON public.work_batch_agent_queue_heads
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

CREATE TABLE work_batch_queue_admissions (
  tenant_id text NOT NULL,
  admission_id text NOT NULL CHECK (admission_id ~ '^admission:[a-f0-9]{64}$'),
  item_id text NOT NULL,
  batch_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  worker_id text NOT NULL,
  worker_kind text NOT NULL CHECK (worker_kind IN ('codex','claude-code','hermes')),
  node_id text NOT NULL,
  queue_position bigint NOT NULL CHECK (queue_position >= 1),
  queue_depth_limit bigint NOT NULL CHECK (queue_depth_limit BETWEEN 1 AND 20),
  selection_key text NOT NULL,
  model text NOT NULL,
  effort text NOT NULL CHECK (effort IN ('default','low','medium','high','xhigh','max')),
  provider text,
  profile text,
  assignment_revision bigint NOT NULL CHECK (assignment_revision >= 1),
  supersedes_admission_id text,
  change_reason_code text NOT NULL CHECK (change_reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  authorized_by_identity_id text NOT NULL,
  admission_digest text NOT NULL CHECK (admission_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  admitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,admission_id),
  UNIQUE (tenant_id,item_id,assignment_revision),
  UNIQUE (tenant_id,job_id,assignment_revision),
  UNIQUE (tenant_id,worker_id,queue_position),
  FOREIGN KEY (tenant_id,item_id) REFERENCES work_batch_items(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,authorized_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,supersedes_admission_id)
    REFERENCES work_batch_queue_admissions(tenant_id,admission_id) ON DELETE RESTRICT,
  CHECK (admission_id='admission:' || substring(admission_digest from 8)),
  CHECK ((assignment_revision=1 AND supersedes_admission_id IS NULL AND change_reason_code='initial_owner_approval')
    OR (assignment_revision>1 AND supersedes_admission_id IS NOT NULL
      AND change_reason_code<>'initial_owner_approval')),
  CHECK ((worker_kind='hermes' AND provider IS NOT NULL AND profile IS NOT NULL)
    OR (worker_kind<>'hermes' AND provider IS NULL AND profile IS NULL))
);

CREATE FUNCTION guard_work_batch_queue_admission_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous public.work_batch_queue_admissions%ROWTYPE; has_previous boolean;
BEGIN
  -- No row lock: the append-only owner web role holds no UPDATE privilege.
  -- The decision already holds the batch and per-worker head row locks, and
  -- UNIQUE (tenant_id,item_id,assignment_revision) refuses a racing revision.
  SELECT * INTO previous FROM public.work_batch_queue_admissions a
    WHERE a.tenant_id=NEW.tenant_id AND a.item_id=NEW.item_id
    ORDER BY a.assignment_revision DESC LIMIT 1;
  has_previous=FOUND;
  IF NOT EXISTS (
    SELECT 1 FROM public.work_batch_items i JOIN public.work_batches b
      ON b.tenant_id=i.tenant_id AND b.id=i.batch_id AND b.project_id=i.project_id
    WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.item_id AND i.batch_id=NEW.batch_id
      AND i.project_id=NEW.project_id AND i.job_id=NEW.job_id AND i.decision_state='approved'
      AND b.queue_depth_limit=NEW.queue_depth_limit
      AND EXISTS (SELECT 1 FROM public.control_identities identity JOIN public.control_role_grants grant_record
        ON grant_record.tenant_id=identity.tenant_id AND grant_record.identity_id=identity.id
        WHERE identity.tenant_id=NEW.tenant_id AND identity.id=NEW.authorized_by_identity_id
          AND identity.actor_type='human' AND identity.state='active' AND grant_record.role_key='owner'
          AND grant_record.revoked_at IS NULL
          AND (grant_record.expires_at IS NULL OR grant_record.expires_at>NEW.admitted_at)
          AND (grant_record.project_ids @> pg_catalog.to_jsonb(ARRAY[NEW.project_id]::text[])
            OR grant_record.project_ids @> '["*"]'::jsonb)
          AND (grant_record.allowed_actions @> '["work_batches.decide"]'::jsonb
            OR grant_record.allowed_actions @> '["*"]'::jsonb))
  ) OR NOT EXISTS (
    SELECT 1 FROM public.work_batch_agent_queue_heads h WHERE h.tenant_id=NEW.tenant_id
      AND h.worker_id=NEW.worker_id AND NEW.queue_position<h.next_position
  ) OR EXISTS (
    SELECT 1 FROM public.work_batch_items current_item
    JOIN public.work_batch_items predecessor ON predecessor.tenant_id=current_item.tenant_id
      AND predecessor.batch_id=current_item.batch_id
      AND predecessor.local_id=ANY(current_item.depends_on_local_ids)
      AND predecessor.decision_state='approved'
    WHERE current_item.tenant_id=NEW.tenant_id AND current_item.id=NEW.item_id
      AND EXISTS (SELECT 1 FROM public.work_batch_queue_admissions prior
        WHERE prior.tenant_id=predecessor.tenant_id AND prior.item_id=predecessor.id
          AND prior.worker_id=NEW.worker_id AND prior.queue_position>=NEW.queue_position
          AND NOT EXISTS (SELECT 1 FROM public.work_batch_queue_admissions newer
            WHERE newer.tenant_id=prior.tenant_id AND newer.item_id=prior.item_id
              AND newer.assignment_revision>prior.assignment_revision))
  ) OR (NOT has_previous AND (NEW.assignment_revision<>1 OR NEW.supersedes_admission_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM public.work_batch_items i JOIN public.work_batches b
        ON b.tenant_id=i.tenant_id AND b.id=i.batch_id
        WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.item_id
          AND i.requested_worker_id=NEW.worker_id
          AND (i.requested_worker_kind IS NULL OR i.requested_worker_kind=NEW.worker_kind)
          AND (i.requested_model_key IS NULL OR i.requested_model_key=NEW.selection_key)
          AND b.state='proposed')))
    OR (has_previous AND (NEW.assignment_revision<>previous.assignment_revision+1
      OR NEW.supersedes_admission_id<>previous.admission_id
      OR NEW.batch_id<>previous.batch_id OR NEW.project_id<>previous.project_id
      OR NEW.job_id<>previous.job_id)) THEN
    RAISE EXCEPTION 'work batch queue admission rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_batch_queue_admission_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_queue_admissions_guard BEFORE INSERT ON public.work_batch_queue_admissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_batch_queue_admission_insert();
CREATE TRIGGER work_batch_queue_admissions_append_only BEFORE UPDATE OR DELETE ON public.work_batch_queue_admissions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_batch_queue_admissions_no_truncate BEFORE TRUNCATE ON public.work_batch_queue_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- The service advances one locked per-worker head before inserting the exact
-- batch of admissions. This deferred check sees the completed transaction and
-- makes gaps, abandoned allocations, and out-of-order position fabrication
-- impossible even for a caller that possesses the narrow head grants.
CREATE FUNCTION enforce_work_batch_agent_queue_head_consistency() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE admission_count bigint; highest_position bigint; final_next_position bigint;
BEGIN
  SELECT next_position INTO final_next_position
    FROM public.work_batch_agent_queue_heads
    WHERE tenant_id=NEW.tenant_id AND worker_id=NEW.worker_id;
  SELECT pg_catalog.count(*),coalesce(pg_catalog.max(queue_position),0)
    INTO admission_count,highest_position
    FROM public.work_batch_queue_admissions
    WHERE tenant_id=NEW.tenant_id AND worker_id=NEW.worker_id;
  IF final_next_position IS NULL OR admission_count<>final_next_position-1
    OR highest_position<>final_next_position-1 THEN
    RAISE EXCEPTION 'work batch agent queue head committed without contiguous admissions';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_work_batch_agent_queue_head_consistency() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER work_batch_agent_queue_heads_consistency
  AFTER INSERT OR UPDATE ON public.work_batch_agent_queue_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_work_batch_agent_queue_head_consistency();

-- Neither queue table is granted to the shared work-intake login. If one ever
-- is, it must still see and write only its bound tenant, as 0093/0102 confine
-- the batch tables. Every other role keeps its grants.
ALTER TABLE work_batch_agent_queue_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_batch_agent_queue_heads_existing_access ON work_batch_agent_queue_heads
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY work_batch_agent_queue_heads_work_intake_scope ON work_batch_agent_queue_heads
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    work_batch_agent_queue_heads.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    work_batch_agent_queue_heads.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));
ALTER TABLE work_batch_queue_admissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_batch_queue_admissions_existing_access ON work_batch_queue_admissions
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY work_batch_queue_admissions_work_intake_scope ON work_batch_queue_admissions
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session() OR
    work_batch_queue_admissions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b))
  WITH CHECK (NOT public.is_work_intake_session() OR
    work_batch_queue_admissions.tenant_id=(SELECT b.tenant_id FROM public.work_intake_tenant_binding b));

-- Effective assignment is derived, never updated in place: the highest
-- append-only revision for a stable item/job is the sole current admission.
CREATE VIEW work_batch_effective_queue_admissions AS
  SELECT a.* FROM work_batch_queue_admissions a
  WHERE NOT EXISTS (SELECT 1 FROM work_batch_queue_admissions newer
    WHERE newer.tenant_id=a.tenant_id AND newer.item_id=a.item_id
      AND newer.assignment_revision>a.assignment_revision);
ALTER VIEW work_batch_effective_queue_admissions OWNER TO CURRENT_USER;
REVOKE ALL ON work_batch_effective_queue_admissions FROM PUBLIC;

CREATE INDEX work_batch_queue_agent_order
  ON work_batch_queue_admissions(tenant_id,worker_id,queue_position);
CREATE INDEX work_batch_queue_project
  ON work_batch_queue_admissions(tenant_id,project_id,batch_id,queue_position);
CREATE INDEX work_batch_queue_item_revision
  ON work_batch_queue_admissions(tenant_id,item_id,assignment_revision DESC);
