import type { DatabaseSession } from "./database";

/** Read-only effective privilege check for the dedicated operational worker.
 * This complements, not replaces, host/database identity, TLS, SQL-timeout and
 * schema-version checks in deployment preparation. It accepts SET ROLE fixtures;
 * production must separately require its configured LOGIN/session identity.
 */
export async function verifyPgBossNativeWorkerPermissions(db: DatabaseSession): Promise<void> {
  try {
    const result = await db.query<{ valid: boolean }>(`/* control-room:pg-boss-worker-permissions/v1 */
      WITH roles AS (
        SELECT * FROM pg_roles WHERE pg_has_role(oid,'MEMBER')
      ), expected(name, writable) AS (
        VALUES ('version',false),('queue',false),('job',true),('job_common',true)
      ), relations AS (
        SELECT c.oid,c.relowner,c.relkind,e.name,e.writable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN expected e ON n.nspname='control_room_queue' AND e.name=c.relname
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
          AND c.relkind IN ('r','p','v','m','f')
      )
      SELECT
        EXISTS(SELECT 1 FROM roles WHERE rolname='control_room_native_queue_worker')
        AND NOT EXISTS(SELECT 1 FROM roles WHERE
          rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
          OR NOT rolinherit OR rolname NOT IN (current_user,'control_room_native_queue_worker'))
        AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE admin_option
          AND pg_has_role(member,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND NOT has_parameter_privilege('session_replication_role','SET')
        AND has_schema_privilege('control_room_queue','USAGE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
          AND nspname<>'information_schema' AND (has_schema_privilege(oid,'CREATE')
          OR pg_has_role(nspowner,'MEMBER')))
        AND (SELECT count(*) FROM relations WHERE name IS NOT NULL)=4
        AND NOT EXISTS(SELECT 1 FROM relations WHERE
          pg_has_role(relowner,'MEMBER')
          OR has_table_privilege(oid,'SELECT') IS DISTINCT FROM (name IS NOT NULL)
          OR has_any_column_privilege(oid,'SELECT') IS DISTINCT FROM (name IS NOT NULL)
          OR has_table_privilege(oid,'INSERT') IS DISTINCT FROM coalesce(writable,false)
          OR has_any_column_privilege(oid,'INSERT') IS DISTINCT FROM coalesce(writable,false)
          OR has_table_privilege(oid,'UPDATE') IS DISTINCT FROM coalesce(writable,false)
          OR has_any_column_privilege(oid,'UPDATE') IS DISTINCT FROM coalesce(writable,false)
          OR has_table_privilege(oid,'DELETE') IS DISTINCT FROM coalesce(writable,false)
          OR has_table_privilege(oid,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR has_any_column_privilege(oid,'REFERENCES')
          OR has_table_privilege(oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION')
          OR has_any_column_privilege(oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION'))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='S'
          AND (pg_has_role(c.relowner,'MEMBER') OR has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE')))
        AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
          AND (pg_has_role(p.proowner,'MEMBER') OR has_function_privilege(p.oid,'EXECUTE')))
        AS valid`);
    if (result.rows.length !== 1 || result.rows[0].valid !== true) throw new Error();
  } catch {
    const error = new Error("native_task_worker_permissions_invalid"); error.stack = undefined; throw error;
  }
}
