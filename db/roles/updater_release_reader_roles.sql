-- The updater's ONE read of the release schema, granted from the release side.
--
-- WHY THIS FILE EXISTS AND WHY IT IS HERE RATHER THAN IN THE UPDATER'S DDL.
-- The updater's guard `updater.owner_session_is_live` is SECURITY DEFINER and
-- owned by `control_room_deployer`, so it runs as the deployer — and a deployer
-- cannot grant itself SELECT on a table it does not own. The four tables below
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
-- WHAT IS GRANTED, AND WHY IT IS COLUMN-SCOPED. Four tables, and only the
-- columns the updater actually evaluates. A table-wide SELECT would let a
-- compromised updater read every session's identity and expiry independently of
-- the check, and would silently widen if a column were ever added. On the first
-- three the point of the grant is to answer one question — "is this token digest
-- a live owner session right now?" — and nothing else. On the fourth
-- (`owner_web_push_subscriptions`, item 21) it is the opposite kind of read: the
-- updater is the process that SENDS the owner's push, so it needs the endpoint
-- and the two encryption keys, and still nothing writable.
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

  -- Item 21's addition, and the only reason the updater can SEND rather than
  -- only queue. §15 item 21 makes the updater the process that POSTs to the
  -- owner's push endpoints with the root-only VAPID key (R12); the web cannot
  -- (it holds only the public key) and must not. So the updater needs the
  -- endpoint and the two encryption keys, not just the count.
  --
  -- It was granted `(tenant_id, id, expires_at)` alone because item 10a only
  -- needed to COUNT live subscriptions. The item-21 query reads
  -- `id, endpoint, p256dh, auth, expires_at`, so on a real cluster the one
  -- process that must alert was refused `permission denied for table
  -- owner_web_push_subscriptions` and every send would have failed. Measured,
  -- not assumed: that is what the first real-PG run of the alert lane showed.
  -- The grant is extended rather than replaced, and it stays read-only and
  -- column-scoped: `endpoint`, `p256dh` and `auth` are the three columns a push
  -- send needs, and nothing on this table is writable by the updater.
  --
  -- WHAT THE UPDATER STILL CANNOT DO WITH THEM: it holds no INSERT, UPDATE or
  -- DELETE here, so it cannot mint a subscription for an endpoint it does not
  -- already have, cannot make one expire to silence an alert, and cannot read
  -- or write any other release table. R12's threat was a web forging the
  -- updater's voice, which is the trigger, not this read.
  EXECUTE 'GRANT SELECT (tenant_id, id, endpoint, p256dh, auth, expires_at)'
    || ' ON public.owner_web_push_subscriptions TO control_room_deployer';

  -- The health count read (design §8.4 item 2). EXECUTE only, and only once
  -- db/migrations/0239 has created the function -- a GRANT to a missing function
  -- is an error, and on a cluster where this file is applied before the release
  -- ledger has run there is nothing to grant to yet. The guarded form keeps this
  -- file re-appliable in both orders, which is what the file's own header already
  -- requires of it for the role itself.
  --
  -- This is the ONLY authority the updater's login holds that is not a table
  -- grant, and it is a function that returns three integers. It is here, and not
  -- in the migration, because the role this grants to is created by the updater's
  -- own DDL at startup, which is strictly after the ledger runs: a GRANT in the
  -- migration would be a silent no-op on every fresh install.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.proname = 'updater_health_counts'
        AND pg_catalog.pg_get_function_identity_arguments(p.oid) = '') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.updater_health_counts() TO control_room_deployer';
  END IF;
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
