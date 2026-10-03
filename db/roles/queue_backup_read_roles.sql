-- OFFLINE CANDIDATE SETUP ONLY; never executed by application startup.
-- Requires a separately provisioned, dedicated control_room_queue schema (the
-- release's own pg-boss construction). No CREATE ROLE, no LOGIN, no queue, no
-- schema, no database and no DDL: this file grants exactly one read.
--
-- WHY THIS FILE EXISTS (R5B-01). The nightly backup runs as
-- `control_room_migrator` (`src/installer/v1/nightly-backup-configuration.ts`)
-- and `pg_dump` reads EVERY schema. `control_room_queue` is owned by `postgres`,
-- deliberately: the release fingerprints every queue relation's OWNER, and
-- queue objects owned by the migrator would be objects a migration could ALTER
-- (`apply-release-schema.mjs` records that decision at length). So the owner is
-- fixed and NOT the migrator — and MEASURED on PostgreSQL 17, as the production
-- login: `GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner`
-- answers `permission denied for schema control_room_queue`, because the
-- migrator is not the schema's owner and a GRANT needs one. Every night therefore
-- exited 1 with `permission denied for schema control_room_queue`, and left zero
-- generations behind. This file is the file that can grant it, because the
-- release's own privilege-file loop runs these files as `postgres`.
--
-- WHAT IT GRANTS, AND WHY IT IS EXACTLY THIS MUCH.
--   USAGE on the schema, SELECT on its tables and sequences, and a DEFAULT
--   PRIVILEGE for the tables the queue owner creates later.
-- MEASURED, one grant at a time, each followed by a real `pg_dump` on a
-- production-shaped database (PostgreSQL 17, as the production login):
--   USAGE alone                 -> `permission denied for schema control_room_queue`
--   + SELECT ON ALL TABLES      -> `permission denied for table version`
--   + SELECT ON ALL SEQUENCES   -> dump completes, 88 queue objects, no warning
--
-- AND THE DEFAULT PRIVILEGE IS NOT OPTIONAL. pg-boss creates a NEW
-- `control_room_queue.queue_stats_YYYYMMDD` partition every day, as the QUEUE
-- OWNER. `ON ALL TABLES` covers only the tables that exist when this file runs,
-- so without the clause below the nightly backup SUCCEEDS on its first night and
-- then FAILS the next morning with `permission denied for table
-- queue_stats_29991231`. MEASURED, both halves: with only `ON ALL TABLES` the
-- partition is unreadable (`has_table_privilege` false) and the real `pg_dump`
-- fails on it; after the clause, a partition created by the queue owner IS
-- readable. That is the failure mode that is worse than the one this file was
-- written for, because it looks like the fix worked.
--
-- `FOR ROLE <owner>` is spelled from the catalogue rather than hard-coded to
-- `postgres`, because the release's fingerprint pins the queue's OWNER to
-- `postgres` on the Mac install and to whatever the managed cluster's superuser
-- is called on a VPS — the same reason `verify-database-backup.mjs` hard-codes
-- `postgres` and R5B-10 was filed against it. Reading the name from
-- `pg_namespace.nspowner` is what makes this file correct on both, and it is
-- exactly the fact the file already refuses when the schema is absent.
-- `ALTER DEFAULT PRIVILEGES FOR ROLE` requires being a member of that role or a
-- superuser; this file is applied by the file's actor (the queue owner itself),
-- which satisfies that.
--
-- WHY NOT THE QUEUE WORKER'S OWN ROLE. `control_room_native_queue_worker` already
-- holds SELECT on `version`, `queue`, `job` and `job_common`, and this file does
-- NOT widen it: the worker grant is deliberately narrow (the recovery file adds
-- DELETE/INSERT/UPDATE because failure settlement needs them), and the dump
-- needs every table in the schema including `bam`, `warning`, `queue_stats`, its
-- daily partitions and `job_dependency`. Reusing the worker's role would have
-- made the backup depend on a role whose grants a queue change may narrow.
--
-- WHY THE SCHEMA OWNER, AND NOT THE MIGRATOR DIRECTLY. The migrator inherits this
-- through `control_room_schema_owner`, whose only member on a live install is the
-- migrator itself (MEASURED, including the transitive closure). Granting the
-- GROUP rather than the LOGIN is the convention every other file in this
-- directory follows, and it keeps the grant INSIDE the release's convergent
-- surface: `desired-grants.json` names the Mac-local service principals, and
-- `control_room_schema_owner` is deliberately not one of them — MEASURED, zero
-- tuples in the manifest — so the converger cannot see this grant, and therefore
-- can never report it as EXTRA and revoke it on the next update.
--
-- WHY THIS IS NOT THE GRANT'S ONLY INSTRUMENT. A migration cannot grant on
-- `control_room_queue` at all (MEASURED, as the production login with `SET ROLE
-- control_room_schema_owner`: the migrator cannot make this grant), so this file
-- remains the only thing that can actually grant it, and
-- `db/migrations/0285_queue_backup_read.sql` is the LEDGER RECORD of the
-- requirement — it returns silently when the schema is absent and refuses BY NAME
-- when the schema is present without the read.
--
-- AND THE ORDER IS WHAT MAKES THAT RECORD TRUE. This file runs BEFORE the ledger
-- (apply-release-schema.mjs step 1: queue schema, this file, then the ledger,
-- then the remaining role files). MEASURED the other way round: with the ledger
-- first, an int6-shaped database — queue schema present from the original install,
-- read absent because this file did not exist yet — refused at 0285 on every
-- update and on every retry of it, so such a Mac could never pass 0285. This file
-- is also the only role file the phase applies early, and the phase CHECKS that it
-- grants on nothing the ledger creates (earlyPrivilegeFileScopeV1), which is what
-- makes running it here safe.
BEGIN;

-- The schema must exist for any of this to apply, and a candidate set applied
-- before the release's pg-boss construction has run must not be a hard failure:
-- the same guard the queue role files use for their own prerequisite.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'control_room_queue') THEN
    RAISE EXCEPTION 'queue backup read prerequisite mismatch: control_room_queue schema absent';
  END IF;
END $$;

REVOKE ALL ON SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA control_room_queue FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_room_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA control_room_queue TO control_room_schema_owner;

-- The clause the NEXT MORNING needs, and why the owner is read from the
-- catalogue rather than spelled `postgres`: pg-boss's daily `queue_stats`
-- partition is created by the queue's owner, so the default privilege has to be
-- FOR that role. `pg_namespace.nspowner` is the same fact the release's own
-- fingerprint pins, and reading it is what keeps this file correct on a managed
-- VPS cluster whose superuser is not called `postgres` (R5B-10). The schema is
-- known to exist by now — the guard above refused otherwise — so this read is a
-- row rather than a guess, and `%I` quotes the name because it becomes SQL.
DO $queue_backup_read$
DECLARE
  queue_owner name;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO queue_owner FROM pg_namespace WHERE nspname = 'control_room_queue';
  IF queue_owner IS NULL THEN
    RAISE EXCEPTION 'queue backup read prerequisite mismatch: control_room_queue schema absent';
  END IF;
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA control_room_queue'
    || ' GRANT SELECT ON TABLES TO control_room_schema_owner', queue_owner);
END
$queue_backup_read$;

COMMIT;