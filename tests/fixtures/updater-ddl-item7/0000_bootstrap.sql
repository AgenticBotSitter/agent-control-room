-- Bootstrap for schema `updater`: the role and the schema itself.
--
-- SPLIT FROM 0002_schema.sql ON PURPOSE, and the split is the security property.
-- `CREATE SCHEMA` requires CREATE on the database, and the deployer role must
-- NOT hold that: a login that could create a schema in this database could
-- create a schema of its own and, more importantly, the grant-convergence tool
-- (`scripts/mac-local/database-upgrade-grants.mjs`) treats database-level CREATE
-- as a reason to refuse convergence. So the role and the schema are created ONCE,
-- by the installer, with the bootstrap privilege the installer already holds,
-- and 0002 onward run as the deployer over an existing schema.
--
-- What that costs is checked rather than assumed: 0001 verifies the role's
-- attributes and refuses a password, and 0002 verifies the schema's owner before
-- it creates anything. So the split does not turn "who made this" into a
-- comment — a schema owned by anyone else is refused on every start, and a role
-- with a password or a privilege is refused on every start.
--
-- This is still the updater's fixed DDL, not the release migration ledger. The
-- installer (item 4) runs this one file once at install time as root; nothing in
-- db/migrations/ creates, alters or grants any of it, and the release migrator
-- holds no privilege in schema `updater` at any point.

-- 0001_deployer_role.sql is included by reference rather than by \i, because
-- \i resolves a path relative to the client and this file is applied as a
-- single in-transaction statement by the updater's own loader. The installer
-- applies 0001 first, then this file; the guard below is what makes running this
-- file without 0001 fail loudly rather than produce a schema nobody owns.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
    RAISE EXCEPTION 'updater deployer role must exist before its schema (run 0001_deployer_role.sql first)'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'updater') THEN
    -- CREATE SCHEMA IF NOT EXISTS is a no-op when the schema exists, but the
    -- owner check below still runs, so a schema created by somebody else is
    -- refused rather than adopted.
    IF NOT has_database_privilege(current_user, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'creating schema updater needs the installer bootstrap; the deployer role must not hold database CREATE'
        USING ERRCODE = '42501';
    END IF;
    EXECUTE 'CREATE SCHEMA updater AUTHORIZATION control_room_deployer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'updater' AND r.rolname = 'control_room_deployer') THEN
    RAISE EXCEPTION 'updater schema owner refused' USING ERRCODE = '42501';
  END IF;
  -- A schema created without an explicit owner is owned by whoever ran
  -- CREATE SCHEMA. The installer is a superuser here, so without this the
  -- deployer would not own its own tables and every subsequent statement would
  -- fail with a permission error instead of the clear one above.
  RAISE NOTICE 'updater schema present and owned by control_room_deployer';
END;
$$;
