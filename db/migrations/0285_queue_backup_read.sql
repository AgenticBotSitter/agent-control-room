-- R5B-01: THE NIGHTLY BACKUP'S DUMP LOGIN MUST BE ABLE TO READ THE QUEUE SCHEMA.
--
-- The nightly backup runs as `control_room_migrator`
-- (`src/installer/v1/nightly-backup-configuration.ts`) and `pg_dump` reads EVERY
-- schema. `control_room_queue` is owned by `postgres`, deliberately: the release
-- fingerprints every queue relation's owner so a migration cannot ALTER a queue
-- object. No `control_room_*` login held any grant on it, so every night exited 1
-- with `permission denied for schema control_room_queue`, left zero generations,
-- and told the owner nothing but one stderr line.
--
-- THE GRANT IS db/roles/queue_backup_read_roles.sql, AND THIS FILE IS ITS
-- LEDGER RECORD — NOT ITS AUTHOR. That is a measured constraint, not a choice,
-- and it is the whole reason this file is shaped the way it is:
--
--   * the migrator is not the queue schema's owner, so it cannot GRANT there.
--     MEASURED as the production login with `SET ROLE control_room_schema_owner`
--     applied, which is exactly how the ledger runs every migration:
--     `GRANT USAGE ON SCHEMA control_room_queue TO …` answers
--     `permission denied for schema control_room_queue`. A GRANT needs the
--     object's owner and there is no path from the migrator to it.
--   * the queue schema does not exist when this file runs on a fresh install. The
--     ledger was applied BEFORE the release built the queue, so the schema had to be
--     created earlier for this check to be meaningful; the phase builds it first
--     (installFixedQueue in apply-release-schema.mjs, step 1) and the schema is built
--     by the release's pg-boss construction, not by any migration. MEASURED:
--     `GRANT SELECT ON ALL TABLES IN SCHEMA <absent>` and
--     `ALTER DEFAULT PRIVILEGES IN SCHEMA <absent>` are both hard errors.
--     (The ledger used to run BEFORE the queue was built as well, which is the
--     ordering fault described below and has now been fixed.)
--
-- SO WHAT THIS FILE IS FOR. It is the ledger's statement that reading the queue
-- is a REVIEWED requirement of a working backup, checked where the requirement
-- becomes visible, and it is deliberately SILENT about a grant it cannot make:
--
--   schema absent   -> return. A fresh install is not broken; the queue does not
--                      exist yet and the role file grants the read the moment it
--                      does. Failing here would fail every clean install.
--   schema present, read present    -> pass. A new install, or one an earlier run
--                      of this release already converged.
--   schema present, read MISSING    -> REFUSE, by name, with the repair. It does
--                      NOT repair it, because it cannot (the measurement above),
--                      and it does not stay quiet, because a silent pass here is
--                      the original defect: a backup that cannot read the queue
--                      and an update that reported success.
--
-- There is a real tension with the release phase's own privilege-file loop: the
-- ledger used to run BEFORE that loop, so this file asserted a grant the same run
-- had not made yet. MEASURED: on a database shaped like int6 — the queue schema
-- present from the original install, the read absent because the granting file did
-- not exist yet — every update refused here and every retry refused again at the
-- identical point, so such a Mac could never reach this file's ledger row at all.
--
-- THE PHASE'S ORDER IS NOW: the queue schema, then
-- db/roles/queue_backup_read_roles.sql, then the ledger, then the remaining role
-- files (apply-release-schema.mjs, step 1). So this postcondition is TRUE by the
-- time this file runs, and the trade this comment used to describe — a loud
-- refusal on an install that has drifted, in exchange for never a quiet pass on a
-- broken backup — is kept without paying for it. The refusal below now fires only
-- when the read is genuinely absent AFTER the phase tried to make it: an operator
-- who REVOKEd it by hand, or a restore that replayed a pre-0285 ACL.
--
-- WHICH ORDER, AND WHY NOT THE OTHER ONE. Making THIS FILE tolerant instead —
-- "refuse only when the ledger head already contains this row" — would have had to
-- be duplicated into the release's other upgrade path, which never runs the role
-- file at all: scripts/mac-local/database-upgrade-remote.mjs migrates first and
-- converges grants from database-upgrade-grants.mjs, whose roleFiles deliberately
-- exclude this one (its parser refuses a grantee that is not a Mac-local service
-- group, and control_room_schema_owner is the migrator's group). So a
-- history-conditioned pass would leave that path still refusing, AND would let
-- this file pass silently on the exact shape it was written to catch. Fixing the
-- order keeps the refusal exactly as sharp.
--
-- WHAT IT REFUSES ON, and this is the part with teeth. A schema that exists with
-- NO read for the dump login is the exact state that failed every night for a
-- release, and it is reachable again by a narrower path than a missing role file:
-- an owner who REVOKEs it, or a restore that replays the pre-0285 ACL. Against
-- those, this asserts that the schema USAGE and the owner-side DEFAULT PRIVILEGE
-- are both present. The default privilege is the one that matters most: pg-boss
-- creates a `queue_stats_YYYYMMDD` partition every day as the queue owner, and
-- MEASURED a real `pg_dump` fails on one with `permission denied for table
-- queue_stats_<date>`. A backup that works tonight and fails tomorrow morning is
-- worse than one that never worked, so the postcondition includes tomorrow.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $queue_backup_read$
DECLARE
  queue_owner name;
  has_usage boolean;
  has_default boolean;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO queue_owner FROM pg_namespace WHERE nspname = 'control_room_queue';
  -- No queue yet: nothing to read and nothing to assert. The release builds it
  -- after this ledger, and grants the read as the owner when it does.
  IF queue_owner IS NULL THEN
    RETURN;
  END IF;

  SELECT has_schema_privilege('control_room_schema_owner', 'control_room_queue', 'USAGE') INTO has_usage;

  -- The default privilege, for the role that will create tomorrow's partition.
  -- `aclexplode` rather than a string match on `defaclacl`, because the grantor
  -- in an aclitem is the role that made it — which must be the queue's owner —
  -- and a LIKE cannot tell that from the grantee. MEASURED on the two states that
  -- matter: after the role file, `pg_default_acl` holds a `defaclobjtype='r'`
  -- row whose aclitem names `control_room_schema_owner`; after a REVOKE, that row
  -- is GONE (only the pre-existing `defaclobjtype='f'` row remains), so this
  -- check is a real absence test and not a comparison that always matches.
  SELECT EXISTS (
    SELECT 1
      FROM pg_default_acl d
        CROSS JOIN LATERAL aclexplode(d.defaclacl) acl
        JOIN pg_roles grantee ON grantee.oid = acl.grantee
      WHERE d.defaclnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'control_room_queue')
        AND pg_get_userbyid(d.defaclrole) = queue_owner
        AND d.defaclobjtype = 'r'
        AND grantee.rolname = 'control_room_schema_owner'
        AND acl.privilege_type = 'SELECT'
  ) INTO has_default;

  -- Both halves, or the next nightly backup fails. The repair is named because
  -- the operator can act on it: the role file's actor is the only role that can
  -- make this grant, and the name is the queue's actual owner rather than a
  -- guessed `postgres` (a managed VPS cluster's superuser has another name — the
  -- same fact R5B-10 turns on).
  IF NOT has_usage OR NOT has_default THEN
    RAISE EXCEPTION 'queue_backup_read_incomplete:usage=%,default=%,repair=apply db/roles/queue_backup_read_roles.sql as the queue schema owner (%)',
      has_usage, has_default, queue_owner;
  END IF;
END
$queue_backup_read$;