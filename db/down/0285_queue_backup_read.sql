-- Revoke exactly what db/migrations/0285_queue_backup_read.sql asserted, and
-- nothing else.
--
-- 0285 grants nothing: it is a postcondition check, because the GRANT itself is
-- made by db/roles/queue_backup_read_roles.sql as the queue schema's owner and
-- the migrator cannot make it (MEASURED as the production login: `permission
-- denied for schema control_room_queue`). So its down file does the only thing
-- that is both true and reversible — it removes the two privileges 0285 required
-- to be present, which are the same two the role file granted. A rollback that
-- left them would be a rollback that did nothing, and the next upgrade's 0285
-- would pass on a database whose backup could still fail the following morning.
--
-- The DEFAULT PRIVILEGE is revoked for the queue schema's OWNER, read from the
-- catalogue rather than spelled `postgres`: the same reasoning as the up file
-- (a managed VPS cluster's superuser has another name — R5B-10), and the owner's
-- name is the only one `ALTER DEFAULT PRIVILEGES FOR ROLE` accepts that is
-- guaranteed to be the role that will create tomorrow's partition.
--
-- The tables and sequences are NOT touched, and neither is the schema: 0285 never
-- granted on any specific relation beyond what the role file's `ON ALL TABLES`
-- covers, and a rollback that revoked per-relation SELECT would narrow the dump
-- login on relations the up file never named. Rolling back restores the pre-0285
-- requirement — "the dump login can read every schema" is no longer enforced —
-- not a database that cannot be dumped at all. That is the operator's call to
-- make explicitly, and the refusal below names it.

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

DO $queue_backup_read_down$
DECLARE
  queue_owner name;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO queue_owner FROM pg_namespace WHERE nspname = 'control_room_queue';
  -- No queue: 0285 asserted nothing and this revokes nothing. A rollback must be
  -- as safe on a partially-installed database as the up file was.
  IF queue_owner IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA control_room_queue'
    || ' REVOKE SELECT ON TABLES FROM control_room_schema_owner', queue_owner);
  REVOKE USAGE ON SCHEMA control_room_queue FROM control_room_schema_owner;
END
$queue_backup_read_down$;