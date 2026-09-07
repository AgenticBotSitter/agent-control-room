import { createHash } from "node:crypto";
import { verifyPgBossApplicationPermissions } from "../../persistence/pg-boss-application-permissions";
import { verifyPgBossNativeWorkerPermissions } from "../../persistence/pg-boss-native-task-permissions";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import type { PrivatePostgresConfiguration } from "./private-postgres";

// Generated from public-candidate migrations 0001-0058, including generic external-content
// identifiers, using the catalog query below, not a mutable database marker.
export const privateWebSchemaDigest = "1d03ff658c8c413abebca42b783f3bd7e18320b51c24e35fb3c96c8cea712199";
export const privateWebReadTables = ["control_identities", "control_role_grants", "workspaces", "control_web_sessions",
  "adapter_registry", "projects", "control_manual_project_heads", "control_web_project_commands", "audit_events",
  "control_audit_chain_heads", "control_project_lifecycle_events", "control_connection_registry_heads",
  "control_connection_enrollments", "control_connection_authenticated_telemetry_receipts", "control_requests", "control_workflows",
  "control_jobs", "control_attempts", "control_harness_runs", "control_harness_run_events", "control_web_task_commands",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_completion_gate_records", "control_completion_gate_integrity", "control_web_task_review_commands", "control_native_review_plans"] as const;
const inserts = new Set(["control_web_sessions", "adapter_registry", "projects", "control_manual_project_heads",
  "control_web_project_commands", "audit_events", "control_audit_chain_heads", "control_requests", "control_workflows",
  "control_jobs", "control_web_task_commands", "control_completion_gate_records", "control_web_task_review_commands"]);
const updates: Record<string, readonly string[]> = {
  control_identities: ["web_lock"], control_role_grants: ["web_lock"], workspaces: ["web_lock"],
  control_connection_registry_heads: ["web_lock"], control_web_sessions: ["revoked_at"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_completion_gate_records: ["web_lock"],
  projects: ["domain_state", "source_version", "normalized_state", "updated_at"],
  control_manual_project_heads: ["lifecycle", "version", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const fail = () => { throw new Error("private_database_preflight_failed"); };
const coordinatorReads = ["tenants", "workspaces", "control_identities", "control_role_grants", "control_web_sessions",
  "projects", "control_manual_project_heads", "control_requests", "control_workflows", "control_jobs",
  "control_attempts", "control_leases", "control_task_execution_plans", "control_nodes", "control_node_keys",
  "control_node_fleet_current", "control_job_dependencies", "control_transition_events", "control_outbox",
  "audit_events", "control_audit_chain_heads", "control_completion_gate_integrity", "control_completion_gate_records", "control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_harness_runs", "control_harness_run_events", "control_native_review_plans", "control_artifact_manifests", "control_native_artifact_receipts"];
const coordinatorInserts = new Set(["control_web_sessions", "control_requests", "control_workflows", "control_jobs",
  "control_attempts", "control_leases", "control_task_execution_plans", "control_transition_events", "control_outbox",
  "audit_events", "control_audit_chain_heads", "control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts", "control_completion_gate_records"]);
const coordinatorUpdates: Record<string, readonly string[]> = {
  ...Object.fromEntries(["control_requests", "control_workflows", "control_jobs", "control_attempts", "control_leases"]
    .map(table => [table, ["state", "version", "payload", "updated_at"]])),
  ...Object.fromEntries(["tenants", "control_nodes", "control_node_keys", "control_manual_project_heads", "projects"].map(table => [table, ["coordinator_lock"]])),
  ...Object.fromEntries(["control_identities", "control_role_grants", "workspaces", "control_completion_gate_integrity"].map(table => [table, ["web_lock"]])),
  control_web_sessions: ["revoked_at"], control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  control_harness_runs: ["coordinator_lock"], control_completion_gate_records: ["web_lock"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
};
const resultReads = ["workspaces", "control_identities", "control_role_grants", "projects",
  "control_jobs", "control_workflows", "control_requests", "control_task_execution_plans",
  "control_harness_runs", "control_harness_run_events", "control_native_review_plans",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_completion_gate_records",
  "control_completion_gate_integrity", "audit_events", "control_audit_chain_heads"];
const resultInserts = new Set(["control_native_review_plans", "control_completion_gate_records", "audit_events", "control_audit_chain_heads"]);
const resultUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_harness_runs: ["coordinator_lock"], projects: ["coordinator_lock"],
  control_completion_gate_records: ["web_lock"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const evidenceReads = ["workspaces", "control_identities", "control_role_grants", "projects",
  "control_jobs", "control_attempts", "control_leases", "control_harness_runs", "control_harness_run_events",
  "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_artifact_manifests", "control_native_artifact_receipts", "audit_events", "control_audit_chain_heads"];
const evidenceInserts = new Set(["control_harness_runs", "control_harness_run_events", "control_artifact_manifests",
  "control_native_artifact_receipts", "audit_events", "control_audit_chain_heads"]);
const evidenceUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_attempts: ["evidence_lock"], control_leases: ["evidence_lock"], projects: ["coordinator_lock"],
  control_harness_runs: ["state", "last_sequence", "run_digest", "run_auth_tag", "payload", "updated_at", "last_observed_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const sessionReads = ["workspaces", "control_identities", "control_role_grants", "control_nodes", "control_node_keys",
  "node_protocol_connections", "node_protocol_replay"];
const sessionInserts = new Set(["node_protocol_connections", "node_protocol_replay"]);
const sessionUpdates: Record<string, readonly string[]> = {
  node_protocol_connections: ["last_sequence", "last_message_id", "updated_at"], node_protocol_replay: ["replay_lock"],
};

/** Structural fingerprint, independent of OIDs, owners, ACLs and row data. PG17 is the pinned target.
 * Effective permissions are checked separately. Any migrated schema change needs a new reviewed digest.
 */
export async function readPrivateWebSchemaDigest(db: DatabaseSession) {
  const result = await db.query<{ kind: string; name: string; definition: string }>(`
    SELECT * FROM (SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
      json_build_array(c.relkind,a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,c.relrowsecurity,c.relforcerowsecurity)::text AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','S','f')
    UNION ALL SELECT 'constraint', c.relname || '.' || x.conname,
      json_build_array(pg_get_constraintdef(x.oid),x.convalidated)::text
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'index', c.relname, pg_get_indexdef(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i'
    UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname,
      json_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') manifest
    ORDER BY kind COLLATE "C", name COLLATE "C"`);
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

/** Trusted bootstrap choice, never an HTTP permission policy. Omitted stays queue-free. */
export type NativeQueueDatabaseOption = { nativeQueue: true; nativeQueueRecovery?: true };

/** Read-only setup gate; never grants, migrates, creates an owner, or repairs a failed prerequisite. */
export async function verifyPrivateDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "web", queue);
}

/** Exact task-coordinator profile. No request-selected role or caller-supplied permission policy. */
export async function verifyTaskCoordinatorDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "coordinator", queue);
}

/** Fixed, separately owned native-result writer. It cannot plan, dispatch or accept quality. */
export async function verifyNativeResultDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "results", queue);
}

export async function verifyNativeEvidenceDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "evidence", queue);
}

export async function verifyNativeSessionDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "sessions", queue);
}

/** Dedicated operational worker: no canonical-owner reads or application writes.
 * Caller validates connection topology and owns the pool. This check is read-only. */
export async function verifyNativeQueueWorkerDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration) {
  try {
    await db.transaction(async tx => {
      await verifySession(tx, config, "control_room_native_queue_worker");
      await verifyPgBossNativeWorkerPermissions(tx);
      const row = (await tx.query<{ unsafe: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%'
          AND nspname NOT IN ('information_schema','public','control_room_queue'))
        OR EXISTS(SELECT 1 FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
          WHERE a.privilege_type='ALTER SYSTEM' AND (a.grantee=0 OR
            a.grantee IN (SELECT oid FROM pg_roles WHERE pg_has_role(oid,'MEMBER'))))
        OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
          WHERE a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE pg_has_role(oid,'MEMBER')))
        AS unsafe`)).rows[0];
      if (row?.unsafe !== false) fail();
    });
  } catch { fail(); }
}

async function verifySession(tx: DatabaseSession, config: PrivatePostgresConfiguration, role: string) {
  const settings = (await tx.query<{ valid: boolean; database_temp: boolean }>(`SELECT
    current_user=session_user AND current_user=$1 AND current_database()=$2
    AND current_setting('server_version_num')::integer BETWEEN 170000 AND 179999
    AND current_setting('statement_timeout')='5s' AND current_setting('lock_timeout')='2s'
    AND current_setting('transaction_timeout')='10s' AND current_setting('idle_in_transaction_session_timeout')='5s'
    AND current_setting('search_path')='pg_catalog, public' AND current_setting('session_replication_role')='origin'
    AND current_setting('transaction_read_only')='off' AND NOT pg_is_in_recovery()
    AND NOT has_database_privilege(current_database(),'CREATE') AS valid,
    has_database_privilege(current_database(),'TEMP') AS database_temp`, [config.username, config.database])).rows[0];
  if (settings?.valid !== true || settings.database_temp !== false) fail();
  const roles = (await tx.query<{ rolname: string; valid: boolean }>(`SELECT rolname,
    NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AND rolinherit
    AND rolcanlogin=(rolname=current_user) AS valid FROM pg_roles WHERE pg_has_role(oid,'MEMBER') ORDER BY rolname`)).rows;
  if (roles.length !== 2 || roles.some(r => !r.valid)
    || !roles.some(r => r.rolname === config.username) || !roles.some(r => r.rolname === role)) fail();
}

async function verifyDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, kind: "web" | "coordinator" | "results" | "evidence" | "sessions", queue?: NativeQueueDatabaseOption) {
  const withQueue = queue?.nativeQueue === true;
  const role = { web: "control_room_private_web", coordinator: "control_room_task_coordinator", results: "control_room_native_results", evidence: "control_room_native_evidence", sessions: "control_room_native_sessions" }[kind];
  const allowedReads = kind === "sessions" ? sessionReads : kind === "evidence" ? evidenceReads : kind === "results" ? resultReads : kind === "coordinator" ? coordinatorReads : privateWebReadTables;
  const allowedInserts = kind === "sessions" ? sessionInserts : kind === "evidence" ? evidenceInserts : kind === "results" ? resultInserts : kind === "coordinator" ? coordinatorInserts : inserts;
  const allowedUpdates = kind === "sessions" ? sessionUpdates : kind === "evidence" ? evidenceUpdates : kind === "results" ? resultUpdates : kind === "coordinator" ? coordinatorUpdates : updates;
  try {
    await db.transaction(async tx => {
      await verifySession(tx, config, role);
      const unsafe = (await tx.query<{ unsafe: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM pg_auth_members WHERE pg_has_role(member,'MEMBER') AND admin_option)
        OR has_database_privilege(current_database(),'CREATE WITH GRANT OPTION')
        OR has_parameter_privilege('session_replication_role','SET')
        OR EXISTS(SELECT 1 FROM pg_parameter_acl p CROSS JOIN LATERAL aclexplode(p.paracl) a
          WHERE a.privilege_type='ALTER SYSTEM' AND (a.grantee=0 OR
            a.grantee IN (SELECT oid FROM pg_roles WHERE pg_has_role(oid,'MEMBER'))))
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
          AND ((nspname<>'public' AND NOT ($1 AND nspname='control_room_queue')) OR has_schema_privilege(oid,'CREATE') OR pg_has_role(nspowner,'MEMBER')))
        OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND (pg_has_role(c.relowner,'MEMBER') OR c.relkind='S' AND
            (has_sequence_privilege(c.oid,'SELECT') OR has_sequence_privilege(c.oid,'UPDATE') OR has_sequence_privilege(c.oid,'USAGE'))))
        OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
          AND (has_function_privilege(p.oid,'EXECUTE') OR pg_has_role(p.proowner,'MEMBER') OR p.prosecdef))
        OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
          WHERE a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE pg_has_role(oid,'MEMBER')))
        OR NOT has_schema_privilege('public','USAGE') AS unsafe`, [withQueue])).rows[0];
      if (unsafe?.unsafe !== false) fail();
      if (withQueue) await verifyPgBossApplicationPermissions(tx, kind === "coordinator", kind === "coordinator" && queue?.nativeQueueRecovery === true);
      const columns = (await tx.query<{ table_name: string; column_name: string; read: boolean; insert: boolean; update: boolean; extra: boolean }>(`
        SELECT c.relname AS table_name,a.attname AS column_name,
          has_column_privilege(c.oid,a.attnum,'SELECT') AS read,
          has_column_privilege(c.oid,a.attnum,'INSERT') AS insert,
          has_column_privilege(c.oid,a.attnum,'UPDATE') AS update,
          has_column_privilege(c.oid,a.attnum,'REFERENCES')
          OR has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'INSERT WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'UPDATE WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'REFERENCES WITH GRANT OPTION')
          OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE')
          OR has_table_privilege(c.oid,'TRIGGER') OR has_table_privilege(c.oid,'MAINTAIN') AS extra
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped`)).rows;
      const reads: ReadonlySet<string> = new Set(allowedReads);
      if (!columns.length || columns.some(c => c.extra || c.read !== reads.has(c.table_name)
        || c.insert !== allowedInserts.has(c.table_name) || c.update !== !!allowedUpdates[c.table_name]?.includes(c.column_name))) fail();
      if (await readPrivateWebSchemaDigest(tx) !== privateWebSchemaDigest) fail();
      const binding = (await tx.query<{ valid: boolean }>(`SELECT EXISTS(SELECT 1 FROM workspaces w
        JOIN control_identities i ON i.tenant_id=w.tenant_id JOIN control_role_grants g ON g.tenant_id=i.tenant_id AND g.identity_id=i.id
        WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3 AND i.auth_provider=$4 AND i.actor_type='human' AND i.state='active'
        AND g.role_key='owner' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>$5)
        AND g.project_ids @> '["*"]'::jsonb AND g.allowed_actions @> '["*"]'::jsonb AND NOT g.require_strong_factor) AS valid`,
      [scope.tenantId, scope.workspaceId, scope.ownerIdentityId, scope.issuer, new Date(now).toISOString()])).rows[0];
      if (binding?.valid !== true) fail();
    });
  } catch { fail(); }
}
