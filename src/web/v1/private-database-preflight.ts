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


// Generated from public migrations through 0237 (filename order, including assigned gaps, 0110-0111, 0155-0157 and 0160-0162),
// including generic external-content migrations 0025/0026, by the controlled
// PGlite digest script. Recomputed for the fix round after 0206's quota guard
// gained its per-tenant advisory lock, 0207's producer guard was corrected, and
// 0207's acceptance guard gained the owner check on discarding a set; then again
// after 0230 gave the acceptance guard a NAMED rejection arm and the plan's
// 90-day sweep, which closed the review's S3 (an unaccepted set was previously
// undisposable by anyone, the superuser included). The pre-0230 digest was
// re-derived with 0230 removed and matched the previous value exactly, so this
// change is 0230's and only 0230's. Recomputed once more after 0209-0211 (the
// upload sessions, the publication receipt and the combine-input bindings) were
// merged onto the ledger cook/v1 had reached at 0237; catalog query below; not a
// mutable database marker.
// Recomputed once more after 0210's stored-set guard was corrected to key on
// `producer_kind` rather than `source_kind`, so the digest records THAT and not
// 0209-0211's arrival alone.
export const privateWebSchemaDigest = "f6be955079d2065915b378ff3c62529da47036412368483c02653a11b604ef45";
/** Fleet tables the web login may read. These grants live in fleet_gateway_roles.sql, so they exist
 * only where the fleet gateway is installed; the Mac-local install has no fleet gateway at all.
 * `verifyDatabase` applies them conditionally, which keeps both shapes exact: with the gateway
 * the web login must hold exactly SELECT, and without it the web login must hold nothing,
 * because the column audit still compares every column against the live grant, so an
 * unexpected fleet grant is refused either way. */
export const privateWebFleetReadTables = ["fleet_enrollment_codes", "fleet_workers", "fleet_worker_credentials",
  "fleet_worker_presence", "fleet_work_offers", "fleet_enrollment_redemptions", "fleet_claims", "fleet_worker_events",
  "fleet_results", "fleet_result_files", "fleet_result_reviews"] as const;
export const privateWebReadTables = ["control_identities", "control_role_grants", "workspaces", "control_web_sessions",
  "tenants", "control_idempotency",
  "control_schedules", "control_schedule_occurrences",
  "control_news_story_versions", "control_news_source_observations", "control_news_source_settings", "control_news_story_archives", "control_news_article_details", "control_news_task_proposal_links",
  "control_idea_sessions", "control_idea_contributions", "control_idea_syntheses", "control_idea_decisions", "control_idea_bot_run_events",
  "control_idea_canonical_task_sessions", "control_idea_canonical_task_links", "control_idea_promotion_task_links",
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
  "work_batch_intake_flag_dismissals",
  "control_skills", "control_skill_versions", "control_task_skill_bindings", "control_recurring_rules",
  "work_batch_queue_admissions", "work_batch_effective_queue_admissions", "work_batch_agent_queue_heads",
  "control_native_task_queue", "control_job_dependencies",
  "pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs",
  "pipeline_unattended_transitions",
  "pipeline_installation_allowances", "pipeline_machine_capacity_observations",
  "control_pipeline_build_publications", "control_codex_result_publications",
  "control_action_inbox", "control_project_settings", "owner_web_push_subscriptions", "owner_web_push_deliveries", "control_improvement_requests", "control_update_candidates", "control_update_candidate_decisions", "control_news_task_proposal_links",
  // MIG-I: the per-item push retry head. The dispatcher reads its own rows to
  // notice, claim and settle, and holds nothing else on it. Listed here because
  // 0226 grants SELECT on it, and the column audit compares the live grant
  // against this list -- a grant the preflight does not know about is a
  // preflight failure, not a lenient pass.
  "control_owner_push_attempt_heads",
  // 0155-0157: the operations-mode revisions and the mode they resolve to. The
  // web login reads them and inserts its own revision, which is why the table is
  // in the read list AND `privateWebInsertTables`; an audit that listed only one
  // side would refuse a correct database.
  "installation_operations_mode_revisions", "installation_effective_operations_mode", "control_module_install_approvals",
  // 0206-0208: the result-file catalog and its download grants. Read only; the
  // preflight's column audit is what proves the web login cannot write a
  // catalog row, cannot quarantine a file and cannot rewrite a producer.
  "control_result_file_sets", "control_result_files", "control_result_file_download_grants",
  // 0209-0211: the owner's approval artefacts for the upload path. Read plus
  // INSERT on the three the owner actually declares and binds; the upload
  // sessions, their chunks and the publication receipt are read only, so the
  // owner's Stop decision about an upload is the 0209 guard's to check and not
  // a column this login can simply set.
  "control_task_declared_outputs", "control_task_declared_inputs", "control_job_artifact_inputs",
  "control_result_upload_sessions", "control_result_upload_chunks", "control_result_publications"] as const;
export const privateWebInsertTables = new Set(["control_web_sessions", "adapter_registry", "projects", "control_manual_project_heads",
  "control_web_project_commands", "audit_events", "control_audit_chain_heads", "control_requests", "control_workflows",
  "control_jobs", "control_web_task_commands", "control_idea_canonical_task_sessions", "control_idea_canonical_task_links",
  "control_idea_promotion_task_links",
  "control_completion_gate_records", "control_web_task_review_commands", "control_news_source_settings", "control_news_story_archives",
  "control_news_task_proposal_links",
  "control_policy_decisions", "control_project_lifecycle_events", "control_project_event_stream_heads", "control_project_events", "control_project_coordinator_heads",
  "control_project_delegation_policies", "control_task_model_selections", "control_task_declared_scopes"]);
privateWebInsertTables.add("work_batch_revisions"); privateWebInsertTables.add("work_batch_items");
privateWebInsertTables.add("work_batch_intake_flag_dismissals");
privateWebInsertTables.add("work_batch_queue_admissions"); privateWebInsertTables.add("work_batch_agent_queue_heads");
privateWebInsertTables.add("pipeline_templates"); privateWebInsertTables.add("pipeline_runs"); privateWebInsertTables.add("pipeline_stage_runs");
privateWebInsertTables.add("control_job_dependencies");
privateWebInsertTables.add("control_project_settings"); privateWebInsertTables.add("pipeline_unattended_transitions");
privateWebInsertTables.add("control_improvement_requests"); privateWebInsertTables.add("control_update_candidate_decisions");
privateWebInsertTables.add("owner_web_push_subscriptions"); privateWebInsertTables.add("owner_web_push_deliveries");
// MIG-I: the dispatcher writes the FIRST head for a newly noticed item and
// nothing else. Every later change is an UPDATE over the retry bookkeeping, so
// INSERT here is the only way a new row appears.
privateWebInsertTables.add("control_owner_push_attempt_heads");
// 0190: a task proposal may cite a retained news story (append-only provenance).
privateWebInsertTables.add("control_news_task_proposal_links");
// S7b: the owner sets the installation's caps and reports the machine's cluster count.
privateWebInsertTables.add("pipeline_installation_allowances"); privateWebInsertTables.add("pipeline_machine_capacity_observations");
privateWebInsertTables.add("installation_operations_mode_revisions");
// 0195: the owner's append-only module install approvals (read current, insert new).
privateWebInsertTables.add("control_module_install_approvals");
// 0208: the owner-facing download grant for one exact file. Insert and spend
// only; the catalog itself is never written by the web login.
privateWebInsertTables.add("control_result_file_download_grants");
// cook/v1 (recurring + skills): the owner's rules and reusable skills.
for (const table of ["control_skills", "control_skill_versions", "control_task_skill_bindings", "control_recurring_rules"])
  privateWebInsertTables.add(table);
// 0209-0211: the owner approves what a part may produce and what it needs, and
// binds an accepted file to the consumer that declared it. Each insert is
// guarded by a live-owner check in the database (0209/0211), so this is
// permission to ask, not permission to declare.
privateWebInsertTables.add("control_task_declared_outputs");
privateWebInsertTables.add("control_task_declared_inputs");
privateWebInsertTables.add("control_job_artifact_inputs");
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
export const privateWebUpdateColumns: Record<string, readonly string[]> = {
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
  control_project_event_stream_heads: ["last_sequence", "last_event_digest", "head_auth_tag", "updated_at"],
  control_action_inbox: ["state", "payload"],
  // MIG-I: exactly the eight retry-bookkeeping columns 0226 grants, and NOT the
  // link -- a phone's destination is written once and never repointed. This list
  // is the preflight's copy of that grant, and it is deliberately identical: a
  // column here that 0226 does not grant, or one missing that it does, is
  // refused by the column audit rather than tolerated.
  control_owner_push_attempt_heads: ["state", "attempt_count", "next_attempt_at", "reserved_at", "last_attempt_at",
    "completed_at", "safe_reason_code", "updated_at"],
  work_batches: ["state", "approval_identity_id", "approved_at", "decision_reason_code", "decision_digest",
    "decision_auth_tag", "version", "updated_at"],
  work_batch_agent_queue_heads: ["next_position", "updated_at"],
  pipeline_templates: ["may_advance_unattended", "version", "updated_at", "record_digest", "auth_tag"],
  pipeline_installation_allowances: ["runs_per_hour", "runs_per_agent_per_day", "machine_max_agent_processes",
    "machine_max_db_clusters", "dollar_cap_microusd", "owner_identity_id", "version", "record_digest", "auth_tag",
    "updated_at"],
  pipeline_runs: ["unattended", "state", "started_at", "updated_at", "version", "template_version", "template_digest",
    "record_digest", "auth_tag"],
  tenants: ["coordinator_lock"],
  control_project_settings: ["eligible_worker_kinds", "max_concurrent_tasks", "default_worker_kind",
    "default_model", "default_effort", "version", "updated_by_identity_id", "updated_at"],
  control_update_candidates: ["state", "version", "decided_at"],
  owner_web_push_deliveries: ["state", "status_code", "completed_at"],
  // 0206-0208: the owner's two retention decisions and the one-time spend of a
  // download grant. Every other catalog column is read-only to the web login,
  // which is what makes "a worker or a reader cannot mark bytes stored" a
  // statement about the live ACL rather than about application code.
  control_result_file_sets: ["retention_state", "accepted_at", "accepted_by_identity_id", "retained_until"],
  control_result_file_download_grants: ["spent_at"],
  control_skills: ["current_version", "state", "updated_at"],
  control_recurring_rules: ["state", "plain_schedule", "cron_expression", "timezone", "task_template", "version",
    "updated_by_identity_id", "updated_at"],
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
  "work_batch_effective_queue_admissions", "control_project_event_stream_heads", "control_project_events"];
const coordinatorInserts = new Set(["control_web_sessions", "control_requests", "control_workflows", "control_jobs",
  "control_attempts", "control_leases", "control_task_execution_plans", "control_transition_events", "control_outbox",
  "audit_events", "control_audit_chain_heads", "control_native_approval_packets", "control_native_task_queue", "control_native_delivery_preparations", "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_codex_delivery_envelopes", "control_codex_transmission_intents", "control_codex_delivery_receipts", "control_worker_delivery_receipts",
  "control_codex_activation_transmission_intents", "control_completion_gate_records",
  "control_project_coordination_proposals", "control_project_coordination_operation_receipts",
  "control_project_coordination_operation_jobs", "control_action_inbox", "control_work_resources",
  "control_attempt_resource_admissions", "control_attempt_resource_scopes", "control_job_dependencies",
  "control_installation_transition_revisions", "control_node_fleet_signals", "control_node_fleet_current",
  "control_task_model_selections", "control_task_declared_scopes", "control_assignment_lease_scopes",
  "control_project_event_stream_heads", "control_project_events"]);
coordinatorReads.push("pipeline_templates", "pipeline_runs", "pipeline_stage_runs", "pipeline_ordered_stage_runs",
  "pipeline_unattended_transitions", "pipeline_advance_receipts",
  "pipeline_installation_allowances", "pipeline_machine_capacity_observations", "pipeline_stage_loop_counts",
  "control_agent_review_plans", "control_pipeline_build_publications");
coordinatorReads.push("control_improvement_requests", "control_update_candidates");
// Scheduling reads each project's worker and concurrency settings (0135).
coordinatorReads.push("control_project_settings");
coordinatorReads.push("installation_operations_mode_revisions");
coordinatorReads.push("control_skills", "control_skill_versions", "control_task_skill_bindings",
  "control_recurring_rules", "control_recurring_proposals");
coordinatorInserts.add("control_recurring_proposals");
coordinatorInserts.add("control_agent_review_plans");
coordinatorInserts.add("control_pipeline_build_publications");
coordinatorInserts.add("pipeline_advance_receipts");
coordinatorInserts.add("pipeline_stage_loop_counts");
coordinatorInserts.add("control_update_candidates");
// Supervisor (0177-0179 and the 0017 incident tables): reconciliation heads,
// health, loop heads and provider waits; incidents are column-scoped writes.
// The supervisor reconciler, the loop watchdog and the provider-wait tracker all
// run on the coordinator login's own pool (see mac-local-default-task-provider's
// `readPool`), so the grants db/roles/task_coordinator_roles.sql confers on them
// are part of this login's reviewed profile. Settings stay read-only: assignment
// enforces them, only an owner-gated web action writes them.
coordinatorReads.push("control_supervisor_task_heads", "control_supervisor_reconciliation_events",
  "control_supervisor_agent_health", "control_supervisor_loop_heads", "control_supervisor_health_observations",
  "control_provider_waits", "control_service_incident_heads", "control_service_incidents");
// The stall decision's outcome-uncertainty test reads effect intents. This is a
// read, never a write: an intent is created and moved only by the path that
// owns the external effect.
coordinatorReads.push("control_effect_intents");
for (const table of ["control_supervisor_task_heads", "control_supervisor_reconciliation_events",
  "control_supervisor_agent_health", "control_supervisor_loop_heads", "control_supervisor_health_observations",
  "control_provider_waits"]) coordinatorInserts.add(table);
/** Column-scoped INSERT grants the coordinator login holds, as
 * db/roles/task_coordinator_roles.sql confers them. A table listed here must
 * NOT be in `coordinatorInserts`: the grant covers only the named columns, and
 * a table-wide entry would demand INSERT on every column. */
const coordinatorInsertColumns: Record<string, readonly string[]> = {
  control_service_incident_heads: ["tenant_id", "correlation_key"],
  control_service_incidents: ["id", "tenant_id", "correlation_key", "generation", "service_id", "severity",
    "safe_reason_code", "safe_remedy_code", "state", "opened_at", "last_observed_at"],
};
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
  ...Object.fromEntries(["pipeline_installation_allowances", "pipeline_stage_loop_counts"]
    .map(table => [table, ["coordinator_lock"]])),
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_project_event_stream_heads: ["last_sequence", "last_event_digest", "head_auth_tag", "updated_at"],
  // The supervisor's own mutable fields: a lapsed task head, an agent's health
  // verdict, the loop's last run, and a provider wait's release. Everything
  // else on those tables stays append-only history.
  control_supervisor_task_heads: ["lapse_count", "last_attempt_id", "state", "updated_at"],
  control_supervisor_agent_health: ["node_id", "state", "safe_reason_code", "last_heartbeat_at", "observed_at"],
  control_supervisor_loop_heads: ["version", "last_started_at", "last_completed_at", "state"],
  control_provider_waits: ["state", "released_at"],
  control_recurring_proposals: ["state", "attempt_count", "batch_id", "safe_reason_code", "updated_at"],
  control_recurring_rules: ["last_evaluated_at"],
  // An incident is opened with a bounded column set and then corrected in
  // place; the head's generation counter is the only service-registry write.
  control_service_incident_heads: ["next_generation"],
  control_service_incidents: ["severity", "safe_reason_code", "safe_remedy_code", "state", "last_observed_at", "resolved_at"],
};
export const taskCoordinatorReadTables = Object.freeze([...coordinatorReads]);
export const taskCoordinatorInsertTables = Object.freeze([...coordinatorInserts]);
export const taskCoordinatorDeleteTables = Object.freeze([...coordinatorDeletes]);
export const taskCoordinatorInsertColumns = Object.freeze(Object.fromEntries(Object.entries(coordinatorInsertColumns)
  .map(([table, columns]) => [table, Object.freeze([...columns])])) as Record<string, readonly string[]>);
export const taskCoordinatorUpdateColumns = Object.freeze(Object.fromEntries(Object.entries(coordinatorUpdates)
  .map(([table, columns]) => [table, Object.freeze([...columns])])) as Record<string, readonly string[]>);
const resultReads = ["workspaces", "control_identities", "control_role_grants", "projects",
  "control_jobs", "control_workflows", "control_requests", "control_task_execution_plans",
  "control_attempts", "control_task_model_selections",
  "control_harness_runs", "control_harness_run_events", "control_codex_result_publications", "control_native_review_plans",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_completion_gate_records",
  "control_completion_gate_integrity", "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding", "control_idea_sessions",
  "control_idea_canonical_task_links", "control_idea_contributions", "control_idea_decisions",
  // 0206: the publisher records the catalog for the attempt it just published,
  // and 0206's deferred completeness trigger counts its own rows as the invoker.
  "control_result_file_sets", "control_result_files"];
const resultInserts = new Set(["control_native_review_plans", "control_completion_gate_records", "audit_events", "control_audit_chain_heads",
  "control_idea_contributions"]);
// 0206-0208: the publisher may record a set and its files, and may move them
// to stored once the bytes are on disk. It may NOT accept, quarantine, delete,
// or touch a download grant — the web login alone mints those.
resultInserts.add("control_result_file_sets"); resultInserts.add("control_result_files");
const resultUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_harness_runs: ["coordinator_lock"], projects: ["coordinator_lock"],
  control_completion_gate_records: ["web_lock"],
  control_native_review_plans: ["results_lock"], control_native_artifact_receipts: ["results_lock"],
  control_completion_gate_integrity: ["web_lock", "revision", "record_count", "state_digest", "state_auth_tag"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  // The publisher's two catalog state moves. `manifest_digest` is listed because
  // 0206 refuses a set that does not match the digest it recomputes, so the
  // publisher must be able to write the one it computed — and nothing else.
  control_result_files: ["state", "stored_at"],
  control_result_file_sets: ["state", "stored_at", "manifest_digest"],
};
const evidenceReads = ["workspaces", "control_identities", "control_role_grants", "projects", "control_manual_project_heads",
  "control_jobs", "control_attempts", "control_leases", "control_nodes", "control_node_keys", "control_harness_runs", "control_harness_run_events",
  "control_native_delivery_envelopes", "control_native_transmission_intents", "control_native_delivery_receipts",
  "control_worker_delivery_receipts", "control_worktree_change_audit_plans", "control_worktree_change_audit_records",
  "control_task_execution_plans", "control_codex_activation_transmission_intents", "control_codex_result_publications",
  "control_artifact_manifests", "control_native_artifact_receipts", "control_native_result_write_reservations",
  "control_durable_result_write_reservations", "control_project_event_stream_heads", "control_project_events",
  "audit_events", "control_audit_chain_heads", "work_intake_tenant_binding"];
const evidenceInserts = new Set(["control_harness_runs", "control_harness_run_events", "control_codex_result_publications", "control_artifact_manifests",
  "control_native_artifact_receipts", "control_native_result_write_reservations",
  "control_worktree_change_audit_plans", "control_worktree_change_audit_records",
  "control_durable_result_write_reservations", "control_project_event_stream_heads", "control_project_events",
  "audit_events", "control_audit_chain_heads"]);
const evidenceUpdates: Record<string, readonly string[]> = {
  control_jobs: ["result_lock"], control_attempts: ["evidence_lock"], control_leases: ["evidence_lock"],
  projects: ["coordinator_lock"], control_manual_project_heads: ["coordinator_lock"],
  control_nodes: ["coordinator_lock"], control_node_keys: ["coordinator_lock"],
  control_harness_runs: ["state", "last_sequence", "run_digest", "run_auth_tag", "payload", "updated_at", "last_observed_at"],
  control_native_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_durable_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  control_project_event_stream_heads: ["last_sequence", "last_event_digest", "head_auth_tag", "updated_at"],
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
const publisherReads = ["workspaces", "control_identities", "control_role_grants", "projects", "control_jobs", "control_attempts", "adapter_registry",
  "control_task_model_selections",
  "control_harness_runs", "control_harness_run_events", "control_artifact_manifests", "control_native_artifact_receipts",
  "control_durable_result_write_reservations", "control_native_review_plans",
  "audit_events", "control_audit_chain_heads", "control_project_event_stream_heads", "control_project_events", "work_intake_tenant_binding"];
const publisherInserts = new Set(["control_harness_runs", "control_harness_run_events", "control_artifact_manifests", "control_native_artifact_receipts",
  "control_durable_result_write_reservations", "control_native_review_plans",
  "audit_events", "control_audit_chain_heads", "control_project_event_stream_heads", "control_project_events"]);
const publisherUpdates: Record<string, readonly string[]> = {
  control_harness_runs: ["publisher_lock", "state", "last_sequence", "run_digest", "run_auth_tag", "payload", "updated_at", "last_observed_at"], control_native_review_plans: ["publisher_lock"],
  control_durable_result_write_reservations: ["state", "contract_digest", "reservation", "auth_tag", "updated_at"],
  control_audit_chain_heads: ["head_hash", "event_count", "updated_at"],
  control_project_event_stream_heads: ["last_sequence", "last_event_digest", "head_auth_tag", "updated_at"],
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
  const allowedInserts = kind === "agentReviewer" ? agentReviewerInserts : kind === "newsCoordinator" ? newsCoordinatorInserts : kind === "newsIngestion" ? newsIngestionInserts : kind === "ideaRuntime" ? ideaRuntimeInserts : kind === "ideas" ? ideaCreationInserts : kind === "sessions" ? sessionInserts : kind === "publisher" ? publisherInserts : kind === "evidence" ? evidenceInserts : kind === "results" ? resultInserts : kind === "coordinator" ? coordinatorInserts : privateWebInsertTables;
  const allowedUpdates = kind === "agentReviewer" ? agentReviewerUpdates : kind === "newsCoordinator" ? newsCoordinatorUpdates : kind === "newsIngestion" ? newsIngestionUpdates : kind === "ideaRuntime" ? ideaRuntimeUpdates : kind === "ideas" ? ideaCreationUpdates : kind === "sessions" ? sessionUpdates : kind === "publisher" ? publisherUpdates : kind === "evidence" ? evidenceUpdates : kind === "results" ? resultUpdates : kind === "coordinator" ? coordinatorUpdates : privateWebUpdateColumns;
  const allowedDeletes = kind === "coordinator" ? coordinatorDeletes : kind === "web"
    ? new Set(["owner_web_push_subscriptions"]) : new Set<string>();
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
                    'control_room_idea_creation','control_room_news_coordinator','control_room_fleet_gateway',
                    'control_room_fleet_owner_authority'))))
            OR (p.oid='redeem_fleet_enrollment(text,text,text,text,timestamptz)'::regprocedure
              AND p.prosecdef AND p.provolatile='v' AND p.prokind='f' AND NOT p.proleakproof AND p.proparallel='u'
              AND pg_get_userbyid(p.proowner)='control_room_schema_owner'
              AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
              AND NOT has_function_privilege('public',p.oid,'EXECUTE')
              -- The gateway is the only role allowed to call this, so when it
              -- exists it must hold EXECUTE. It may legitimately be ABSENT: a
              -- Mac-local cluster never installs db/roles/fleet_gateway_roles.sql,
              -- and has_function_privilege on a missing role raises 42704
              -- rather than answering false, which would fail every Mac-local
              -- preflight on a database that is in fact correct. When the role
              -- is absent the ACL check below is the whole proof: no grantee can
              -- be named control_room_fleet_gateway if it does not exist, so
              -- any surviving non-owner EXECUTE grantee still fails here.
              AND (NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway')
                OR has_function_privilege('control_room_fleet_gateway',p.oid,'EXECUTE'))
              AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND (a.is_grantable OR a.grantee=0
                  OR pg_get_userbyid(a.grantee)<>'control_room_fleet_gateway')))
            /* MIG-I's push-endpoint allow list (0227). A CHECK constraint runs as
               its WRITER, so the login that inserts subscriptions must hold
               EXECUTE on these two or the constraint is unevaluable and every
               subscribe fails 42501 instead of 204. That makes them the one
               documented exception to "the web login holds no EXECUTE": both are
               pure and immutable, own no object, and are pinned to the same
               search_path as every other function here. The ACL test is the
               point -- exactly one non-owner grantee, and it must be
               control_room_private_web. */
            OR (p.oid IN ('owner_push_endpoint_host(text)'::regprocedure,
                'owner_push_endpoint_allowed(text)'::regprocedure)
              AND pg_get_userbyid(p.proowner)='control_room_schema_owner'
              AND NOT p.prosecdef AND NOT p.proleakproof AND p.prokind='f'
              AND p.provolatile='i' AND p.proparallel='s'
              AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='sql')
              AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
              AND NOT has_function_privilege('public',p.oid,'EXECUTE')
              AND has_function_privilege('control_room_private_web',p.oid,'EXECUTE')
              AND NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
                WHERE a.privilege_type='EXECUTE' AND a.grantee<>p.proowner AND (a.is_grantable OR a.grantee=0
                  OR pg_get_userbyid(a.grantee)<>'control_room_private_web')))
            /* The owner is checked for EVERY kind, not only the reviewer. The
               rest of this branch (SECURITY DEFINER, the pinned search_path, the
               volatility of each signature) describes what these two functions
               must be on a correct database; none of it says who may own them.
               Leaving the owner test inside the $2 disjunct made the whole shape
               conditional, so on a database where the functions exist with the
               right properties but are owned by anyone other than
               control_room_schema_owner, every non-reviewer kind exempted them on
               the strength of the web login merely lacking EXECUTE - which is
               exactly the state a SECURITY DEFINER function an operator can
               re-create, or a fixture that replays migrations without SET ROLE,
               is in. redeem_fleet_enrollment above checks its owner
               unconditionally for the same reason. */
            OR (p.oid IN ('commit_agent_review(text,jsonb,jsonb,bytea)'::regprocedure,'read_agent_review_plan(text)'::regprocedure)
              AND pg_get_userbyid(p.proowner)='control_room_schema_owner'
              AND NOT has_function_privilege('public',p.oid,'EXECUTE')
              AND (($2 AND p.prosecdef
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
      const reads: Set<string> = new Set(allowedReads);
      // The web login's read-only fleet tables exist only where
      // db/roles/fleet_gateway_roles.sql was applied, which is exactly when
      // control_room_fleet_gateway is in the cluster. See
      // `privateWebFleetReadTables`: demanding them unconditionally made every
      // correct Mac-local database fail this preflight, and dropping them
      // unconditionally would under-check a full production install. Nothing is
      // granted by this: the live ACL is still read from the server, only the
      // expected set follows the role file that was applied.
      if (kind === "web" && (await tx.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') AS present`)).rows[0]?.present)
        for (const table of privateWebFleetReadTables) reads.add(table);
      // Column-scoped INSERT grants (the web role's idempotency ledger and the
      // coordinator's incident appends): listed columns must carry INSERT,
      // unlisted must not.
      const scopedInserts = kind === "web" ? privateWebInsertColumns
        : kind === "coordinator" ? coordinatorInsertColumns : {};
      const scopedReads = kind === "web" ? privateWebReadColumns : {};
      if (!columns.length) fail();
      // Fleet tables are granted to the web login by fleet_gateway_roles.sql, which the
      // Mac-local install never runs, so where the fleet gateway is absent the web login
      // must hold nothing on any fleet table. The expectation follows the install; the
      // comparison does not soften, so a stray grant is still refused.
      const effectiveReads = new Set(reads);
      if (kind === "web" && (await tx.query<{ present: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='control_room_fleet_gateway') AS present")
      ).rows[0]?.present !== true) for (const table of privateWebFleetReadTables) effectiveReads.delete(table);
      if (columns.some(c => c.extra
        || c.read !== (effectiveReads.has(c.table_name) || !!scopedReads[c.table_name]?.includes(c.column_name))
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