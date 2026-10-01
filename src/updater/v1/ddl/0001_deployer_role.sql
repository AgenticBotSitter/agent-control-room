-- The updater's own database role, part of the updater's FIXED DDL.
--
-- This file is NOT the release migration ledger. It is shipped inside
-- updater/<ver>/ddl/ and applied once at install time, before the schema file
-- beside it. Nothing in db/migrations/ creates, alters or grants this role: the
-- migrator has no rights in schema `updater` at all, and never had.
--
-- WHY THE ROLE IS A LOGIN WITH NO PASSWORD (design §9.1). pg_hba.conf maps
-- `local all control_room_deployer peer map=cr` to `cr root
-- control_room_deployer`, so the only way in is a process already running as
-- root on this Mac. There is no SCRAM verifier to hand the installer, nothing
-- for another login to inherit, and nothing a wrong-uid process can use. A
-- password would add a credential to a role whose whole authority is "root
-- connected on the local socket".
--
-- NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE and NOCREATEDB are what keep a
-- compromised updater from escalating inside PostgreSQL; it can still own and
-- use schema `updater`, which is the authority it is supposed to have.
--
-- NOT IN THE ROLE MANIFEST, DELIBERATELY. The live upgrade
-- (`scripts/mac-local/database-upgrade-remote.mjs`) creates, checks and repairs
-- exactly the roles named in `database-role-manifest.mjs`, and it must never
-- touch this one: the upgrade runs as a peer-mapped migrator with CREATEROLE,
-- so listing the deployer there would hand the release path a role whose whole
-- authority is that the release path cannot reach. Its absence from the
-- manifest is therefore a property, and the manifest's own test
-- (tests/mac-local-database-upgrade.test.mjs) proves the migrations and down
-- files name no role outside it — which stays true, because this file is in
-- src/updater/, not in db/.

-- The role is created here with NO PASSWORD, and this file never sets one. That
-- is the whole of the property: `pg_hba.conf` maps
-- `local all control_room_deployer peer map=cr` to root, so a role with no
-- verifier is reachable only by a process already running as root, and a role
-- WITH a verifier is a second, secret-bearing way in.
--
-- There is deliberately no "refuse if it has a password" check here, because
-- such a check could not be non-vacuous: this file creates the role and so can
-- never find it holding one, and a version that raised anyway would break the
-- legitimate case where an operator (or this repository's test harness, which
-- speaks the password protocol where production uses peer authentication) has
-- added a verifier after the first install.
--
-- The ongoing check lives where it can be both meaningful and aware of context:
-- `applyUpdaterSchemaV1` in src/updater/v1/schema-installer.ts reads
-- `pg_authid.rolpassword` on EVERY startup and refuses unless the caller has
-- declared that a fixture verifier exists. A caller that has not set one — which
-- is every production caller — gets the refusal.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer') THEN
    CREATE ROLE control_room_deployer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

-- The attributes ARE re-asserted on every apply, and this one is not vacuous:
-- `ALTER ROLE control_room_deployer SUPERUSER` by an operator or a mistake makes
-- it fail here, and `rolsuper`/`rolbypassrls` are the two attributes that would
-- turn a compromised updater into a database superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_deployer'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'updater deployer role attributes refused' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- control_room_backup_reader — the nightly backup's READ-ONLY login (item 19a)
-- ---------------------------------------------------------------------------
-- The nightly backup has to read every row of every table to dump it and to
-- count it, and the first version did both as a SUPERUSER. That turned a
-- row-count bug into a database takeover (review backup19b C1): a candidate
-- release named a table `t1";ALTER ROLE control_room_migrator SUPERUSER;--`, the
-- count ran it with superuser authority, and the release login became a
-- superuser. The count is fixed in src/updater/v1/backup-evidence.mjs; this role
-- is the second half, so that a future bug of the same kind finds no authority
-- to steal.
--
-- What it holds, and why each part:
--   * LOGIN, no password: peer-mapped like the deployer — `pg_hba.conf` maps
--     `local all control_room_backup_reader peer map=cr` for root (the evidence
--     read) and for `_crdb` (the `pg_dump` child). There is no verifier to leak.
--   * membership in `pg_read_all_data`: SELECT on every table and USAGE on every
--     schema, including `updater`, so the dump is whole. It grants no write,
--     no DDL and no function EXECUTE beyond PUBLIC's.
--   * BYPASSRLS: release tables use row-level security, and a policy's USING
--     expression is RELEASE CODE that would otherwise run as this login on every
--     count. With BYPASSRLS no policy is evaluated for it at all, and pg_dump
--     reads whole tables without `--enable-row-security`.
--   * NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION, and ADMIN on nothing:
--     it cannot grant, create or become anything. `assertEvidenceReaderV1`
--     re-checks this from the inside before every read, and the updater's loader
--     re-checks it from the outside on every start.
-- Created by the bootstrap (BYPASSRLS needs it), so the release's CREATEROLE
-- migrator holds no ADMIN on it and cannot alter it or grant it to itself.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_backup_reader') THEN
    CREATE ROLE control_room_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION BYPASSRLS INHERIT;
  END IF;
END;
$$;
GRANT pg_read_all_data TO control_room_backup_reader;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'control_room_backup_reader'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND rolbypassrls) THEN
    RAISE EXCEPTION 'updater backup reader role attributes refused' USING ERRCODE = '42501';
  END IF;
END;
$$;
