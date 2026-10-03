import type { DatabaseSession } from "./database";

/** Read-only effective privilege check for the dedicated operational worker.
 * This complements, not replaces, host/database identity, TLS, SQL-timeout and
 * schema-version checks in deployment preparation. It accepts SET ROLE fixtures;
 * production must separately require its configured LOGIN/session identity.
 *
 * WHY ONE RELATION OUTSIDE THE QUEUE SCHEMA IS PINNED (R4U-19a). Migration 0213
 * and db/roles/native_queue_worker_roles.sql grant the queue-worker group SELECT
 * on control_worker_text_copy_derivations, an OWNER-STYLE view -- created without
 * `security_invoker`, so it runs with control_room_schema_owner's privileges on
 * the table beneath it -- narrowed by its WHERE clause to the jobs the CALLING
 * LOGIN has an admission for. This check
 * pinned every readable relation to the queue schema and counted four, so a
 * correct install was refused -- measured before this change, on a real PG17
 * cluster installed the production way:
 *
 *   verifyPgBossNativeWorkerPermissions -> native_task_worker_permissions_invalid
 *   verifyNativeQueueWorkerDatabase      -> private_database_preflight_failed
 *   the real queue worker (real pg-boss) -> native_queue_worker_start_failed
 *
 * The GRANT is right and the CHECK was wrong: nothing reads that view through
 * this login yet, so revoking it was available, but it would have needed a new
 * migration, its down file, the grant-source and down-rung lists and a
 * re-derived schema digest -- to delete a grant no code path uses, which plan
 * v4.3 2.7 (MIG-E) requires again ("bots get the text copy for their part inputs
 * by default"). Pinning it adds no authority beyond rows this login was already
 * admitted to, because the admission join on `session_user` is what narrows the
 * view; the table underneath stays unreadable to this login (a refusal asserted
 * in that test file, and worth keeping as a second line of defence).
 *
 * The relaxation is exact, not lenient: the pin names the SCHEMA as well as the
 * relation, the view is read-only, the count is still exact, and every privilege
 * of every pinned relation is still compared against the live ACL. See
 * tests/queue-worker-privilege-preflight-postgres.test.ts, which asserts both
 * directions on real PostgreSQL.
 */
export async function verifyPgBossNativeWorkerPermissions(db: DatabaseSession): Promise<void> {
  try {
    const result = await db.query<{ valid: boolean }>(`/* control-room:pg-boss-worker-permissions/v1 */
      WITH roles AS (
        SELECT * FROM pg_roles WHERE pg_has_role(oid,'MEMBER')
      ), expected(nsp, name, writable) AS (
        -- The pin names the SCHEMA as well as the relation. A name alone could
        -- be satisfied by a same-named relation anywhere in the database; a
        -- (schema, name) pair cannot.
        VALUES ('control_room_queue','version',false),('control_room_queue','queue',false),
          ('control_room_queue','job',true),('control_room_queue','job_common',true),
          -- 0213: the bot's view of the text copies of the INPUTS it was given,
          -- read only. It is an OWNER-STYLE view -- no security_invoker option,
          -- so it reads control_text_copy_derivations as the schema owner -- and
          -- the grant it needs is the VIEW's and NOT the table's: this login
          -- holds no privilege on the table under it. The rows it can see are
          -- narrowed by the view's WHERE clause to the jobs this login has an
          -- admission for, so pinning the view grants no cross-tenant read. The
          -- rule below still refuses the table, so a grant added there is a
          -- preflight failure rather than a silent tenant-wide read.
          ('public','control_worker_text_copy_derivations',false)
      ), relations AS (
        SELECT c.oid,c.relowner,c.relkind,e.name,e.writable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN expected e ON e.nsp=n.nspname AND e.name=c.relname
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
        AND (SELECT count(*) FROM relations WHERE name IS NOT NULL)=5
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
