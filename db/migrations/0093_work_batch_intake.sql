-- Proposal-only agent work intake. These records cannot create a canonical task,
-- queue delivery, assignment, approval, effect, or execution authority.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

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
  queue_depth_limit bigint NOT NULL CHECK (queue_depth_limit BETWEEN 1 AND 20),
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

-- Bind the intake privilege class to a dedicated marker ACL, whose grantees
-- are stored by PostgreSQL as role OIDs. The production grants file gives
-- SELECT on this empty relation only to the intake group. This survives a role
-- rename and is remapped by PostgreSQL backup/restore rather than persisting a
-- cluster-local numeric OID in application data.
CREATE TABLE work_intake_role_anchor (
  singleton boolean PRIMARY KEY CHECK (singleton)
);
REVOKE ALL ON work_intake_role_anchor FROM PUBLIC;

CREATE FUNCTION is_work_intake_session() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,
      pg_catalog.acldefault('r',c.relowner))) a
    JOIN pg_catalog.pg_roles s ON s.rolname=session_user
    WHERE c.oid='public.work_intake_role_anchor'::pg_catalog.regclass
      AND a.grantee<>0 AND a.grantee<>c.relowner
      AND a.privilege_type='SELECT'
      AND pg_catalog.pg_has_role(s.oid,a.grantee,'member')
      AND NOT s.rolsuper
  )
$$;

CREATE FUNCTION guard_proposal_only_work_batch_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state<>'proposed' OR NEW.proposed_by_actor_type<>'agent' OR NEW.version<>1
    OR NEW.approval_identity_id IS NOT NULL OR NEW.approved_at IS NOT NULL
    OR NEW.decision_reason_code IS NOT NULL OR NOT EXISTS (
      SELECT 1
      FROM public.control_identities i
      JOIN public.control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.proposed_by_identity_id
        AND i.actor_type='agent' AND i.state='active'
        AND g.role_key='work_batch_proposer'
        AND g.allowed_actions='["work_batches.propose"]'::jsonb
        AND g.risk_ceiling='low' AND NOT g.allow_external_effects AND NOT g.require_strong_factor
        AND (g.project_ids @> pg_catalog.to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
        AND (g.revoked_at IS NULL OR g.revoked_at>pg_catalog.statement_timestamp())
        AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.statement_timestamp())
      FOR SHARE OF i,g
    ) THEN
    RAISE EXCEPTION 'proposal-only work batch insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_proposal_only_work_batch_insert() FROM PUBLIC;
CREATE TRIGGER work_batches_proposal_only BEFORE INSERT ON public.work_batches
  FOR EACH ROW EXECUTE FUNCTION public.guard_proposal_only_work_batch_insert();

CREATE FUNCTION guard_initial_work_batch_revision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.revision<>1 OR NEW.reason_code<>'submitted' OR NOT EXISTS (
    SELECT 1 FROM public.work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.batch_id
      AND b.proposed_by_identity_id=NEW.edited_by_identity_id AND b.proposal=NEW.proposal
      AND b.batch_digest=NEW.revision_digest
  ) THEN
    RAISE EXCEPTION 'initial work batch revision insert rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_initial_work_batch_revision_insert() FROM PUBLIC;
CREATE TRIGGER work_batch_revisions_initial_only BEFORE INSERT ON public.work_batch_revisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_initial_work_batch_revision_insert();

CREATE TRIGGER work_batch_revisions_append_only BEFORE UPDATE OR DELETE ON public.work_batch_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER work_batch_revisions_truncate_guard BEFORE TRUNCATE ON public.work_batch_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- The production intake login uses shared idempotency and audit ledgers. Keep
-- its raw table privileges inside the proposal-only namespace even if the
-- process holding that login is compromised. Membership is derived from
-- session_user so SET ROLE cannot turn the login-level boundary off and a
-- future login granted the same group cannot bypass it.
CREATE FUNCTION guard_work_intake_idempotency_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_work_intake_session() THEN
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.operation_scope !~ '^work-batches\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
      OR NEW.status<>'processing' OR NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.control_identities i JOIN public.control_role_grants g
          ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
        WHERE i.tenant_id=NEW.tenant_id
          AND i.id=pg_catalog.substring(NEW.operation_scope, '^work-batches\.propose/v1:(.+)$')
          AND i.actor_type='agent' AND i.state='active'
          AND g.role_key='work_batch_proposer'
          AND g.allowed_actions='["work_batches.propose"]'::jsonb
          AND g.risk_ceiling='low' AND NOT g.allow_external_effects AND NOT g.require_strong_factor
          AND (g.revoked_at IS NULL OR g.revoked_at>pg_catalog.statement_timestamp())
          AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.statement_timestamp())
      ) THEN
      RAISE EXCEPTION 'work intake idempotency insert rejected';
    END IF;
  ELSIF OLD.operation_scope !~ '^work-batches\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.operation_scope IS DISTINCT FROM OLD.operation_scope
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR OLD.status<>'processing' OR OLD.result IS NOT NULL OR OLD.completed_at IS NOT NULL
    OR NEW.status<>'completed' OR NEW.completed_at IS NULL
    OR pg_catalog.jsonb_typeof(NEW.result)<>'object'
    OR NEW.result->>'schema'<>'control-room.work-batch-receipt/v1'
    OR NEW.result->>'state'<>'proposed'
    OR NEW.result->>'startsWork'<>'false'
    OR NEW.result->>'grantsExecutionAuthority'<>'false'
    OR NEW.result->>'replayed'<>'false'
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.result))<>9
    OR NOT EXISTS (
      SELECT 1 FROM public.work_batches b
      WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.result->>'batchId'
        AND b.project_id=NEW.result->>'projectId' AND b.state='proposed'
        AND b.proposed_by_identity_id=pg_catalog.substring(NEW.operation_scope, '^work-batches\.propose/v1:(.+)$')
        AND b.batch_digest=NEW.result->>'proposalDigest'
        AND b.version=(NEW.result->>'revision')::bigint
    ) THEN
    RAISE EXCEPTION 'work intake idempotency update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_intake_idempotency_write() FROM PUBLIC;
CREATE TRIGGER control_idempotency_work_intake_guard
  BEFORE INSERT OR UPDATE ON public.control_idempotency
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_intake_idempotency_write();

ALTER TABLE control_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY control_idempotency_existing_access ON control_idempotency
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY control_idempotency_work_intake_scope ON control_idempotency
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session()
    OR operation_scope ~ '^work-batches\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$')
  WITH CHECK (NOT public.is_work_intake_session()
    OR operation_scope ~ '^work-batches\.propose/v1:[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$');

CREATE FUNCTION work_intake_canonical_jsonb(input jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE kind text := pg_catalog.jsonb_typeof(input); rendered text;
BEGIN
  IF kind IN ('null','boolean','number','string') THEN RETURN input::text; END IF;
  IF kind='array' THEN
    SELECT '[' || coalesce(pg_catalog.string_agg(public.work_intake_canonical_jsonb(value),',' ORDER BY ordinal),'') || ']'
      INTO rendered FROM pg_catalog.jsonb_array_elements(input) WITH ORDINALITY AS item(value,ordinal);
    RETURN rendered;
  END IF;
  IF kind='object' THEN
    SELECT '{' || coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(key)::text || ':' || public.work_intake_canonical_jsonb(value),',' ORDER BY key),'') || '}'
      INTO rendered FROM pg_catalog.jsonb_each(input) AS item(key,value);
    RETURN rendered;
  END IF;
  RAISE EXCEPTION 'work intake canonical JSON rejected';
END $$;
REVOKE ALL ON FUNCTION public.work_intake_canonical_jsonb(jsonb) FROM PUBLIC;

CREATE FUNCTION guard_work_intake_audit_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE material jsonb; expected_digest text; expected_hash text;
BEGIN
  IF NOT public.is_work_intake_session() THEN
    RETURN NEW;
  END IF;
  IF NEW.id !~ '^audit:work-intake[-:]' OR NEW.actor_type<>'agent'
    OR NEW.project_id IS NULL OR NEW.chain_version<>1
    OR NEW.chain_sequence<1 OR NOT EXISTS (
      SELECT 1 FROM public.control_audit_chain_heads h
      WHERE h.tenant_id=NEW.tenant_id AND h.chain_partition=NEW.chain_partition
        AND h.event_count=NEW.chain_sequence-1 AND h.head_hash=NEW.prev_hash
    )
    OR NOT coalesce((
      (NEW.action IN ('work_batches.propose','work_batches.propose.replayed')
        AND NEW.target_type='work_batch' AND NEW.target_id LIKE 'batch:%')
      OR (NEW.action IN ('work_batches.propose.refused','work_batches.action.refused')
        AND NEW.target_type='project' AND NEW.target_id=NEW.project_id)
    ),false)
    OR NOT coalesce((
      (NEW.action='work_batches.propose' AND pg_catalog.jsonb_typeof(NEW.safe_metadata)='object'
        AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.safe_metadata))=3
        AND NEW.safe_metadata->>'proposalDigest' ~ '^sha256:[a-f0-9]{64}$'
        AND pg_catalog.jsonb_typeof(NEW.safe_metadata->'taskCount')='number'
        AND pg_catalog.jsonb_typeof(NEW.safe_metadata->'edgeCount')='number'
        AND (NEW.safe_metadata->>'taskCount')::integer BETWEEN 1 AND 32
        AND (NEW.safe_metadata->>'edgeCount')::integer BETWEEN 0 AND 64)
      OR (NEW.action='work_batches.propose.replayed' AND pg_catalog.jsonb_typeof(NEW.safe_metadata)='object'
        AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.safe_metadata))=1
        AND NEW.safe_metadata->>'proposalDigest' ~ '^sha256:[a-f0-9]{64}$')
      OR (NEW.action='work_batches.propose.refused' AND pg_catalog.jsonb_typeof(NEW.safe_metadata)='object'
        AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.safe_metadata))=1
        AND NEW.safe_metadata->>'reasonCode' ~ '^[a-z][a-z0-9_]{2,63}$')
      OR (NEW.action='work_batches.action.refused' AND pg_catalog.jsonb_typeof(NEW.safe_metadata)='object'
        AND (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(NEW.safe_metadata))=2
        AND NEW.safe_metadata->>'reasonCode' ~ '^[a-z][a-z0-9_]{2,63}$'
        AND NEW.safe_metadata->>'requestedAction' ~ '^[a-z][a-z0-9_.]{2,127}$')
    ),false)
    OR (NEW.action IN ('work_batches.propose','work_batches.propose.replayed') AND NOT EXISTS (
      SELECT 1 FROM public.work_batches b WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.target_id
        AND b.project_id=NEW.project_id AND b.proposed_by_identity_id=NEW.actor_id
    ))
    OR NOT EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.control_identities i ON i.tenant_id=p.tenant_id AND i.id=NEW.actor_id
      JOIN public.control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
      WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.project_id
        AND (NEW.workspace_id IS NULL OR NEW.workspace_id=p.workspace_id)
        AND i.actor_type='agent'
        AND g.role_key='work_batch_proposer'
        AND g.allowed_actions='["work_batches.propose"]'::jsonb
        AND g.risk_ceiling='low' AND NOT g.allow_external_effects AND NOT g.require_strong_factor
        AND (NEW.action IN ('work_batches.propose.refused','work_batches.action.refused') OR (
          i.state='active'
          AND (g.project_ids @> pg_catalog.to_jsonb(ARRAY[NEW.project_id]::text[]) OR g.project_ids @> '["*"]'::jsonb)
          AND (g.revoked_at IS NULL OR g.revoked_at>pg_catalog.statement_timestamp())
          AND (g.expires_at IS NULL OR g.expires_at>pg_catalog.statement_timestamp())
        ))
    ) THEN
    RAISE EXCEPTION 'work intake audit event insert rejected';
  END IF;
  material=pg_catalog.jsonb_build_object('id',NEW.id,'tenantId',NEW.tenant_id,'workspaceId',NEW.workspace_id,
    'projectId',NEW.project_id,'actorId',NEW.actor_id,'actorType',NEW.actor_type,'action',NEW.action,
    'targetType',NEW.target_type,'targetId',NEW.target_id,'correlationId',NEW.correlation_id,
    'idempotencyKey',NEW.idempotency_key,'safeMetadata',NEW.safe_metadata,
    'occurredAt',pg_catalog.to_char(NEW.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  expected_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.work_intake_canonical_jsonb(material),'UTF8')),'hex');
  expected_hash='sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(public.work_intake_canonical_jsonb(pg_catalog.jsonb_build_object(
    'chainVersion',1,'partition',NEW.chain_partition,'sequence',NEW.chain_sequence,
    'previousHash',NEW.prev_hash,'eventDigest',expected_digest)),'UTF8')),'hex');
  IF NEW.event_digest<>expected_digest OR NEW.event_hash<>expected_hash THEN
    RAISE EXCEPTION 'work intake audit hash rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_intake_audit_event_insert() FROM PUBLIC;
CREATE TRIGGER audit_events_work_intake_guard BEFORE INSERT ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_intake_audit_event_insert();

CREATE FUNCTION enforce_work_intake_audit_event_head() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.is_work_intake_session() AND NOT EXISTS (
    SELECT 1 FROM public.control_audit_chain_heads h
    WHERE h.tenant_id=NEW.tenant_id AND h.chain_partition=NEW.chain_partition
      AND h.event_count>=NEW.chain_sequence
  ) THEN
    RAISE EXCEPTION 'work intake audit event committed without head advance';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_work_intake_audit_event_head() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER audit_events_work_intake_head_consistency
  AFTER INSERT ON public.audit_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_work_intake_audit_event_head();

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_existing_access ON audit_events
  AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY audit_events_work_intake_scope ON audit_events
  AS RESTRICTIVE FOR ALL
  USING (NOT public.is_work_intake_session()
    OR (id ~ '^audit:work-intake[-:]' AND action IN (
      'work_batches.propose','work_batches.propose.replayed',
      'work_batches.propose.refused','work_batches.action.refused')))
  WITH CHECK (NOT public.is_work_intake_session()
    OR (id ~ '^audit:work-intake[-:]' AND action IN (
      'work_batches.propose','work_batches.propose.replayed',
      'work_batches.propose.refused','work_batches.action.refused')));

CREATE FUNCTION guard_work_intake_audit_head_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE genesis constant text := 'sha256:' || pg_catalog.repeat('0',64);
BEGIN
  IF NOT public.is_work_intake_session() THEN
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.head_hash<>genesis OR NEW.event_count<>0 THEN
      RAISE EXCEPTION 'work intake audit head insert rejected';
    END IF;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.chain_partition IS DISTINCT FROM OLD.chain_partition
    OR NEW.event_count<>OLD.event_count+1
    OR NOT EXISTS (
      SELECT 1 FROM public.audit_events e
      WHERE e.tenant_id=NEW.tenant_id AND e.chain_partition=NEW.chain_partition
        AND e.chain_sequence=NEW.event_count AND e.prev_hash=OLD.head_hash
        AND e.event_hash=NEW.head_hash AND e.id ~ '^audit:work-intake[-:]'
        AND e.action IN ('work_batches.propose','work_batches.propose.replayed',
          'work_batches.propose.refused','work_batches.action.refused')
    ) THEN
    RAISE EXCEPTION 'work intake audit head update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_work_intake_audit_head_write() FROM PUBLIC;
CREATE TRIGGER control_audit_chain_heads_work_intake_guard
  BEFORE INSERT OR UPDATE ON public.control_audit_chain_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_work_intake_audit_head_write();

CREATE FUNCTION enforce_work_intake_audit_head_nonempty() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.is_work_intake_session() AND NOT EXISTS (
    SELECT 1 FROM public.control_audit_chain_heads h JOIN public.audit_events e
      ON e.tenant_id=h.tenant_id AND e.chain_partition=h.chain_partition
      AND e.chain_sequence=h.event_count AND e.event_hash=h.head_hash
    WHERE h.tenant_id=NEW.tenant_id AND h.chain_partition=NEW.chain_partition
      AND h.event_count>=1
  ) THEN
    RAISE EXCEPTION 'work intake audit head committed without event';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_work_intake_audit_head_nonempty() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER control_audit_chain_heads_work_intake_nonempty
  AFTER INSERT ON public.control_audit_chain_heads DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_work_intake_audit_head_nonempty();

-- A down migration is intentionally operator-authored and data refusing:
-- it must first lock both tables and raise when work_batches contains any row.
-- Production recovery never silently drops these records.
