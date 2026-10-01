-- The updater's ONE read of the release schema, granted from the release side.
--
-- WHY THIS FILE EXISTS AND WHY IT IS HERE RATHER THAN IN THE UPDATER'S DDL.
-- The updater's guard `updater.owner_session_is_live` is SECURITY DEFINER and
-- owned by `control_room_deployer`, so it runs as the deployer — and a deployer
-- cannot grant itself SELECT on a table it does not own. The three tables below
-- are owned by `control_room_schema_owner`, so the GRANT has to be issued by
-- their owner. Measured, not assumed: as the deployer, PostgreSQL refuses with
-- "permission denied for column tenant_id of relation control_web_sessions".
--
-- Putting the grant in the updater's own `ddl/` and running it as the INSTALLER
-- would technically work, and would be the wrong place for it: the installer
-- holds schema-owner authority over the release schema, so a grant issued there
-- is a grant the release side made under installer authority. This file is
-- applied the ordinary way — as the schema owner, by the installer and by the
-- live upgrade (`scripts/mac-local/narrow-role-provision.mjs` and
-- `database-upgrade-remote.mjs` read the db/roles list), so it is reviewed,
-- diffed and grant-converged like every other release-schema grant, and the
-- exact text is asserted by the existing role-manifest and preflight tests.
--
-- WHAT IS GRANTED, AND WHY IT IS COLUMN-SCOPED. Three tables, and only the
-- columns the guard's EXISTS evaluates. A table-wide SELECT would let a
-- compromised updater read every session's identity and expiry independently of
-- the check, and would silently widen if a column were ever added. The point of
-- the grant is to answer one question — "is this token digest a live owner
-- session right now?" — and nothing else.
--
-- WHAT THE DEPLOYER STILL CANNOT DO, which is the part that matters:
--   * it holds NO INSERT, UPDATE, DELETE or TRUNCATE on any release table, so it
--     cannot mint, extend, revoke or steal a session;
--   * it holds no privilege on any other release table, so it cannot read a
--     plan, candidate, review, task or result;
--   * `updater.owner_session_is_live` itself is REVOKEd from PUBLIC, so this
--     grant is only ever used from inside the guard.
-- The updater's loader asserts all three on every startup
-- (src/updater/v1/schema-installer.ts, `updaterReleaseReadTablesV1`): a FOURTH
-- reachable release table fails the updater at startup rather than sitting
-- unnoticed, and a missing one fails the guard.
--
-- The role itself is created by the updater's fixed DDL
-- (src/updater/v1/ddl/0001_deployer_role.sql) and is deliberately absent from
-- `database-role-manifest.mjs`, so the live upgrade never creates, alters or
-- revokes it. The guards below therefore make this file safe to apply before the
-- updater has ever run: it is a no-op until the role exists, and it is
-- re-appliable on every installer and upgrade run.

-- The grant is issued by the schema owner, so it is wrapped in a guard that
-- checks the grantor is in fact the owner: a role file applied by the wrong
-- connection would otherwise fail with an opaque "permission denied" instead of
-- naming the problem.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
    -- The updater has not created its own role yet. Nothing to grant to; the
    -- installer applies this file again after the updater's DDL has run.
    RETURN;
  END IF;
  IF NOT pg_catalog.has_table_privilege(current_user,
      'public.control_web_sessions', 'SELECT,INSERT,UPDATE,DELETE') THEN
    -- The applier can read but not administer the table, so it is not in a
    -- position to grant. Refuse loudly rather than silently doing nothing.
    RAISE EXCEPTION 'updater release-reader grant needs the schema owner; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  EXECUTE 'GRANT SELECT (tenant_id, token_digest, identity_id, expires_at, revoked_at)'
    || ' ON public.control_web_sessions TO control_room_deployer';
  EXECUTE 'GRANT SELECT (tenant_id, id, actor_type, state)'
    || ' ON public.control_identities TO control_room_deployer';
  EXECUTE 'GRANT SELECT (tenant_id, identity_id, role_key, risk_ceiling, allowed_actions, project_ids,'
    || ' expires_at, revoked_at) ON public.control_role_grants TO control_room_deployer';
  -- Item 10a's addition, and the only reason `enqueue_cooling_off_notices` can
  -- work: the deployer must be able to COUNT the owner's live subscriptions, so
  -- it can refuse a `passkey add` when there is nobody to warn. One boolean
  -- question, granted column-wise: the endpoint itself is never readable from
  -- here, because the updater does not send pushes — it queues them and the
  -- dispatch path (item 21) does, with the root-only VAPID key (R12).
  --
  -- `id` is included so a future de-duplication is possible without a second
  -- grant, and `expires_at` because an expired browser endpoint is not a browser
  -- that will be told. No endpoint, no key material, no tenant beyond the one it
  -- already had.
  EXECUTE 'GRANT SELECT (tenant_id, id, expires_at)'
    || ' ON public.owner_web_push_subscriptions TO control_room_deployer';
END;
$$;

-- The grant is read-only by construction, so state it: a later edit that added
-- an INSERT here would not fail the GRANT (the schema owner may grant its own
-- tables anything) but WOULD fail the updater's startup assertion, which counts
-- reachable release tables by column and by DELETE/TRUNCATE. This trigger-free
-- statement is the local half of that: it refuses at grant time, where the
-- operator can see why, as well as at updater startup, where the updater acts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname IN ('control_web_sessions','control_identities','control_role_grants')
          AND (EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                           AND (has_column_privilege('control_room_deployer', c.oid, a.attname, 'INSERT')
                             OR has_column_privilege('control_room_deployer', c.oid, a.attname, 'UPDATE')))
               OR has_table_privilege('control_room_deployer', c.oid, 'DELETE')
               OR has_table_privilege('control_room_deployer', c.oid, 'TRUNCATE'))) THEN
      RAISE EXCEPTION 'updater release-reader grant must be read-only' USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$$;
