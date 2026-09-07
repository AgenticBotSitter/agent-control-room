import type { DatabaseSession } from "./database";

/** Fixed queue-schema privileges only. Canonical roles, identity and schema integrity
 * remain checked by the private database preflight. No grants or migrations here. */
export async function verifyPgBossApplicationPermissions(db: DatabaseSession, producer: boolean, recovery = false) {
  if (recovery && !producer) throw new Error("native_queue_application_permissions_invalid");
  const result = await db.query<{ valid: boolean }>(`WITH relations AS (
    SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='control_room_queue' AND c.relkind IN ('r','p','v','m','f')
  ), columns AS (
    SELECT r.*,a.attnum,a.attname FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid
    WHERE a.attnum>0 AND NOT a.attisdropped
  ) SELECT
    EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='control_room_queue')
    AND has_schema_privilege('control_room_queue','USAGE')=$1
    AND NOT has_schema_privilege('control_room_queue','CREATE')
    AND NOT has_schema_privilege('control_room_queue','USAGE WITH GRANT OPTION')
    AND (SELECT count(*) FROM relations WHERE relname IN ('version','queue','job','job_common'))=4
    AND NOT EXISTS(SELECT 1 FROM relations WHERE pg_has_role(relowner,'MEMBER')
      OR has_table_privilege(oid,'SELECT') IS DISTINCT FROM ($1 AND relname IN ('version','queue','job','job_common'))
      OR has_table_privilege(oid,'INSERT') IS DISTINCT FROM ($1 AND relname IN ('job','job_common'))
      OR has_table_privilege(oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION'))
    AND NOT EXISTS(SELECT 1 FROM columns WHERE
      pg_has_role(relowner,'MEMBER')
      OR has_column_privilege(oid,attnum,'SELECT') IS DISTINCT FROM
        ($1 AND relname IN ('version','queue','job','job_common'))
      OR has_column_privilege(oid,attnum,'INSERT') IS DISTINCT FROM ($1 AND relname IN ('job','job_common'))
      OR has_column_privilege(oid,attnum,'UPDATE') IS DISTINCT FROM ($1 AND
        ((relname='queue' AND attname='name') OR ($2 AND relname IN ('job','job_common') AND attname=ANY($3::text[]))))
      OR has_column_privilege(oid,attnum,'REFERENCES,SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
      OR has_table_privilege(oid,'DELETE,TRUNCATE,TRIGGER,MAINTAIN'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='control_room_queue' AND
        (has_function_privilege(p.oid,'EXECUTE') OR pg_has_role(p.proowner,'MEMBER')))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='control_room_queue' AND c.relkind='S' AND
        (has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') OR pg_has_role(c.relowner,'MEMBER')))
    AS valid`, [producer, recovery, ["state", "completed_on", "data", "priority", "start_after", "keep_until", "expire_seconds",
    "deletion_seconds", "retry_limit", "retry_delay", "retry_backoff", "retry_delay_max", "dead_letter", "heartbeat_seconds", "group_id", "group_tier"]]);
  if (result.rows.length !== 1 || result.rows[0].valid !== true) throw new Error("native_queue_application_permissions_invalid");
}
