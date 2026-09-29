import { createHash } from "node:crypto";
import { verifyPgBossApplicationPermissions } from "../../persistence/pg-boss-application-permissions";
import { verifyPgBossNativeWorkerPermissions } from "../../persistence/pg-boss-native-task-permissions";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import type { PrivatePostgresConfiguration } from "./private-postgres";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";

/** Optional authoring prerequisite, read through the existing web role.
 * Registration is operator setup, never a startup repair or connectivity claim. */
export async function verifyPrivateIdeaAdapter(db: DatabaseClient, scope: { tenantId: string }) {
  const rows = (await db.query<{ valid: boolean }>(`SELECT tenant_id=$2 AND
    source_system='control_room_native_ideas' AND contract_version='1.0.0' AND
    authority_mode='control_room_native' AND status <> 'disabled' AS valid
    FROM adapter_registry WHERE id=$1`, [CONTROL_ROOM_IDEA_ADAPTER_V1, scope.tenantId])).rows;
  if (rows.length !== 1 || rows[0].valid !== true) throw new Error("private_idea_adapter_unavailable");
}

// Generated from public migrations 0001-0109 (filename order: ...0093,0100,0101,0102,0104,0105,0106,0108,0109),
// including generic external-content migrations 0025/0026, read from a live
// PostgreSQL 17 cluster installed the production way. Catalog query below;
// not a mutable database marker.
export const privateWebSchemaDigest = "6d3f3a1a7d9de59d63790a1a3e6a10501f37099b551391f636aa963fc706d3d5";
export const privateWebReadTables = ["control_identities", "control_role_grants", "workspaces", "control_web_sessions",
  "tenants", "control_idempotency",
  "control_schedules", "control_schedule_occurrences",
  "control_news_story_versions", "control_news_source_observations", "control_news_source_settings", "control_news_story_archives", "control_news_article_details",
  "control_idea_sessions", "control_idea_contributions", "control_idea_syntheses", "control_idea_decisions", "control_idea_bot_run_events",
  "control_idea_canonical_task_sessions", "control_idea_canonical_task_links",
  "adapter_registry", "projects", "control_manual_project_heads", "control_web_project_commands", "audit_events",
  "control_audit_chain_heads", "work_intake_tenant_binding", "control_project_lifecycle_events", "control_policy_decisions", "control_connection_registry_heads",
  "control_connection_enrollments", "control_connection_authenticated_telemetry_receipts", "control_requests", "control_workflows",
  "control_jobs", "control_attempts", "control_leases", "control_task_execution_plans", "control_harness_runs", "control_harness_run_events", "control_web_task_commands",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_completion_gate_records", "control_completion_gate_integrity", "control_web_task_review_commands", "control_native_review_plans",
  "control_project_coordinator_heads", "control_project_coordination_proposals", "control_project_delegation_policies",
  "control_project_coordination_operation_receipts", "control_project_coordination_operation_jobs",
  "control_project_event_stream_heads", "control_project_events",
  "control_work_resources", "control_attempt_resource_admissions", "control_attempt_resource_scopes",
  "control_task_model_selections", "control_task_declared_scopes", "control_assignment_lease_scopes",
  "control_durable_result_write_reservations", "work_batches", "work_batch_revisions", "work_batch_items",
  "work_batch_queue_admissions", "work_batch_effective_queue_admissions", "work_batch_agent_queue_heads",
  "control_native_task_queue", "control_job_dependencies",
  "pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs",
  "pipeline_unattended_transitions",
  "control_pipeline_build_publications", "control_codex_result_publications",
  "control_action_inbox", "control_project_settings"] as const;
const inserts = new Set(["control_web_sessions", "adapter_registry", "projects", "control_manual_project_heads",
  "control_web_project_commands", "audit_events", "control_audit_chain_heads", "control_requests", "control_workflows",
  "control_jobs", "control_web_task_commands", "control_idea_canonical_task_sessions", "control_idea_canonical_task_links",
  "control_completion_gate_records", "control_web_task_review_commands", "control_news_source_settings", "control_news_story_archives",
  "control_policy_decisions", "control_project_lifecycle_events", "control_project_coordinator_heads",
  "control_project_delegation_policies", "control_task_model_selections", "control_task_declared_scopes"]);
inserts.add("work_batch_revisions"); inserts.add("work_batch_items");
inserts.add("work_batch_queue_admissions"); inserts.add("work_batch_agent_queue_heads");
inserts.add("pipeline_templates"); inserts.add("pipeline_runs"); inserts.add("pipeline_stage_runs");
inserts.add("control_job_dependencies");
inserts.add("control_project_settings"); inserts.add("pipeline_unattended_transitions");

/** Tables whose INSERT grant is column-scoped rather than table-wide. Every
 * listed column must carry INSERT and every unlisted column must not — a
 * table-wide INSERT grant on one of these tables fails the check. */
export const privateWebInsertColumns: Record<string, readonly string[]> = {
  control_idempotency: ["tenant_id", "operation_scope", "idempotency_key", "request_digest", "status"],
};
/** Tables whose SELECT grant is column-scoped: the project coordination
 * page's attention and dependency reads. Listed columns must be readable and
 * every unlisted column must not be; a table-wide SELECT fails the check. */
export const privateWebReadColumns: Record<string, readonly string[]> = {
  attention_items: ["id", "tenant_id", "project_id", "attention_type", "title", "summary", "due_at", "observed_at",
    "work_item_id"],
  control_job_dependencies: ["tenant_id", "job_id", "depends_on_job_id"],
};
const updates: Record<string, readonly string[]> = {
  control_identities: ["web_lock"], control_role_grants: ["web_lock"], workspaces: ["web_lock"],
  control_connection_registry_heads: ["web_lock"], control_web_sessions: ["revoked_at"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_completion_gate_records: ["web_lock"],
  control_jobs: ["web_lock", "stage_kind", "stage_ordinal", "pipeline_run_id"],
  projects: ["domain_state", "source_version", "normalized_state", "updated_at", "payload", "observed_at"],
  control_manual_project_heads: ["lifecycle", "version", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  control_project_coordinator_heads: ["state", "coordinator_identity_id", "coordinator_actor_type", "executor_id", "adapter_id",
    "connector_profile_digest", "execution_binding_digest", "assigned_by_owner_identity_id", "version",
    "assigned_at", "updated_at", "revoked_at", "payload"],
  control_project_delegation_policies: ["state", "version", "updated_at"],
  control_idempotency: ["status", "result", "completed_at"],
  control_action_inbox: ["state", "payload"],
  work_batches: ["state", "approval_identity_id", "approved_at", "decision_reason_code", "decision_digest",
    "decision_auth_tag", "version", "updated_at"],
  work_batch_agent_queue_heads: ["next_position", "updated_at"],
  pipeline_templates: ["may_advance_unattended", "version", "updated_at", "record_digest", "auth_tag"],
  pipeline_runs: ["unattended", "state", "started_at", "updated_at", "version", "template_version", "template_digest",
    "record_digest", "auth_tag"],
  tenants: ["coordinator_lock"],
  control_project_settings: ["eligible_worker_kinds", "max_concurrent_tasks", "default_worker_kind",
    "default_model", "default_effort", "version", "updated_by_identity_id", "updated_at"],
};
const fail = () => { throw new Error("private_database_preflight_failed"); };
const ideaCreationReads = ["workspaces", "control_identities", "control_role_grants", "control_web_sessions",
  "control_idea_sessions", "control_idea_bot_run_events", "control_idea_contributions", "control_idea_syntheses",
  "control_idea_decisions", "control_idea_owner_authorizations", "control_policy_decisions", "projects",
  "control_project_lifecycle_events", "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding"];
const ideaCreationInserts = new Set(["control_web_sessions", "control_idea_sessions", "control_idea_bot_run_events", "audit_events", "control_audit_chain_heads",
  "control_policy_decisions", "control_idea_owner_authorizations", "control_idea_decisions", "projects", "control_project_lifecycle_events", "control_idea_syntheses"]);
const ideaCreationUpdates: Record<string, readonly string[]> = { workspaces: ["web_lock"], control_identities: ["web_lock"],
  control_role_grants: ["web_lock"], control_web_sessions: ["revoked_at"], control_audit_chain_heads: ["head_hash", "event_count", "updated_at"] };
const ideaRuntimeReads = ["workspaces", "control_identities", "control_role_grants", "control_idea_sessions",
  "control_idea_contributions", "control_idea_bot_run_events", "control_idea_decisions"];
const ideaRuntimeInserts = new Set(["control_idea_contributions", "control_idea_bot_run_events"]);
const ideaRuntimeUpdates: Record<string, readonly string[]> = { workspaces: ["web_lock"] };
const newsIngestionReads = ["workspaces", "projects", "control_identities", "control_role_grants", "control_news_story_versions", "control_news_source_observations", "control_news_discovery_baselines", "control_news_source_settings", "control_news_story_archives", "control_news_article_details"];
const newsIngestionInserts = new Set(["control_news_story_versions", "control_news_source_observations", "control_news_discovery_baselines", "control_news_article_details"]);
const newsIngestionUpdates: Record<string, readonly string[]> = { workspaces: ["web_lock"], projects: ["coordinator_lock"] };
const newsCoordinatorReads = ["tenants", "workspaces", "projects", "control_manual_project_heads", "control_identities", "control_role_grants",
  "control_web_sessions", "control_requests", "control_workflows", "control_jobs", "control_attempts", "control_leases", "control_nodes",
  "control_job_dependencies", "control_transition_events", "control_outbox", "control_approvals", "control_effect_intents",
  "control_approval_consumptions", "control_policy_decisions", "control_news_feed_plans", "control_news_source_settings", "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding"];
const newsCoordinatorInserts = new Set(["control_web_sessions", "control_requests", "control_workflows", "control_jobs", "control_attempts",
  "control_leases", "control_transition_events", "control_outbox", "control_approvals", "control_effect_intents", "control_approval_consumptions",
  "control_policy_decisions", "control_news_feed_plans", "audit_events", "control_audit_chain_heads"]);
const newsCoordinatorUpdates: Record<string, readonly string[]> = {
  ...Object.fromEntries(["control_jobs", "control_attempts", "control_leases", "control_approvals", "control_effect_intents"].map(table => [table, ["state", "version", "payload", "updated_at"]])),
  ...Object.fromEntries(["tenants", "projects", "control_manual_project_heads", "control_nodes"].map(table => [table, ["coordinator_lock"]])),
  ...Object.fromEntries(["workspaces", "control_identities", "control_role_grants"].map(table => [table, ["web_lock"]])),
  control_web_sessions: ["revoked_at"], control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const coordinatorReads = ["tenants", "workspaces", "control_identities", "control_role_grants", "control_web_sessions",
  "projects", "control_manual_project_heads", "control_requests", "control_workflows", "control_jobs",
  "control_attempts", "control_leases", "control_task_execution_plans", "control_nodes", "control_node_keys",
  "control_node_fleet_current", "control_node_fleet_signals", "control_job_dependencies", "control_transition_events", "control_outbox",
  "control_installation_transition_revisions",
  "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding", "control_completion_gate_integrity", "control_completion_gate_records", "control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_codex_delivery_envelopes", "control_codex_transmission_intents", "control_codex_delivery_receipts", "control_codex_activation_transmission_intents", "control_worker_delivery_receipts",
  "control_codex_result_publications",
  "control_harness_runs", "control_harness_run_events", "control_native_review_plans", "control_artifact_manifests", "control_native_artifact_receipts",
  "control_action_inbox", "control_project_coordinator_heads", "control_project_coordination_proposals",
  "control_project_delegation_policies", "control_project_coordination_operation_receipts",
  "control_project_coordination_operation_jobs", "control_work_resources",
  "control_attempt_resource_admissions", "control_attempt_resource_scopes", "control_task_model_selections",
  "control_task_declared_scopes", "control_assignment_lease_scopes", "work_batches", "work_batch_items",
  "work_batch_effective_queue_admissions"];
const coordinatorInserts = new Set(["control_web_sessions", "control_requests", "control_workflows", "control_jobs",
  "control_attempts", "control_leases", "control_task_execution_plans", "control_transition_events", "control_outbox",
  "audit_events", "control_audit_chain_heads", "control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_codex_delivery_envelopes", "control_codex_transmission_intents", "control_codex_delivery_receipts", "control_worker_delivery_receipts",
  "control_codex_activation_transmission_intents", "control_completion_gate_records",
  "control_project_coordination_proposals", "control_project_coordination_operation_receipts",
  "control_project_coordination_operation_jobs", "control_action_inbox", "control_work_resources",
  "control_attempt_resource_admissions", "control_attempt_resource_scopes", "control_job_dependencies",
  "control_installation_transition_revisions", "control_node_fleet_signals", "control_node_fleet_current",
  "control_task_model_selections", "control_task_declared_scopes", "control_assignment_lease_scopes"]);
coordinatorReads.push("pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs",
  "pipeline_unattended_transitions", "pipeline_advance_receipts",
  "control_agent_review_plans", "control_pipeline_build_publications");
coordinatorInserts.add("control_agent_review_plans");
coordinatorInserts.add("control_pipeline_build_publications");
coordinatorInserts.add("pipeline_advance_receipts");
const coordinatorDeletes = new Set(["control_assignment_lease_scopes"]);
const coordinatorUpdates: Record<string, readonly string[]> = {
  ...Object.fromEntries(["control_requests", "control_workflows", "control_attempts", "control_leases"]
    .map(table => [table, ["state", "version", "payload", "updated_at"]])),
  control_jobs: ["state", "version", "payload", "updated_at", "stage_kind", "stage_ordinal", "pipeline_run_id"],
  ...Object.fromEntries(["tenants", "control_nodes", "control_node_keys", "control_manual_project_heads", "projects", "control_node_fleet_signals"].map(table => [table, ["coordinator_lock"]])),
  control_node_fleet_current: ["signal_sequence", "fingerprint", "trust", "observed_at", "expires_at", "payload"],
  ...Object.fromEntries(["control_identities", "control_role_grants", "workspaces", "control_completion_gate_integrity"].map(table => [table, ["web_lock"]])),
  control_web_sessions: ["revoked_at"], control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  control_harness_runs: ["coordinator_lock"], control_worker_delivery_receipts: ["coordinator_lock"], control_completion_gate_records: ["web_lock"],
  control_native_artifact_receipts: ["coordinator_lock"], control_native_review_plans: ["coordinator_lock"],
  control_project_coordinator_heads: ["coordinator_lock"],
  control_project_coordination_proposals: ["coordinator_lock"],
  control_project_delegation_policies: ["coordinator_lock"],
  control_project_coordination_operation_receipts: ["coordinator_lock"],
  control_project_coordination_operation_jobs: ["coordinator_lock"],
  control_work_resources: ["coordinator_lock"],
  control_attempt_resource_admissions: ["state", "version", "retired_at", "retirement_kind", "retirement_proof_digest"],
  control_attempt_resource_scopes: ["coordinator_lock"],
  pipeline_runs: ["state", "completed_at", "current_stage_ordinal", "updated_at", "version", "record_digest", "auth_tag",
    "unattended_last_swept_at"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
};
const resultReads = ["workspaces", "control_identities", "control_role_grants", "projects",
  "control_jobs", "control_workflows", "control_requests", "control_task_execution_plans",
  "control_attempts", "control_task_model_selections",
  "control_harness_runs", "control_harness_run_events", "control_codex_result_publications", "control_native_review_plans",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_completion_gate_records",
  "control_completion_gate_integrity", "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding", "control_idea_sessions",
  "control_idea_canonical_task_links", "control_idea_contributions", "control_idea_decisions"];
const resultInserts = new Set(["control_native_review_plans", "control_completion_gate_records", "audit_events", "control_audit_chain_heads",
  "control_idea_contributions"]);
const resultUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_harness_runs: ["coordinator_lock"], projects: ["coordinator_lock"],
  control_completion_gate_records: ["web_lock"],
  control_native_review_plans: ["results_lock"], control_native_artifact_receipts: ["results_lock"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const evidenceReads = ["workspaces", "control_identities", "control_role_grants", "projects", "control_manual_project_heads",
  "control_jobs", "control_attempts", "control_leases", "control_nodes", "control_node_keys", "control_harness_runs", "control_harness_run_events",
  "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_worker_delivery_receipts", "control_worktree_change_audit_plans", "control_worktree_change_audit_records",
  "control_task_execution_plans", "control_codex_activation_transmission_intents", "control_codex_result_publications",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_native_result_write_reservations",
  "control_durable_result_write_reservations",
  "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding"];
const evidenceInserts = new Set(["control_harness_runs", "control_harness_run_events", "control_codex_result_publications", "control_artifact_manifests",
  "control_native_artifact_receipts", "control_native_result_write_reservations",
  "control_worktree_change_audit_plans", "control_worktree_change_audit_records",
  "control_durable_result_write_reservations", "audit_events", "control_audit_chain_heads"]);
const evidenceUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_attempts: ["evidence_lock"], control_leases: ["evidence_lock"],
  projects: ["coordinator_lock"], control_manual_project_heads: ["coordinator_lock"],
  control_nodes: ["coordinator_lock"], control_node_keys: ["coordinator_lock"],
  control_harness_runs: ["state", "last_sequence", "run_digest", "run_auth_tag", "payload", "updated_at", "last_observed_at"],
  control_native_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_durable_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
const sessionReads = ["workspaces", "control_identities", "control_role_grants", "control_nodes", "control_node_keys",
  "node_protocol_connections", "node_protocol_replay"];
const sessionInserts = new Set(["node_protocol_connections", "node_protocol_replay"]);
const sessionUpdates: Record<string, readonly string[]> = {
  node_protocol_connections: ["last_sequence", "last_message_id", "updated_at"], node_protocol_replay: ["replay_lock"],
};
/** Fifth Mac-local login (owner decision 2026-09-25): exactly the rights
 * `createOwnerTrustedLocalCliPublishV1` (run registration + `workflowIdForJob`)
 * and `publishDurableResultV1` (with the durable reservation Postgres port)
 * execute in one transaction. Review-tray registration stays on `results`. */
const publisherReads = ["workspaces", "control_identities", "control_role_grants", "control_jobs", "control_attempts", "adapter_registry",
  "control_task_model_selections",
  "control_harness_runs", "control_harness_run_events", "control_artifact_manifests", "control_native_artifact_receipts",
  "control_durable_result_write_reservations", "control_native_review_plans",
  "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding"];
const publisherInserts = new Set(["control_harness_runs", "control_harness_run_events", "control_artifact_manifests", "control_native_artifact_receipts",
  "control_durable_result_write_reservations", "control_native_review_plans",
  "audit_events", "control_audit_chain_heads"]);
const publisherUpdates: Record<string, readonly string[]> = {
  control_harness_runs: ["publisher_lock", "state", "last_sequence", "run_digest", "run_auth_tag", "payload", "updated_at", "last_observed_at"], control_native_review_plans: ["publisher_lock"],
  control_durable_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
};
// The reviewer holds no table privilege: it reads and commits only through
// read_agent_review_plan and commit_agent_review, pinned below.
const agentReviewerReads: readonly string[] = [];
const agentReviewerInserts = new Set<string>();
const agentReviewerUpdates: Record<string, readonly string[]> = {};

/** Structural fingerprint, independent of OIDs, owners, ACLs and row data. PG17 is the pinned target.
 * Effective permissions are checked separately. Any migrated schema change needs a new reviewed digest.
 * The production migration ledger (`control_room_schema_migrations`, created by
 * deploy/postgres/apply-migrations.mjs and owned by the schema owner) is not part of the application
 * schema: its columns, constraints and indexes are omitted, as deploy/postgres/evidence.mjs already
 * does. Only that exact schema-owner-owned table is omitted; triggers on it still count, and a
 * look-alike with any other owner or kind changes the digest.
 */
export async function readPrivateWebSchemaDigest(db: DatabaseSession) {
  const result = await db.query<{ kind: string; name: string; definition: string }>(`
    WITH ledger AS (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='control_room_schema_migrations' AND c.relkind='r'
        AND pg_get_userbyid(c.relowner)='control_room_schema_owner')
    SELECT * FROM (SELECT 'column' AS kind, c.relname || '.' || a.attname AS name,
      json_build_array(c.relkind,a.attnum,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,c.relrowsecurity,c.relforcerowsecurity)::text AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','S','f')
      AND c.oid IS DISTINCT FROM (SELECT oid FROM ledger)
    UNION ALL SELECT 'constraint', c.relname || '.' || x.conname,
      json_build_array(pg_get_constraintdef(x.oid),x.convalidated)::text
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.oid IS DISTINCT FROM (SELECT oid FROM ledger)
    UNION ALL SELECT 'index', c.relname, pg_get_indexdef(c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='i'
      AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=c.oid AND i.indrelid=(SELECT oid FROM ledger))
    UNION ALL SELECT 'trigger', c.relname || '.' || t.tgname,
      json_build_array(pg_get_triggerdef(t.oid),t.tgenabled)::text
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT 'policy', c.relname || '.' || p.polname,
      json_build_array(p.polcmd,p.polpermissive,
        ARRAY(SELECT CASE r WHEN 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY 1),
        pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))::text
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') manifest
    ORDER BY kind COLLATE "C", name COLLATE "C"`);
  return createHash("sha256").update(JSON.stringify(result.rows)).digest("hex");
}

/** Trusted bootstrap choice, never an HTTP permission policy. Omitted stays queue-free. */
export type NativeQueueDatabaseOption = { nativeQueue: true; nativeQueueRecovery?: true;
  /** Queue schema is present for news, but native task submission is not enabled. */
  nativeQueueProducer?: false };
export type NewsQueueDatabaseOption = { newsQueue: true };

/** Read-only setup gate; never grants, migrates, creates an owner, or repairs a failed prerequisite. */
export async function verifyPrivateDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "web", queue);
}

/** Owner Idea commands: no participant result, job, queue or provider execution writes. */
export async function verifyIdeaCreationDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "ideas", queue);
}

/** Canonical news coordination; feed submission privileges require explicit configuration. */
export async function verifyNewsCoordinatorDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption | NewsQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "newsCoordinator", queue);
}

/** News observations only. Cannot create projects, authorize proposals or dispatch jobs. */
export async function verifyNewsIngestionDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "newsIngestion", queue);
}

/** Discussion writer only. Cannot create sessions, authorize decisions or dispatch jobs. */
export async function verifyIdeaRuntimeDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "ideaRuntime", queue);
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

/** Fifth Mac-local login: the local result publisher. It cannot plan, dispatch,
 * accept quality, or register the review tray (that stays on `results`). */
export async function verifyLocalResultPublisherDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "publisher", queue);
}

/** Agent checker commit role: one authenticated plan join plus Completion Gate
 * append/integrity writes, with no task, queue, lease or owner authority. */
export async function verifyAgentReviewerDatabase(db: DatabaseClient, config: PrivatePostgresConfiguration,
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number,
  queue?: NativeQueueDatabaseOption) {
  return verifyDatabase(db, config, scope, now, "agentReviewer", queue);
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
  scope: { tenantId: string; workspaceId: string; ownerIdentityId: string; issuer: string }, now: number, kind: "web" | "coordinator" | "results" | "evidence" | "publisher" | "agentReviewer" | "sessions" | "ideas" | "ideaRuntime" | "newsIngestion" | "newsCoordinator", queue?: NativeQueueDatabaseOption | NewsQueueDatabaseOption) {
  const feedProducer = kind === "newsCoordinator" && !!queue && "newsQueue" in queue && queue.newsQueue === true;
  const withQueue = feedProducer || !!queue && "nativeQueue" in queue && queue.nativeQueue === true;
  const recovery = kind === "coordinator" && !!queue && "nativeQueueRecovery" in queue && queue.nativeQueueRecovery === true;
  const role = { web: "control_room_private_web", coordinator: "control_room_task_coordinator", results: "control_room_native_results", evidence: "control_room_native_evidence", publisher: "control_room_local_result_publisher", agentReviewer: "control_room_agent_reviewer", sessions: "control_room_native_sessions", ideas: "control_room_idea_creation", ideaRuntime: "control_room_idea_runtime", newsIngestion: "control_room_news_ingestion", newsCoordinator: "control_room_news_coordinator" }[kind];
  const allowedReads = kind === "agentReviewer" ? agentReviewerReads : kind === "newsCoordinator" ? newsCoordinatorReads : kind === "newsIngestion" ? newsIngestionReads : kind === "ideaRuntime" ? ideaRuntimeReads : kind === "ideas" ? ideaCreationReads : kind === "sessions" ? sessionReads : kind === "publisher" ? publisherReads : kind === "evidence" ? evidenceReads : kind === "results" ? resultReads : kind === "coordinator" ? coordinatorReads : privateWebReadTables;
  const allowedInserts = kind === "agentReviewer" ? agentReviewerInserts : kind === "newsCoordinator" ? newsCoordinatorInserts : kind === "newsIngestion" ? newsIngestionInserts : kind === "ideaRuntime" ? ideaRuntimeInserts : kind === "ideas" ? ideaCreationInserts : kind === "sessions" ? sessionInserts : kind === "publisher" ? publisherInserts : kind === "evidence" ? evidenceInserts : kind === "results" ? resultInserts : kind === "coordinator" ? coordinatorInserts : inserts;
  const allowedUpdates = kind === "agentReviewer" ? agentReviewerUpdates : kind === "newsCoordinator" ? newsCoordinatorUpdates : kind === "newsIngestion" ? newsIngestionUpdates : kind === "ideaRuntime" ? ideaRuntimeUpdates : kind === "ideas" ? ideaCreationUpdates : kind === "sessions" ? sessionUpdates : kind === "publisher" ? publisherUpdates : kind === "evidence" ? evidenceUpdates : kind === "results" ? resultUpdates : kind === "coordinator" ? coordinatorUpdates : updates;
  const allowedDeletes = kind === "coordinator" ? coordinatorDeletes : new Set<string>();
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
          AND (pg_has_role(p.proowner,'MEMBER') OR (has_function_privilege(p.oid,'EXECUTE') OR p.prosecdef) AND NOT (
            (p.oid='is_work_intake_session()'::regprocedure
              AND p.prosecdef AND p.provolatile='s' AND p.prokind='f' AND p.prorettype='boolean'::regtype
              AND p.pronargs=0 AND NOT p.proleakproof AND p.proparallel='u'
              AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql')
              AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
              AND NOT has_function_privilege('public',p.oid,'EXECUTE')
              AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND (a.is_grantable OR a.grantee=0
                  OR pg_get_userbyid(a.grantee) NOT IN ('control_room_application','control_room_reader','control_room_backup',
                    'control_room_work_intake','control_room_private_web','control_room_task_coordinator',
                    'control_room_native_results','control_room_native_evidence','control_room_local_result_publisher',
                    'control_room_idea_creation','control_room_news_coordinator'))))
            OR (p.oid IN ('commit_agent_review(text,jsonb,jsonb,bytea)'::regprocedure,'read_agent_review_plan(text)'::regprocedure)
              AND NOT has_function_privilege('public',p.oid,'EXECUTE')
              AND (($2 AND p.prosecdef AND pg_get_userbyid(p.proowner)='control_room_schema_owner'
                AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
                AND NOT p.proleakproof AND p.proparallel='u'
                AND p.provolatile=CASE WHEN p.oid='read_agent_review_plan(text)'::regprocedure THEN 's' ELSE 'v' END)
                OR (NOT $2 AND NOT has_function_privilege(p.oid,'EXECUTE')))))))
        OR ($2 AND EXISTS (SELECT 1 FROM unnest(ARRAY['commit_agent_review(text,jsonb,jsonb,bytea)',
            'read_agent_review_plan(text)']::regprocedure[]) boundary(oid)
          WHERE NOT (has_function_privilege(boundary.oid,'EXECUTE')
            AND NOT has_function_privilege('public',boundary.oid,'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM pg_proc function_acl
              CROSS JOIN LATERAL aclexplode(COALESCE(function_acl.proacl,acldefault('f',function_acl.proowner))) acl
              WHERE function_acl.oid=boundary.oid
                AND (acl.privilege_type<>'EXECUTE'
                  OR acl.grantee NOT IN (function_acl.proowner,
                    (SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer'))
                  OR acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer')
                    AND acl.is_grantable))
            AND 1=(SELECT count(*) FROM pg_proc function_acl
              CROSS JOIN LATERAL aclexplode(COALESCE(function_acl.proacl,acldefault('f',function_acl.proowner))) acl
              WHERE function_acl.oid=boundary.oid
                AND acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='control_room_agent_reviewer')
                AND acl.privilege_type='EXECUTE' AND NOT acl.is_grantable))))
        OR EXISTS(SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
          WHERE a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE pg_has_role(oid,'MEMBER')))
        OR NOT has_schema_privilege('public','USAGE') AS unsafe`, [withQueue,kind === "agentReviewer"])).rows[0];
      if (unsafe?.unsafe !== false) fail();
      if (withQueue) await verifyPgBossApplicationPermissions(tx,
        kind === "coordinator" && !(queue && "nativeQueueProducer" in queue && queue.nativeQueueProducer === false) || feedProducer, recovery);
      const columns = (await tx.query<{ table_name: string; column_name: string; read: boolean; insert: boolean; update: boolean; remove: boolean; extra: boolean }>(`
        SELECT c.relname AS table_name,a.attname AS column_name,
          has_column_privilege(c.oid,a.attnum,'SELECT') AS read,
          has_column_privilege(c.oid,a.attnum,'INSERT') AS insert,
          has_column_privilege(c.oid,a.attnum,'UPDATE') AS update,
          has_table_privilege(c.oid,'DELETE') AS remove,
          has_column_privilege(c.oid,a.attnum,'REFERENCES')
          OR has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'INSERT WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'UPDATE WITH GRANT OPTION')
          OR has_column_privilege(c.oid,a.attnum,'REFERENCES WITH GRANT OPTION')
          OR has_table_privilege(c.oid,'TRUNCATE')
          OR has_table_privilege(c.oid,'TRIGGER') OR has_table_privilege(c.oid,'MAINTAIN') AS extra
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped`)).rows;
      const reads: ReadonlySet<string> = new Set(allowedReads);
      // Column-scoped INSERT grants (currently the web role's idempotency
      // ledger): listed columns must carry INSERT, unlisted must not.
      const scopedInserts = kind === "web" ? privateWebInsertColumns : {};
      const scopedReads = kind === "web" ? privateWebReadColumns : {};
      if (!columns.length || columns.some(c => c.extra
        || c.read !== (reads.has(c.table_name) || !!scopedReads[c.table_name]?.includes(c.column_name))
        || c.insert !== (allowedInserts.has(c.table_name) || !!scopedInserts[c.table_name]?.includes(c.column_name))
        || c.update !== !!allowedUpdates[c.table_name]?.includes(c.column_name)
        || c.remove !== allowedDeletes.has(c.table_name))) fail();
      if (await readPrivateWebSchemaDigest(tx) !== privateWebSchemaDigest) fail();
      if (kind === "agentReviewer") return;
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
