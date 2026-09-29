-- T2-F: remote machines join through one outbound connector. Every machine
-- gets its own least-privilege bearer credential (only its SHA-256 digest is
-- stored); no worker ever receives a database login or an owner session.
--
-- These tables add no scheduler, queue or result store of their own. A fleet
-- claim creates the ordinary canonical attempt and lease through the shared
-- claim path, and the guards below confine the dedicated fleet gateway login
-- to fleet-offered jobs, fleet-enrolled nodes and owner-recorded decisions.
--
-- Guard trigger functions are SECURITY DEFINER so the checks they call run
-- with the schema owner's EXECUTE rights: every existing role that writes jobs,
-- attempts or leases keeps working without a new function grant. They are
-- trigger-only and cannot be called directly; session_user still identifies
-- the real login.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The gateway privilege class is bound to a marker ACL, exactly as 0093 binds
-- the work-intake class. Only the fleet gateway group holds SELECT on it.
CREATE TABLE fleet_gateway_role_anchor (
  singleton boolean PRIMARY KEY CHECK (singleton)
);
REVOKE ALL ON fleet_gateway_role_anchor FROM PUBLIC;

CREATE FUNCTION is_fleet_gateway_session() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,
      pg_catalog.acldefault('r',c.relowner))) a
    JOIN pg_catalog.pg_roles s ON s.rolname=session_user
    WHERE c.oid='public.fleet_gateway_role_anchor'::pg_catalog.regclass
      AND a.grantee<>0 AND a.grantee<>c.relowner
      AND a.privilege_type='SELECT'
      AND pg_catalog.pg_has_role(s.oid,a.grantee,'member')
      AND NOT s.rolsuper
  )
$$;

-- One owner check shared by every owner-authored fleet row. The action must be
-- granted explicitly or by wildcard, and the grant must cover every project.
CREATE FUNCTION fleet_owner_authorized(p_tenant text, p_identity text, p_projects text[],
  p_action text, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.control_identities i
    JOIN public.control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
    WHERE i.tenant_id=p_tenant AND i.id=p_identity AND i.actor_type='human' AND i.state='active'
      AND g.role_key='owner' AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>p_at)
      AND (g.project_ids @> '["*"]'::jsonb OR g.project_ids @> pg_catalog.to_jsonb(p_projects))
      AND (g.allowed_actions @> pg_catalog.jsonb_build_array(p_action) OR g.allowed_actions @> '["*"]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.fleet_owner_authorized(text,text,text[],text,timestamptz) FROM PUBLIC;

CREATE FUNCTION fleet_valid_scope(p_projects text[], p_capabilities text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.cardinality(p_projects) BETWEEN 1 AND 20
    AND pg_catalog.cardinality(p_capabilities) BETWEEN 1 AND 16
    AND pg_catalog.array_ndims(p_projects)=1 AND pg_catalog.array_ndims(p_capabilities)=1
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p_projects) p
      WHERE p IS NULL OR p !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$' OR p='*')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(p_capabilities) c
      WHERE c IS NULL OR c !~ '^[a-z][a-z0-9._-]{1,63}$')
    AND (SELECT pg_catalog.count(DISTINCT p) FROM pg_catalog.unnest(p_projects) p)=pg_catalog.cardinality(p_projects)
    AND (SELECT pg_catalog.count(DISTINCT c) FROM pg_catalog.unnest(p_capabilities) c)=pg_catalog.cardinality(p_capabilities)
$$;

-- One-time enrollment codes. The code itself is never stored; a join code
-- names the worker it will create, and a re-key code names an existing worker.
CREATE TABLE fleet_enrollment_codes (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (id ~ '^fleet-code:[a-f0-9]{32}$'),
  code_digest text NOT NULL CHECK (code_digest ~ '^sha256:[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('join','rekey')),
  worker_id text NOT NULL CHECK (worker_id ~ '^fleet-worker:[a-f0-9]{32}$'),
  worker_kind text NOT NULL CHECK (worker_kind ~ '^[a-z][a-z0-9-]{1,39}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80
    AND display_name !~ '[[:cntrl:]]'),
  project_ids text[] NOT NULL,
  capabilities text[] NOT NULL,
  max_concurrent integer NOT NULL CHECK (max_concurrent BETWEEN 1 AND 8),
  created_by_identity_id text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('issued','consumed','revoked')),
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (code_digest),
  FOREIGN KEY (tenant_id,created_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK (public.fleet_valid_scope(project_ids,capabilities)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK ((state='consumed') = (consumed_at IS NOT NULL)),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at))
);
CREATE UNIQUE INDEX fleet_enrollment_codes_one_issued_per_worker
  ON fleet_enrollment_codes(tenant_id,worker_id) WHERE state='issued';

CREATE TABLE fleet_workers (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  worker_id text NOT NULL CHECK (worker_id ~ '^fleet-worker:[a-f0-9]{32}$'),
  node_id text NOT NULL,
  identity_id text NOT NULL,
  worker_kind text NOT NULL CHECK (worker_kind ~ '^[a-z][a-z0-9-]{1,39}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80
    AND display_name !~ '[[:cntrl:]]'),
  project_ids text[] NOT NULL,
  capabilities text[] NOT NULL,
  max_concurrent integer NOT NULL CHECK (max_concurrent BETWEEN 1 AND 8),
  enrolled_from_code_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  enrolled_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_identity_id text,
  PRIMARY KEY (tenant_id,worker_id),
  UNIQUE (tenant_id,node_id),
  UNIQUE (tenant_id,identity_id),
  UNIQUE (tenant_id,enrolled_from_code_id),
  FOREIGN KEY (tenant_id,node_id) REFERENCES control_nodes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,enrolled_from_code_id) REFERENCES fleet_enrollment_codes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,revoked_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK (public.fleet_valid_scope(project_ids,capabilities)),
  CHECK ((state='revoked') = (revoked_at IS NOT NULL AND revoked_by_identity_id IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= enrolled_at)
);

CREATE TABLE fleet_worker_credentials (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  credential_id text NOT NULL CHECK (credential_id ~ '^fleet-credential:[a-f0-9]{32}$'),
  worker_id text NOT NULL,
  secret_digest text NOT NULL CHECK (secret_digest ~ '^sha256:[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('active','retired','revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  source_code_id text,
  rotated_from_credential_id text,
  PRIMARY KEY (tenant_id,credential_id),
  UNIQUE (secret_digest),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_code_id) REFERENCES fleet_enrollment_codes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,rotated_from_credential_id)
    REFERENCES fleet_worker_credentials(tenant_id,credential_id) ON DELETE RESTRICT,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 days'),
  CHECK ((state='active') = (ended_at IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= issued_at),
  CHECK ((source_code_id IS NULL) <> (rotated_from_credential_id IS NULL))
);
CREATE UNIQUE INDEX fleet_worker_credentials_one_active
  ON fleet_worker_credentials(tenant_id,worker_id) WHERE state='active';
CREATE UNIQUE INDEX fleet_worker_credentials_one_successor
  ON fleet_worker_credentials(tenant_id,rotated_from_credential_id) WHERE rotated_from_credential_id IS NOT NULL;

-- Liveness only. Presence is never authority: it cannot admit, claim or keep
-- a lease; it only lets the owner see when a machine last checked in.
CREATE TABLE fleet_worker_presence (
  tenant_id text NOT NULL,
  worker_id text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  connector_version text NOT NULL CHECK (connector_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$'),
  platform text NOT NULL CHECK (platform IN ('macos','linux','windows','other')),
  PRIMARY KEY (tenant_id,worker_id),
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) ON DELETE RESTRICT
);

-- The owner opens one canonical task to fleet claiming. The offer is the
-- owner's execution consent; it names the capability a worker must hold and,
-- optionally, the only workers that may claim it.
CREATE TABLE fleet_work_offers (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  offer_id text NOT NULL CHECK (offer_id ~ '^fleet-offer:[a-f0-9]{32}$'),
  project_id text NOT NULL,
  job_id text NOT NULL,
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9._-]{1,63}$'),
  allowed_worker_ids text[],
  offered_by_identity_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','closed')),
  close_reason text CHECK (close_reason IN ('withdrawn','accepted','rejected')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (tenant_id,offer_id),
  FOREIGN KEY (tenant_id,job_id) REFERENCES control_jobs(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,offered_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((state='closed') = (closed_at IS NOT NULL AND close_reason IS NOT NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at),
  CHECK (allowed_worker_ids IS NULL OR (pg_catalog.cardinality(allowed_worker_ids) BETWEEN 1 AND 20
    AND pg_catalog.array_ndims(allowed_worker_ids)=1))
);
CREATE UNIQUE INDEX fleet_work_offers_one_per_job ON fleet_work_offers(tenant_id,job_id);
CREATE INDEX fleet_work_offers_open ON fleet_work_offers(tenant_id,project_id) WHERE state='open';

CREATE TABLE fleet_claims (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  claim_id text NOT NULL CHECK (claim_id ~ '^fleet-claim:[a-f0-9]{32}$'),
  offer_id text NOT NULL,
  worker_id text NOT NULL,
  node_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  lease_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  claimed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,claim_id),
  UNIQUE (tenant_id,attempt_id),
  UNIQUE (tenant_id,lease_id),
  UNIQUE (tenant_id,worker_id,idempotency_key),
  FOREIGN KEY (tenant_id,offer_id) REFERENCES fleet_work_offers(tenant_id,offer_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) ON DELETE RESTRICT
);
CREATE INDEX fleet_claims_job ON fleet_claims(tenant_id,job_id,claimed_at DESC);

CREATE TABLE fleet_worker_events (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_id text NOT NULL CHECK (event_id ~ '^fleet-event:[a-f0-9]{32}$'),
  claim_id text NOT NULL,
  worker_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('progress','blocker')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,event_id),
  UNIQUE (tenant_id,worker_id,idempotency_key),
  FOREIGN KEY (tenant_id,claim_id) REFERENCES fleet_claims(tenant_id,claim_id) ON DELETE RESTRICT
);
CREATE INDEX fleet_worker_events_claim ON fleet_worker_events(tenant_id,claim_id,occurred_at);

-- Bounded result material under the originating claim. The limits are part of
-- the schema, so no caller can store an oversized answer or file.
CREATE TABLE fleet_results (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  result_id text NOT NULL CHECK (result_id ~ '^fleet-result:[a-f0-9]{32}$'),
  claim_id text NOT NULL,
  worker_id text NOT NULL,
  project_id text NOT NULL,
  job_id text NOT NULL,
  attempt_id text NOT NULL,
  summary text NOT NULL CHECK (octet_length(summary) BETWEEN 1 AND 65536),
  file_count integer NOT NULL CHECK (file_count BETWEEN 0 AND 8),
  total_file_bytes integer NOT NULL CHECK (total_file_bytes BETWEEN 0 AND 1048576),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{11,179}$'),
  submitted_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,result_id),
  UNIQUE (tenant_id,claim_id),
  UNIQUE (tenant_id,attempt_id),
  UNIQUE (tenant_id,worker_id,idempotency_key),
  FOREIGN KEY (tenant_id,claim_id) REFERENCES fleet_claims(tenant_id,claim_id) ON DELETE RESTRICT
);
CREATE INDEX fleet_results_job ON fleet_results(tenant_id,job_id,submitted_at DESC);

CREATE TABLE fleet_result_files (
  tenant_id text NOT NULL,
  result_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  file_name text NOT NULL CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$' AND file_name !~ '\.\.'),
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown','text/csv','application/json',
    'image/png','image/jpeg','application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 262144),
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  content bytea NOT NULL,
  PRIMARY KEY (tenant_id,result_id,ordinal),
  UNIQUE (tenant_id,result_id,file_name),
  FOREIGN KEY (tenant_id,result_id) REFERENCES fleet_results(tenant_id,result_id) ON DELETE RESTRICT,
  CHECK (octet_length(content)=size_bytes),
  CHECK (content_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(content),'hex'))
);

CREATE TABLE fleet_result_reviews (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  review_id text NOT NULL CHECK (review_id ~ '^fleet-review:[a-f0-9]{32}$'),
  result_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('accepted','revision_requested','rejected')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 2000),
  reviewed_by_identity_id text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,review_id),
  UNIQUE (tenant_id,result_id),
  FOREIGN KEY (tenant_id,result_id) REFERENCES fleet_results(tenant_id,result_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewed_by_identity_id) REFERENCES control_identities(tenant_id,id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Guards on the fleet tables. They apply to every role, not only the gateway.
-- ---------------------------------------------------------------------------

CREATE FUNCTION guard_fleet_enrollment_code_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE worker public.fleet_workers%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'issued' OR NEW.consumed_at IS NOT NULL
      OR NEW.created_at>pg_catalog.statement_timestamp()+interval '1 minute'
      OR NEW.expires_at<=pg_catalog.statement_timestamp()
      OR NOT public.fleet_owner_authorized(NEW.tenant_id,NEW.created_by_identity_id,NEW.project_ids,
        CASE NEW.purpose WHEN 'join' THEN 'workers.enroll' ELSE 'workers.manage' END,NEW.created_at)
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.project_ids) p WHERE NOT EXISTS (
        SELECT 1 FROM public.projects pr WHERE pr.tenant_id=NEW.tenant_id AND pr.id=p)) THEN
      RAISE EXCEPTION 'fleet enrollment code rejected';
    END IF;
    SELECT * INTO worker FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id;
    IF (NEW.purpose='join' AND FOUND) OR (NEW.purpose='rekey' AND (NOT FOUND OR worker.state<>'active'
      OR worker.worker_kind<>NEW.worker_kind OR worker.display_name<>NEW.display_name
      OR worker.project_ids<>NEW.project_ids OR worker.capabilities<>NEW.capabilities
      OR worker.max_concurrent<>NEW.max_concurrent)) THEN
      RAISE EXCEPTION 'fleet enrollment code rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.tenant_id,NEW.id,NEW.code_digest,NEW.purpose,NEW.worker_id,NEW.worker_kind,NEW.display_name,
      NEW.project_ids,NEW.capabilities,NEW.max_concurrent,NEW.created_by_identity_id,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.code_digest,OLD.purpose,OLD.worker_id,OLD.worker_kind,OLD.display_name,
      OLD.project_ids,OLD.capabilities,OLD.max_concurrent,OLD.created_by_identity_id,OLD.created_at,OLD.expires_at)
    OR OLD.state<>'issued' OR NEW.state NOT IN ('consumed','revoked') THEN
    RAISE EXCEPTION 'fleet enrollment code update rejected';
  END IF;
  -- Expiry is enforced by the database clock, never only by a caller's clock.
  IF NEW.state='consumed' AND (pg_catalog.statement_timestamp()>=OLD.expires_at
    OR NEW.consumed_at>=OLD.expires_at) THEN
    RAISE EXCEPTION 'fleet enrollment code consumption rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_enrollment_code_write() FROM PUBLIC;
CREATE TRIGGER fleet_enrollment_codes_guard BEFORE INSERT OR UPDATE ON fleet_enrollment_codes
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_enrollment_code_write();

CREATE FUNCTION guard_fleet_worker_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.revoked_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM public.fleet_enrollment_codes c
        WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.enrolled_from_code_id AND c.purpose='join'
          AND c.state='consumed' AND c.consumed_at=NEW.enrolled_at AND c.worker_id=NEW.worker_id
          AND c.worker_kind=NEW.worker_kind AND c.display_name=NEW.display_name
          AND c.project_ids=NEW.project_ids AND c.capabilities=NEW.capabilities
          AND c.max_concurrent=NEW.max_concurrent)
      OR NOT EXISTS (SELECT 1 FROM public.control_nodes n
        WHERE n.tenant_id=NEW.tenant_id AND n.id=NEW.node_id AND n.state='active')
      OR NOT EXISTS (SELECT 1 FROM public.control_identities i
        WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.identity_id AND i.actor_type='agent'
          AND i.auth_provider='work-intake' AND i.state='active'
          AND i.auth_subject_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to('fleet-worker/v1:' || NEW.worker_id,'UTF8')),'hex')) THEN
      RAISE EXCEPTION 'fleet worker enrollment rejected';
    END IF;
    RETURN NEW;
  END IF;
  -- Only the owner can revoke a worker, and revocation is terminal. Scope is
  -- immutable: a wider scope needs a new enrollment the owner creates.
  IF ROW(NEW.tenant_id,NEW.worker_id,NEW.node_id,NEW.identity_id,NEW.worker_kind,NEW.display_name,NEW.project_ids,
      NEW.capabilities,NEW.max_concurrent,NEW.enrolled_from_code_id,NEW.enrolled_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.worker_id,OLD.node_id,OLD.identity_id,OLD.worker_kind,OLD.display_name,
      OLD.project_ids,OLD.capabilities,OLD.max_concurrent,OLD.enrolled_from_code_id,OLD.enrolled_at)
    OR OLD.state<>'active' OR NEW.state<>'revoked'
    OR NOT public.fleet_owner_authorized(NEW.tenant_id,NEW.revoked_by_identity_id,NEW.project_ids,
      'workers.manage',NEW.revoked_at) THEN
    RAISE EXCEPTION 'fleet worker update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_worker_write() FROM PUBLIC;
CREATE TRIGGER fleet_workers_guard BEFORE INSERT OR UPDATE ON fleet_workers
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_worker_write();

CREATE FUNCTION guard_fleet_credential_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.ended_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM public.fleet_workers w
        WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
      OR (NEW.source_code_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_enrollment_codes c
        WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.source_code_id AND c.worker_id=NEW.worker_id
          AND c.state='consumed' AND c.consumed_at=NEW.issued_at))
      OR (NEW.source_code_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.fleet_worker_credentials other
        WHERE other.tenant_id=NEW.tenant_id AND other.source_code_id=NEW.source_code_id))
      OR (NEW.rotated_from_credential_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_worker_credentials old
        WHERE old.tenant_id=NEW.tenant_id AND old.credential_id=NEW.rotated_from_credential_id
          AND old.worker_id=NEW.worker_id AND old.state='retired' AND old.ended_at=NEW.issued_at
          AND old.expires_at>NEW.issued_at)) THEN
      RAISE EXCEPTION 'fleet credential issue rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.tenant_id,NEW.credential_id,NEW.worker_id,NEW.secret_digest,NEW.issued_at,NEW.expires_at,
      NEW.source_code_id,NEW.rotated_from_credential_id)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.credential_id,OLD.worker_id,OLD.secret_digest,OLD.issued_at,OLD.expires_at,
      OLD.source_code_id,OLD.rotated_from_credential_id)
    OR OLD.state<>'active' OR NEW.state NOT IN ('retired','revoked') THEN
    RAISE EXCEPTION 'fleet credential update rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_credential_write() FROM PUBLIC;
CREATE TRIGGER fleet_worker_credentials_guard BEFORE INSERT OR UPDATE ON fleet_worker_credentials
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_credential_write();

CREATE FUNCTION guard_fleet_presence_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.fleet_workers w
      WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
    OR NEW.last_seen_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.worker_id<>OLD.worker_id)) THEN
    RAISE EXCEPTION 'fleet presence rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_presence_write() FROM PUBLIC;
CREATE TRIGGER fleet_worker_presence_guard BEFORE INSERT OR UPDATE ON fleet_worker_presence
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_presence_write();

CREATE FUNCTION guard_fleet_offer_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'open' OR NEW.closed_at IS NOT NULL
      OR NOT public.fleet_owner_authorized(NEW.tenant_id,NEW.offered_by_identity_id,ARRAY[NEW.project_id],
        'tasks.assign',NEW.created_at)
      OR NOT EXISTS (SELECT 1 FROM public.control_jobs j WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.job_id
        AND j.project_id=NEW.project_id AND j.state IN ('proposed','ready')
        AND NOT EXISTS (SELECT 1 FROM public.control_leases l WHERE l.tenant_id=j.tenant_id AND l.job_id=j.id)) THEN
      RAISE EXCEPTION 'fleet work offer rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.tenant_id,NEW.offer_id,NEW.project_id,NEW.job_id,NEW.capability,NEW.allowed_worker_ids,
      NEW.offered_by_identity_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.offer_id,OLD.project_id,OLD.job_id,OLD.capability,OLD.allowed_worker_ids,
      OLD.offered_by_identity_id,OLD.created_at)
    OR OLD.state<>'open' OR NEW.state<>'closed' THEN
    RAISE EXCEPTION 'fleet work offer update rejected';
  END IF;
  -- Closing as accepted/rejected must follow the matching owner review of the
  -- latest result; withdrawal is an owner decision on the web path.
  IF NEW.close_reason IN ('accepted','rejected') AND NOT EXISTS (
      SELECT 1 FROM public.fleet_result_reviews rv JOIN public.fleet_results r
        ON r.tenant_id=rv.tenant_id AND r.result_id=rv.result_id
      WHERE r.tenant_id=NEW.tenant_id AND r.job_id=NEW.job_id AND rv.decision=NEW.close_reason
        AND NOT EXISTS (SELECT 1 FROM public.fleet_results newer WHERE newer.tenant_id=r.tenant_id
          AND newer.job_id=r.job_id AND newer.submitted_at>r.submitted_at)) THEN
    RAISE EXCEPTION 'fleet work offer close rejected';
  END IF;
  IF NEW.close_reason='withdrawn' AND public.is_fleet_gateway_session() THEN
    RAISE EXCEPTION 'fleet work offer close rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_offer_write() FROM PUBLIC;
CREATE TRIGGER fleet_work_offers_guard BEFORE INSERT OR UPDATE ON fleet_work_offers
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_offer_write();

-- A claim is admissible only for an active worker holding a live credential,
-- inside its project scope, with the offered capability, within capacity, and
-- only while no other attempt of the job holds a live lease.
CREATE FUNCTION guard_fleet_claim_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE worker public.fleet_workers%ROWTYPE; offer public.fleet_work_offers%ROWTYPE;
BEGIN
  SELECT * INTO worker FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id;
  SELECT * INTO offer FROM public.fleet_work_offers o WHERE o.tenant_id=NEW.tenant_id AND o.offer_id=NEW.offer_id;
  IF worker.worker_id IS NULL OR offer.offer_id IS NULL OR worker.state<>'active' OR offer.state<>'open'
    OR worker.node_id<>NEW.node_id OR offer.job_id<>NEW.job_id OR offer.project_id<>NEW.project_id
    OR NOT NEW.project_id=ANY(worker.project_ids) OR NOT offer.capability=ANY(worker.capabilities)
    OR (offer.allowed_worker_ids IS NOT NULL AND NOT NEW.worker_id=ANY(offer.allowed_worker_ids))
    OR NEW.claimed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NOT EXISTS (SELECT 1 FROM public.fleet_worker_credentials c WHERE c.tenant_id=NEW.tenant_id
      AND c.worker_id=NEW.worker_id AND c.state='active' AND c.expires_at>pg_catalog.statement_timestamp())
    OR EXISTS (SELECT 1 FROM public.control_leases l WHERE l.tenant_id=NEW.tenant_id AND l.job_id=NEW.job_id
      AND l.state='active')
    OR (SELECT pg_catalog.count(*) FROM public.fleet_claims fc JOIN public.control_leases l
        ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
      WHERE fc.tenant_id=NEW.tenant_id AND fc.worker_id=NEW.worker_id AND l.state='active')>=worker.max_concurrent THEN
    RAISE EXCEPTION 'fleet claim rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_claim_insert() FROM PUBLIC;
CREATE TRIGGER fleet_claims_guard BEFORE INSERT ON fleet_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_claim_insert();

-- The claim row must be backed by the exact canonical attempt and active lease
-- by commit, so a claim cannot exist without the shared lease path.
CREATE FUNCTION enforce_fleet_claim_lease() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.control_leases l JOIN public.control_attempts a
      ON a.tenant_id=l.tenant_id AND a.id=l.attempt_id
    WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.lease_id AND l.attempt_id=NEW.attempt_id
      AND l.job_id=NEW.job_id AND l.node_id=NEW.node_id AND a.worker_id=NEW.worker_id AND a.node_id=NEW.node_id) THEN
    RAISE EXCEPTION 'fleet claim committed without its canonical lease';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_fleet_claim_lease() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER fleet_claims_lease_consistency AFTER INSERT ON fleet_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_claim_lease();

-- Worker events and results require the claim's lease to be live by the
-- database clock. A revoked worker or an elapsed lease cannot report.
CREATE FUNCTION fleet_claim_is_live(p_tenant text, p_claim text, p_worker text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.fleet_claims fc
    JOIN public.fleet_workers w ON w.tenant_id=fc.tenant_id AND w.worker_id=fc.worker_id
    JOIN public.control_leases l ON l.tenant_id=fc.tenant_id AND l.id=fc.lease_id
    WHERE fc.tenant_id=p_tenant AND fc.claim_id=p_claim AND fc.worker_id=p_worker AND w.state='active'
      AND l.state='active' AND l.expires_at>pg_catalog.statement_timestamp()
      AND EXISTS (SELECT 1 FROM public.fleet_worker_credentials c WHERE c.tenant_id=w.tenant_id
        AND c.worker_id=w.worker_id AND c.state='active' AND c.expires_at>pg_catalog.statement_timestamp()))
$$;
REVOKE ALL ON FUNCTION public.fleet_claim_is_live(text,text,text) FROM PUBLIC;

CREATE FUNCTION guard_fleet_worker_event_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.fleet_claim_is_live(NEW.tenant_id,NEW.claim_id,NEW.worker_id)
    OR NEW.occurred_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
    RAISE EXCEPTION 'fleet worker event rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_worker_event_insert() FROM PUBLIC;
CREATE TRIGGER fleet_worker_events_guard BEFORE INSERT ON fleet_worker_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_worker_event_insert();

CREATE FUNCTION guard_fleet_result_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.fleet_claim_is_live(NEW.tenant_id,NEW.claim_id,NEW.worker_id)
    OR NEW.submitted_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NOT EXISTS (SELECT 1 FROM public.fleet_claims fc WHERE fc.tenant_id=NEW.tenant_id
      AND fc.claim_id=NEW.claim_id AND fc.worker_id=NEW.worker_id AND fc.project_id=NEW.project_id
      AND fc.job_id=NEW.job_id AND fc.attempt_id=NEW.attempt_id) THEN
    RAISE EXCEPTION 'fleet result rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_result_insert() FROM PUBLIC;
CREATE TRIGGER fleet_results_guard BEFORE INSERT ON fleet_results
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_result_insert();

CREATE FUNCTION guard_fleet_result_file_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.fleet_results%ROWTYPE;
BEGIN
  SELECT * INTO result FROM public.fleet_results r WHERE r.tenant_id=NEW.tenant_id AND r.result_id=NEW.result_id;
  IF result.result_id IS NULL OR NEW.ordinal>result.file_count
    OR NOT public.fleet_claim_is_live(result.tenant_id,result.claim_id,result.worker_id)
    OR (SELECT coalesce(pg_catalog.sum(f.size_bytes),0) FROM public.fleet_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.result_id=NEW.result_id)+NEW.size_bytes>result.total_file_bytes THEN
    RAISE EXCEPTION 'fleet result file rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_result_file_insert() FROM PUBLIC;
CREATE TRIGGER fleet_result_files_guard BEFORE INSERT ON fleet_result_files
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_result_file_insert();

-- A result commits only with exactly its declared files and bytes.
CREATE FUNCTION enforce_fleet_result_files_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.fleet_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.result_id=NEW.result_id)<>NEW.file_count
    OR (SELECT coalesce(pg_catalog.sum(f.size_bytes),0) FROM public.fleet_result_files f
      WHERE f.tenant_id=NEW.tenant_id AND f.result_id=NEW.result_id)<>NEW.total_file_bytes THEN
    RAISE EXCEPTION 'fleet result committed without its declared files';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_fleet_result_files_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER fleet_results_files_complete AFTER INSERT ON fleet_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_result_files_complete();

CREATE FUNCTION guard_fleet_result_review_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE result public.fleet_results%ROWTYPE;
BEGIN
  SELECT * INTO result FROM public.fleet_results r WHERE r.tenant_id=NEW.tenant_id AND r.result_id=NEW.result_id;
  IF result.result_id IS NULL
    OR NEW.reviewed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NOT public.fleet_owner_authorized(NEW.tenant_id,NEW.reviewed_by_identity_id,ARRAY[result.project_id],
      'tasks.reviews.record',NEW.reviewed_at)
    OR EXISTS (SELECT 1 FROM public.fleet_results newer WHERE newer.tenant_id=result.tenant_id
      AND newer.job_id=result.job_id AND newer.submitted_at>result.submitted_at)
    OR NOT EXISTS (SELECT 1 FROM public.fleet_work_offers o WHERE o.tenant_id=result.tenant_id
      AND o.job_id=result.job_id AND o.state='open') THEN
    RAISE EXCEPTION 'fleet result review rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_result_review_insert() FROM PUBLIC;
CREATE TRIGGER fleet_result_reviews_guard BEFORE INSERT ON fleet_result_reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_result_review_insert();

-- History is append-only; only the guarded state columns above may change.
CREATE TRIGGER fleet_enrollment_codes_no_delete BEFORE DELETE ON fleet_enrollment_codes
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_workers_no_delete BEFORE DELETE ON fleet_workers
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_credentials_no_delete BEFORE DELETE ON fleet_worker_credentials
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_presence_no_delete BEFORE DELETE ON fleet_worker_presence
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_work_offers_no_delete BEFORE DELETE ON fleet_work_offers
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_claims_append_only BEFORE UPDATE OR DELETE ON fleet_claims
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_events_append_only BEFORE UPDATE OR DELETE ON fleet_worker_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_results_append_only BEFORE UPDATE OR DELETE ON fleet_results
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_result_files_append_only BEFORE UPDATE OR DELETE ON fleet_result_files
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_result_reviews_append_only BEFORE UPDATE OR DELETE ON fleet_result_reviews
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_enrollment_codes_no_truncate BEFORE TRUNCATE ON fleet_enrollment_codes
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_workers_no_truncate BEFORE TRUNCATE ON fleet_workers
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_credentials_no_truncate BEFORE TRUNCATE ON fleet_worker_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_presence_no_truncate BEFORE TRUNCATE ON fleet_worker_presence
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_work_offers_no_truncate BEFORE TRUNCATE ON fleet_work_offers
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_claims_no_truncate BEFORE TRUNCATE ON fleet_claims
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_worker_events_no_truncate BEFORE TRUNCATE ON fleet_worker_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_results_no_truncate BEFORE TRUNCATE ON fleet_results
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_result_files_no_truncate BEFORE TRUNCATE ON fleet_result_files
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_result_reviews_no_truncate BEFORE TRUNCATE ON fleet_result_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Gateway confinement on shared canonical tables. These triggers do nothing
-- for any other role; for the fleet gateway login they refuse every write that
-- is not tied to a fleet enrollment, a fleet claim, or an owner decision.
-- ---------------------------------------------------------------------------

CREATE FUNCTION guard_fleet_gateway_identity_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.actor_type<>'agent' OR NEW.auth_provider<>'work-intake' OR NEW.state<>'active'
      OR NEW.id !~ '^identity:fleet:[a-f0-9]{32}$' THEN
      RAISE EXCEPTION 'fleet gateway identity write rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.actor_type,NEW.display_name,NEW.auth_provider,NEW.auth_subject_digest,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.actor_type,OLD.display_name,OLD.auth_provider,OLD.auth_subject_digest,OLD.created_at)
    OR (NEW.state IS DISTINCT FROM OLD.state AND (NEW.state<>'revoked' OR NOT EXISTS (
      SELECT 1 FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.identity_id=NEW.id
        AND w.state='revoked'))) THEN
    RAISE EXCEPTION 'fleet gateway identity write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_identity_write() FROM PUBLIC;
CREATE TRIGGER control_identities_fleet_gateway_guard BEFORE INSERT OR UPDATE ON control_identities
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_identity_write();

CREATE FUNCTION guard_fleet_gateway_grant_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE worker public.fleet_workers%ROWTYPE;
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  SELECT * INTO worker FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.identity_id=NEW.identity_id;
  IF TG_OP='INSERT' THEN
    -- The only grant a fleet worker ever holds: proposal-only intake in its
    -- own projects. It can never assign, approve, dispatch or review.
    IF worker.worker_id IS NULL OR worker.state<>'active' OR NEW.role_key<>'work_batch_proposer'
      OR NEW.allowed_actions<>'["work_batches.propose"]'::jsonb
      OR NEW.project_ids<>pg_catalog.to_jsonb(worker.project_ids)
      OR NEW.risk_ceiling<>'low' OR NEW.allow_external_effects OR NEW.require_strong_factor
      OR NEW.expires_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
      OR NEW.id<>'grant:fleet:' || pg_catalog.substr(worker.worker_id,14) THEN
      RAISE EXCEPTION 'fleet gateway grant write rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.tenant_id,NEW.identity_id,NEW.role_key,NEW.allowed_actions,NEW.project_ids,NEW.risk_ceiling,
      NEW.allow_external_effects,NEW.require_strong_factor,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.identity_id,OLD.role_key,OLD.allowed_actions,OLD.project_ids,
      OLD.risk_ceiling,OLD.allow_external_effects,OLD.require_strong_factor,OLD.expires_at,OLD.created_at)
    OR (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at AND (OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
      OR worker.worker_id IS NULL OR worker.state<>'revoked')) THEN
    RAISE EXCEPTION 'fleet gateway grant write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_grant_write() FROM PUBLIC;
CREATE TRIGGER control_role_grants_fleet_gateway_guard BEFORE INSERT OR UPDATE ON control_role_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_grant_write();

CREATE FUNCTION guard_fleet_gateway_node_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.id !~ '^node:fleet:[a-f0-9]{32}$' THEN
      RAISE EXCEPTION 'fleet gateway node write rejected';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fleet_workers w WHERE w.tenant_id=NEW.tenant_id AND w.node_id=NEW.id
      AND w.state='revoked') OR NEW.state<>'revoked' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id
    OR NEW.identity_key_id<>OLD.identity_key_id THEN
    RAISE EXCEPTION 'fleet gateway node write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_node_write() FROM PUBLIC;
CREATE TRIGGER control_nodes_fleet_gateway_guard BEFORE INSERT OR UPDATE ON control_nodes
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_node_write();

-- Nodes and identities the gateway creates must belong to a fleet worker row
-- written in the same transaction.
CREATE FUNCTION enforce_fleet_gateway_enrollment_bound() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NULL; END IF;
  IF (TG_TABLE_NAME='control_nodes' AND NOT EXISTS (SELECT 1 FROM public.fleet_workers w
        WHERE w.tenant_id=NEW.tenant_id AND w.node_id=NEW.id))
    OR (TG_TABLE_NAME='control_identities' AND NOT EXISTS (SELECT 1 FROM public.fleet_workers w
        WHERE w.tenant_id=NEW.tenant_id AND w.identity_id=NEW.id)) THEN
    RAISE EXCEPTION 'fleet gateway enrollment committed without its worker';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.enforce_fleet_gateway_enrollment_bound() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER control_nodes_fleet_gateway_bound AFTER INSERT ON control_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_gateway_enrollment_bound();
CREATE CONSTRAINT TRIGGER control_identities_fleet_gateway_bound AFTER INSERT ON control_identities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_fleet_gateway_enrollment_bound();

-- The gateway may only create attempts and leases that a guarded fleet claim
-- already names, and may only move fleet-claimed attempts and leases.
CREATE FUNCTION guard_fleet_gateway_attempt_lease_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='control_attempts' THEN
    IF NOT EXISTS (SELECT 1 FROM public.fleet_claims fc WHERE fc.tenant_id=NEW.tenant_id AND fc.attempt_id=NEW.id
        AND fc.job_id=NEW.job_id AND fc.node_id=NEW.node_id AND fc.worker_id=NEW.worker_id) THEN
      RAISE EXCEPTION 'fleet gateway attempt write rejected';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.fleet_claims fc WHERE fc.tenant_id=NEW.tenant_id AND fc.lease_id=NEW.id
      AND fc.job_id=NEW.job_id AND fc.attempt_id=NEW.attempt_id AND fc.node_id=NEW.node_id) THEN
    RAISE EXCEPTION 'fleet gateway lease write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_attempt_lease_write() FROM PUBLIC;
CREATE TRIGGER control_attempts_fleet_gateway_guard BEFORE INSERT OR UPDATE ON control_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_attempt_lease_write();
CREATE TRIGGER control_leases_fleet_gateway_guard BEFORE INSERT OR UPDATE ON control_leases
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_attempt_lease_write();

-- Job state moves by the gateway are bound to the owner's offer and review:
-- it cannot finish, fail or cancel work the owner did not decide.
CREATE FUNCTION guard_fleet_gateway_job_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE offer public.fleet_work_offers%ROWTYPE; decision text;
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  SELECT * INTO offer FROM public.fleet_work_offers o WHERE o.tenant_id=NEW.tenant_id AND o.job_id=NEW.id;
  SELECT rv.decision INTO decision FROM public.fleet_results r JOIN public.fleet_result_reviews rv
    ON rv.tenant_id=r.tenant_id AND rv.result_id=r.result_id
    WHERE r.tenant_id=NEW.tenant_id AND r.job_id=NEW.id ORDER BY r.submitted_at DESC LIMIT 1;
  IF offer.offer_id IS NULL OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.project_id<>OLD.project_id
    OR NEW.workflow_id<>OLD.workflow_id OR NEW.authority_digest<>OLD.authority_digest
    OR NEW.required_capability<>OLD.required_capability OR NEW.priority<>OLD.priority
    OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (NEW.state IN ('ready','leased') AND offer.state='open')
      OR (NEW.state IN ('running','waiting_approval') AND offer.state='open' AND EXISTS (
        SELECT 1 FROM public.fleet_claims fc WHERE fc.tenant_id=NEW.tenant_id AND fc.job_id=NEW.id))
      OR (NEW.state='orphaned')
      OR (NEW.state='succeeded' AND decision='accepted')
      OR (NEW.state='failed' AND decision='revision_requested')
      OR (NEW.state='cancelled' AND decision='rejected'))) THEN
    RAISE EXCEPTION 'fleet gateway job write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_job_write() FROM PUBLIC;
CREATE TRIGGER control_jobs_fleet_gateway_guard BEFORE UPDATE ON control_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_job_write();

-- First-claim request/workflow activation and final fulfilment: only for the
-- workflow of a fleet-offered job.
CREATE FUNCTION guard_fleet_gateway_workflow_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.is_fleet_gateway_session() THEN RETURN NEW; END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NOT EXISTS (
      SELECT 1 FROM public.fleet_work_offers o JOIN public.control_jobs j ON j.tenant_id=o.tenant_id AND j.id=o.job_id
      JOIN public.control_workflows wf ON wf.tenant_id=j.tenant_id AND wf.id=j.workflow_id
      WHERE o.tenant_id=NEW.tenant_id AND ((TG_TABLE_NAME='control_workflows' AND wf.id=NEW.id)
        OR (TG_TABLE_NAME='control_requests' AND wf.request_id=NEW.id))) THEN
    RAISE EXCEPTION 'fleet gateway workflow write rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_gateway_workflow_write() FROM PUBLIC;
CREATE TRIGGER control_workflows_fleet_gateway_guard BEFORE UPDATE ON control_workflows
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_workflow_write();
CREATE TRIGGER control_requests_fleet_gateway_guard BEFORE UPDATE ON control_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_gateway_workflow_write();

CREATE INDEX fleet_workers_node ON fleet_workers(tenant_id,node_id);
CREATE INDEX fleet_claims_worker ON fleet_claims(tenant_id,worker_id,claimed_at DESC);
