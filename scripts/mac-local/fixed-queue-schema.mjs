/** The Mac-local delivery queue is built only by the pinned pg-boss constructor.
 * The catalog fingerprint is a fail-closed PG17 receipt of that construction,
 * not a generic repair path for a partly installed or altered queue schema. */
import { createHash } from "node:crypto";
import { PgBoss, getConstructionPlans } from "pg-boss";
import { macRolePlan } from "./database-upgrade-grants.mjs";

// Updated only after a fresh PostgreSQL 17 construction and negative tests.
const expectedShapeDigest = "sha256:c7ac7af7bb4b466fb108743d14f66539fa2131d8414588dfabafd1e523a69256";
const hash = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const macPrincipals = [...Object.keys(macRolePlan), ...Object.values(macRolePlan)];

async function fixedQueueShape(client) {
  const namespace = (await client.query(`SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner
    FROM pg_namespace n WHERE n.nspname='control_room_queue'`)).rows;
  if (namespace.length === 0) return null;
  try {
    const catalog = {
      namespace,
      relations: (await client.query(`SELECT c.relname, c.relkind, c.relpersistence,
        c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
        pg_get_partkeydef(c.oid) AS partition_key
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='control_room_queue' ORDER BY c.relname`)).rows,
      columns: (await client.query(`SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS type,
        a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin,d.adrelid) AS default_expr
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='control_room_queue' AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attnum`)).rows,
      constraints: (await client.query(`SELECT c.relname, con.conname, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='control_room_queue' ORDER BY c.relname,con.conname`)).rows,
      indexes: (await client.query(`SELECT i.relname, pg_get_indexdef(i.oid) AS definition
        FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
        JOIN pg_namespace n ON n.oid=i.relnamespace
        WHERE n.nspname='control_room_queue' ORDER BY i.relname`)).rows,
      functions: (await client.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
        pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS owner,
        p.prosecdef, p.provolatile
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='control_room_queue' ORDER BY p.proname,arguments`)).rows,
      types: (await client.query(`SELECT t.typname, t.typtype, pg_get_userbyid(t.typowner) AS owner,
        (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid) AS labels
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname='control_room_queue' ORDER BY t.typname`)).rows,
      triggers: (await client.query(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='control_room_queue' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows,
      nonMacGrants: (await client.query(`SELECT kind, object, grantee, privilege, grantable FROM (
        SELECT 'schema' AS kind, n.nspname AS object, coalesce(r.rolname,'PUBLIC') AS grantee,
          a.privilege_type AS privilege, a.is_grantable AS grantable
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='control_room_queue'
        UNION ALL
        SELECT 'relation', c.relname, coalesce(r.rolname,'PUBLIC'), a.privilege_type, a.is_grantable
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
        WHERE n.nspname='control_room_queue'
        UNION ALL
        SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
          coalesce(r.rolname,'PUBLIC'), a.privilege_type, a.is_grantable
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        CROSS JOIN LATERAL aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
        WHERE n.nspname='control_room_queue'
      ) grants WHERE grantee <> ALL($1::text[]) AND grantee <> 'postgres'
      ORDER BY kind,object,grantee,privilege,grantable`,
      [macPrincipals])).rows,
      queues: (await client.query(`SELECT name,policy,retry_limit,retry_delay,retry_backoff,
        retry_delay_max,expire_seconds,retention_seconds,deletion_seconds,dead_letter,
        partition,table_name,heartbeat_seconds,notify,singletons_active
        FROM control_room_queue.queue ORDER BY name`)).rows,
      versions: (await client.query(`SELECT version FROM control_room_queue.version ORDER BY version`)).rows,
    };
    return hash(catalog);
  } catch (error) {
    if (error?.code === "42P01" || error?.code === "42703") throw new Error("upgrade_queue_shape_refused", { cause: error });
    throw error;
  }
}

export async function inspectFixedQueueSchemaV1(client) {
  const digest = await fixedQueueShape(client);
  if (digest === null) return { schemaExists: false };
  if (digest !== expectedShapeDigest) throw new Error("upgrade_queue_shape_refused");
  return { schemaExists: true };
}

async function queueSchemaOid(client) {
  return (await client.query(`SELECT oid::text AS oid FROM pg_namespace
    WHERE nspname='control_room_queue'`)).rows[0]?.oid ?? null;
}

async function removeQueueCreatedByThisAttempt(client, createdOid) {
  await client.query("BEGIN");
  try {
    if (await queueSchemaOid(client) !== createdOid) throw new Error("upgrade_queue_cleanup_refused");
    await client.query(`LOCK TABLE control_room_queue.queue, control_room_queue.job,
      control_room_queue.job_common IN ACCESS EXCLUSIVE MODE`);
    const jobs = (await client.query(`SELECT EXISTS(SELECT 1 FROM control_room_queue.job)
      OR EXISTS(SELECT 1 FROM control_room_queue.job_common) AS present`)).rows[0]?.present;
    if (jobs !== false) throw new Error("upgrade_queue_cleanup_refused");
    await client.query("DROP SCHEMA control_room_queue CASCADE");
    if (await queueSchemaOid(client) !== null) throw new Error("upgrade_queue_cleanup_refused");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function installFixedQueueSchemaV1(client) {
  if ((await fixedQueueShape(client)) !== null) throw new Error("upgrade_queue_existing_refused");
  // pg-boss's construction plan commits itself. A failure before that commit
  // rolls its DDL back; only a committed schema with this attempt's OID may be
  // removed after a later queue-creation or shape-check failure.
  try { await client.query(getConstructionPlans("control_room_queue")); }
  catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
  const createdOid = await queueSchemaOid(client);
  if (createdOid === null) throw new Error("upgrade_queue_shape_refused");
  try {
    const boss = new PgBoss({ db: { executeSql: (sql, values) => client.query(sql, values) },
      schema: "control_room_queue", backend: "postgres", migrate: false, createSchema: false,
      supervise: false, schedule: false, useListenNotify: false });
    await boss.start();
    try { await boss.createQueue("native-task-delivery", { retryLimit: 0 }); }
    finally { await boss.stop({ graceful: false }); }
    if ((await fixedQueueShape(client)) !== expectedShapeDigest) throw new Error("upgrade_queue_shape_refused");
  } catch (error) {
    try { await removeQueueCreatedByThisAttempt(client, createdOid); }
    catch { throw new Error("upgrade_queue_cleanup_refused", { cause: error }); }
    throw error;
  }
}

export async function fixedQueueShapeDigestForTestV1(client) { return fixedQueueShape(client); }
