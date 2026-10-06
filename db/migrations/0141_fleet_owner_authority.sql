-- T2-F security follow-up: separate owner decisions from both the browser SQL
-- role and the fleet gateway SQL role.  The gateway records only the derived,
-- append-only redemption of an owner-issued code; it never edits the owner's
-- code, offer, review, worker-revocation, or credential-revocation records.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE fleet_enrollment_redemptions (
  tenant_id text NOT NULL,
  code_id text NOT NULL,
  worker_id text NOT NULL,
  client_nonce_digest text NOT NULL CHECK (client_nonce_digest ~ '^sha256:[a-f0-9]{64}$'),
  credential_digest text NOT NULL CHECK (credential_digest ~ '^sha256:[a-f0-9]{64}$'),
  redeemed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,code_id),
  UNIQUE (credential_digest),
  FOREIGN KEY (tenant_id,code_id) REFERENCES fleet_enrollment_codes(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,worker_id) REFERENCES fleet_workers(tenant_id,worker_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION guard_fleet_enrollment_redemption_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.redeemed_at>pg_catalog.statement_timestamp()+interval '1 minute'
    OR NOT EXISTS (SELECT 1 FROM public.fleet_enrollment_codes c
      WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.code_id AND c.worker_id=NEW.worker_id
        AND c.state='issued' AND c.expires_at>pg_catalog.statement_timestamp()
        AND NEW.redeemed_at>=c.created_at AND NEW.redeemed_at<c.expires_at) THEN
    RAISE EXCEPTION 'fleet enrollment redemption rejected';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_fleet_enrollment_redemption_insert() FROM PUBLIC;
CREATE TRIGGER fleet_enrollment_redemptions_guard BEFORE INSERT ON fleet_enrollment_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.guard_fleet_enrollment_redemption_insert();
CREATE TRIGGER fleet_enrollment_redemptions_append_only BEFORE UPDATE OR DELETE ON fleet_enrollment_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.reject_append_only_mutation();
CREATE TRIGGER fleet_enrollment_redemptions_no_truncate BEFORE TRUNCATE ON fleet_enrollment_redemptions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_append_only_mutation();

-- The gateway receives no INSERT grant on the redemption table. This narrow
-- boundary requires possession of the 256-bit code itself, hashes it inside
-- the schema-owner context, and returns only the one matching enrollment.
-- Reading a stored digest through the gateway role is therefore not enough to
-- manufacture a redemption by direct SQL.
CREATE FUNCTION redeem_fleet_enrollment(p_tenant text, p_code text, p_client_nonce_digest text,
  p_credential_digest text, p_redeemed_at timestamptz)
RETURNS TABLE(id text, purpose text, worker_id text, worker_kind text, display_name text,
  project_ids text[], capabilities text[], max_concurrent bigint, redeemed_at timestamptz, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE enrollment public.fleet_enrollment_codes%ROWTYPE;
  redemption public.fleet_enrollment_redemptions%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='control_room_fleet_gateway')
    AND (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='control_room_fleet_gateway'
      AND pg_catalog.pg_has_role(session_user,r.oid,'MEMBER'))
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles s WHERE s.rolname=session_user AND NOT s.rolsuper)) THEN
    RAISE EXCEPTION 'fleet enrollment redemption caller rejected';
  END IF;
  IF p_code !~ '^crj_[A-Za-z0-9_-]{43}$'
    OR p_client_nonce_digest !~ '^sha256:[a-f0-9]{64}$'
    OR p_credential_digest !~ '^sha256:[a-f0-9]{64}$'
    OR p_redeemed_at>pg_catalog.statement_timestamp()+interval '1 minute' THEN
    RETURN;
  END IF;
  SELECT * INTO enrollment FROM public.fleet_enrollment_codes c
    WHERE c.tenant_id=p_tenant AND c.code_digest='sha256:' || pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(p_code,'UTF8')),'hex') FOR UPDATE;
  IF NOT FOUND OR enrollment.state<>'issued' OR enrollment.expires_at<=pg_catalog.statement_timestamp()
    OR enrollment.expires_at<=p_redeemed_at THEN RETURN; END IF;
  SELECT * INTO redemption FROM public.fleet_enrollment_redemptions r
    WHERE r.tenant_id=p_tenant AND r.code_id=enrollment.id;
  IF FOUND THEN
    IF redemption.client_nonce_digest<>p_client_nonce_digest
      OR redemption.credential_digest<>p_credential_digest THEN RETURN; END IF;
    RETURN QUERY SELECT enrollment.id,enrollment.purpose,enrollment.worker_id,enrollment.worker_kind,
      enrollment.display_name,enrollment.project_ids,enrollment.capabilities,enrollment.max_concurrent,
      redemption.redeemed_at,true;
    RETURN;
  END IF;
  INSERT INTO public.fleet_enrollment_redemptions(tenant_id,code_id,worker_id,client_nonce_digest,
    credential_digest,redeemed_at) VALUES(p_tenant,enrollment.id,enrollment.worker_id,p_client_nonce_digest,
      p_credential_digest,p_redeemed_at);
  RETURN QUERY SELECT enrollment.id,enrollment.purpose,enrollment.worker_id,enrollment.worker_kind,
    enrollment.display_name,enrollment.project_ids,enrollment.capabilities,enrollment.max_concurrent,p_redeemed_at,false;
END $$;
REVOKE ALL ON FUNCTION public.redeem_fleet_enrollment(text,text,text,text,timestamptz) FROM PUBLIC;

-- Redeemed codes remain immutable owner decisions.  Cancellation/revocation
-- applies only before redemption; legacy 0140 consumed rows stay readable.
CREATE OR REPLACE FUNCTION guard_fleet_enrollment_code_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE worker public.fleet_workers%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'issued' OR NEW.consumed_at IS NOT NULL
      OR NEW.created_at>pg_catalog.statement_timestamp()+interval '1 minute'
      OR NEW.expires_at<=pg_catalog.statement_timestamp()
      OR NOT EXISTS (SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants owner_grant ON owner_grant.tenant_id=owner_identity.tenant_id
        AND owner_grant.identity_id=owner_identity.id
      WHERE owner_identity.tenant_id=NEW.tenant_id AND owner_identity.id=NEW.created_by_identity_id AND owner_identity.actor_type='human'
        AND owner_identity.state='active' AND owner_grant.role_key='owner' AND owner_grant.revoked_at IS NULL
        AND (owner_grant.expires_at IS NULL OR owner_grant.expires_at>NEW.created_at)
        AND (owner_grant.project_ids @> '["*"]'::jsonb OR owner_grant.project_ids @> pg_catalog.to_jsonb(NEW.project_ids))
        AND (owner_grant.allowed_actions @> pg_catalog.jsonb_build_array(CASE NEW.purpose WHEN 'join' THEN 'workers.enroll' ELSE 'workers.manage' END::text)
          OR owner_grant.allowed_actions @> '["*"]'::jsonb))
      OR EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW.project_ids) p WHERE NOT EXISTS (
        SELECT 1 FROM public.projects pr WHERE pr.tenant_id=NEW.tenant_id AND pr.id=p))
      OR (SELECT pg_catalog.count(DISTINCT p) FROM pg_catalog.unnest(NEW.project_ids) p)<>pg_catalog.cardinality(NEW.project_ids)
      OR (SELECT pg_catalog.count(DISTINCT c) FROM pg_catalog.unnest(NEW.capabilities) c)<>pg_catalog.cardinality(NEW.capabilities)
      OR EXISTS (SELECT 1 FROM public.fleet_enrollment_codes prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.worker_id=NEW.worker_id AND prior.state='issued'
          AND NOT EXISTS (SELECT 1 FROM public.fleet_enrollment_redemptions redemption
            WHERE redemption.tenant_id=prior.tenant_id AND redemption.code_id=prior.id)) THEN
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
      NEW.project_ids,NEW.capabilities,NEW.max_concurrent,NEW.created_by_identity_id,NEW.created_at,NEW.expires_at,NEW.consumed_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.code_digest,OLD.purpose,OLD.worker_id,OLD.worker_kind,OLD.display_name,
      OLD.project_ids,OLD.capabilities,OLD.max_concurrent,OLD.created_by_identity_id,OLD.created_at,OLD.expires_at,OLD.consumed_at)
    OR OLD.state<>'issued' OR NEW.state<>'revoked'
    OR EXISTS (SELECT 1 FROM public.fleet_enrollment_redemptions r
      WHERE r.tenant_id=OLD.tenant_id AND r.code_id=OLD.id) THEN
    RAISE EXCEPTION 'fleet enrollment code update rejected';
  END IF;
  RETURN NEW;
END $$;

-- The applier wraps migrations in one transaction, so CONCURRENTLY is not
-- available. lock_timeout above makes a busy installation fail closed; the
-- index is small and this migration runs during the reviewed upgrade drain.
-- squawk-ignore require-concurrent-index-deletion
DROP INDEX fleet_enrollment_codes_one_issued_per_worker;

CREATE OR REPLACE FUNCTION guard_fleet_worker_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.revoked_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM public.fleet_enrollment_codes c
        LEFT JOIN public.fleet_enrollment_redemptions r ON r.tenant_id=c.tenant_id AND r.code_id=c.id
        WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.enrolled_from_code_id AND c.purpose='join'
          AND c.worker_id=NEW.worker_id AND c.worker_kind=NEW.worker_kind AND c.display_name=NEW.display_name
          AND c.project_ids=NEW.project_ids AND c.capabilities=NEW.capabilities AND c.max_concurrent=NEW.max_concurrent
          AND ((c.state='consumed' AND c.consumed_at=NEW.enrolled_at)
            OR (c.state='issued' AND r.worker_id=NEW.worker_id AND r.redeemed_at=NEW.enrolled_at)))
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
  IF ROW(NEW.tenant_id,NEW.worker_id,NEW.node_id,NEW.identity_id,NEW.worker_kind,NEW.display_name,NEW.project_ids,
      NEW.capabilities,NEW.max_concurrent,NEW.enrolled_from_code_id,NEW.enrolled_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.worker_id,OLD.node_id,OLD.identity_id,OLD.worker_kind,OLD.display_name,
      OLD.project_ids,OLD.capabilities,OLD.max_concurrent,OLD.enrolled_from_code_id,OLD.enrolled_at)
    OR OLD.state<>'active' OR NEW.state<>'revoked'
    OR NOT EXISTS (SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants owner_grant ON owner_grant.tenant_id=owner_identity.tenant_id
        AND owner_grant.identity_id=owner_identity.id
      WHERE owner_identity.tenant_id=NEW.tenant_id AND owner_identity.id=NEW.revoked_by_identity_id AND owner_identity.actor_type='human'
        AND owner_identity.state='active' AND owner_grant.role_key='owner' AND owner_grant.revoked_at IS NULL
        AND (owner_grant.expires_at IS NULL OR owner_grant.expires_at>NEW.revoked_at)
        AND (owner_grant.project_ids @> '["*"]'::jsonb OR owner_grant.project_ids @> pg_catalog.to_jsonb(NEW.project_ids))
        AND (owner_grant.allowed_actions @> pg_catalog.jsonb_build_array('workers.manage'::text)
          OR owner_grant.allowed_actions @> '["*"]'::jsonb)) THEN
    RAISE EXCEPTION 'fleet worker update rejected';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_fleet_credential_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.ended_at IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM public.fleet_workers w
        WHERE w.tenant_id=NEW.tenant_id AND w.worker_id=NEW.worker_id AND w.state='active')
      OR (NEW.source_code_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.fleet_enrollment_codes c
        LEFT JOIN public.fleet_enrollment_redemptions r ON r.tenant_id=c.tenant_id AND r.code_id=c.id
        WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.source_code_id AND c.worker_id=NEW.worker_id
          AND ((c.state='consumed' AND c.consumed_at=NEW.issued_at)
            OR (c.state='issued' AND r.worker_id=NEW.worker_id AND r.redeemed_at=NEW.issued_at
              AND r.credential_digest=NEW.secret_digest))))
      OR (NEW.source_code_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.fleet_worker_credentials other
        WHERE other.tenant_id=NEW.tenant_id AND other.source_code_id=NEW.source_code_id))
      OR (NEW.rotated_from_credential_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.fleet_worker_credentials prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.credential_id=NEW.rotated_from_credential_id
          AND prior.worker_id=NEW.worker_id AND prior.state='retired' AND prior.ended_at=NEW.issued_at
          AND prior.expires_at>NEW.issued_at)) THEN
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
