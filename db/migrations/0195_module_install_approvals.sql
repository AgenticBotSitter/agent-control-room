-- Module Contract v1: the owner's durable installation approval for one exact
-- module bundle. A row records what the owner saw and approved (bundle digest,
-- parsed manifest, authority surface digest, trust source, permission diff);
-- it installs, stages, executes, and migrates nothing.
--
-- Approvals for one module form a single append-only chain: each new approval
-- names the approval it supersedes, at most one row may supersede any row, and
-- only one row may start the chain. The current approval is the chain's head.
-- Two concurrent approvals of the same head therefore cannot both land, and an
-- old approval can never become current again without a new owner approval.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE TABLE control_module_install_approvals (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id text NOT NULL CHECK (id ~ '^module-approval:[0-9a-f-]{36}$'),
  module_id text NOT NULL CHECK (module_id ~ '^[a-z][A-Za-z0-9.-]{2,63}$'),
  module_version text NOT NULL CHECK (length(module_version) <= 128
    AND module_version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$'),
  module_class text NOT NULL CHECK (module_class IN ('declarative','code')),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^sha256:[a-f0-9]{64}$'),
  permissions_digest text NOT NULL CHECK (permissions_digest ~ '^sha256:[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 262144),
  source_kind text NOT NULL CHECK (source_kind IN ('declarative-unsigned','reviewed','signed')),
  signer_key_id text CHECK (signer_key_id IS NULL OR signer_key_id ~ '^sha256:[a-f0-9]{64}$'),
  code_warning_acknowledged boolean NOT NULL,
  supersedes_approval_id text,
  permission_diff jsonb NOT NULL CHECK (jsonb_typeof(permission_diff) = 'object'
    AND octet_length(permission_diff::text) <= 262144),
  permission_diff_digest text NOT NULL CHECK (permission_diff_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_identity_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  record_digest text NOT NULL CHECK (record_digest ~ '^sha256:[a-f0-9]{64}$'),
  auth_tag text NOT NULL CHECK (auth_tag ~ '^hmac-sha256:[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, module_id, id),
  UNIQUE (tenant_id, owner_identity_id, idempotency_key),
  -- At most one successor per approval: a superseded approval stays superseded.
  UNIQUE (tenant_id, module_id, supersedes_approval_id),
  FOREIGN KEY (tenant_id, module_id, supersedes_approval_id)
    REFERENCES control_module_install_approvals(tenant_id, module_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, owner_identity_id) REFERENCES control_identities(tenant_id, id) ON DELETE RESTRICT,
  -- Owner rule: DECLARATIVE modules may come from anyone; CODE modules only
  -- from a reviewed digest or an owner-trusted signature, with the warning seen.
  CHECK ((source_kind = 'signed') = (signer_key_id IS NOT NULL)),
  CHECK (module_class <> 'code' OR source_kind IN ('reviewed','signed')),
  CHECK (module_class <> 'code' OR code_warning_acknowledged),
  CHECK (manifest->>'id' = module_id AND manifest->>'version' = module_version
    AND manifest->>'class' = module_class),
  CHECK (supersedes_approval_id IS NULL OR supersedes_approval_id <> id)
);
-- Exactly one approval may start a module's chain.
CREATE UNIQUE INDEX control_module_install_approvals_one_root
  ON control_module_install_approvals(tenant_id, module_id) WHERE supersedes_approval_id IS NULL;

CREATE TRIGGER control_module_install_approvals_immutable BEFORE UPDATE OR DELETE ON control_module_install_approvals
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_module_install_approvals_no_truncate BEFORE TRUNCATE ON control_module_install_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();

-- Whoever holds INSERT still cannot record an approval for someone who is not
-- the active human owner with a tenant-wide modules.install grant at the
-- module's risk (critical for CODE), nor backdate or postdate one.
CREATE FUNCTION guard_module_install_approval_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.approved_at < pg_catalog.statement_timestamp() - interval '5 minutes'
    OR NEW.approved_at > pg_catalog.statement_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'module install approval time rejected' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.control_identities owner_identity
      JOIN public.control_role_grants g ON g.tenant_id=owner_identity.tenant_id AND g.identity_id=owner_identity.id
      WHERE owner_identity.tenant_id=NEW.tenant_id AND owner_identity.id=NEW.owner_identity_id
        AND owner_identity.actor_type='human' AND owner_identity.state='active'
        AND g.role_key='owner' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at > NEW.approved_at)
        AND (g.allowed_actions ? '*' OR g.allowed_actions ? 'modules.install')
        AND g.project_ids ? '*'
        AND (g.risk_ceiling = 'critical' OR (NEW.module_class = 'declarative' AND g.risk_ceiling = 'high'))) THEN
    RAISE EXCEPTION 'module install approval needs the owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_module_install_approval_insert() FROM PUBLIC;
CREATE TRIGGER control_module_install_approvals_insert_guard BEFORE INSERT ON control_module_install_approvals
  FOR EACH ROW EXECUTE FUNCTION guard_module_install_approval_insert();

REVOKE ALL ON control_module_install_approvals FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_private_web') THEN
    EXECUTE 'GRANT SELECT, INSERT ON control_module_install_approvals TO control_room_private_web';
  END IF;
END $$;
