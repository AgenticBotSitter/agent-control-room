-- OFFLINE OPERATOR SETUP ONLY, on a dedicated disposable/rehearsed database.
-- Never executed by startup. Fresh role only: existing installations need reviewed migration.
-- Database owner/migrator stays separate. Provision a separate LOGIN privately afterward,
-- granting ONLY membership in this NOLOGIN role, no ADMIN option, no object ownership.
BEGIN;
CREATE ROLE control_room_private_web NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- The separate private_web_database.sql must also be applied to the exact dedicated database.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- Function defaults are global; a per-schema revoke cannot undo the global PUBLIC default.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_private_web;
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_private_web;
-- Lead-approved read-only schedule presentation; no occurrence or schedule mutation.
GRANT SELECT ON control_schedules, control_schedule_occurrences TO control_room_private_web;
GRANT SELECT ON control_identities, control_role_grants, workspaces, control_web_sessions,
  adapter_registry, projects, control_manual_project_heads, control_web_project_commands,
  audit_events, control_audit_chain_heads, control_project_lifecycle_events,
  control_connection_registry_heads, control_connection_enrollments,
  control_connection_authenticated_telemetry_receipts, control_requests, control_workflows, control_jobs, control_leases,
  control_attempts, control_harness_runs, control_harness_run_events, control_web_task_commands,
  control_task_execution_plans,
  control_artifact_manifests, control_native_artifact_receipts, control_completion_gate_records,
  control_completion_gate_integrity, control_web_task_review_commands, control_native_review_plans,
  control_news_story_versions, control_news_source_observations, control_news_source_settings, control_news_story_archives, control_news_article_details, control_idea_sessions, control_idea_contributions,
  control_idea_syntheses, control_idea_decisions, control_idea_bot_run_events, control_idea_canonical_task_sessions,
  control_idea_canonical_task_links, control_policy_decisions,
  control_project_coordinator_heads, control_project_coordination_proposals,
  control_project_delegation_policies, control_project_coordination_operation_receipts,
  control_project_coordination_operation_jobs, control_work_resources,
  control_project_event_stream_heads, control_project_events,
  control_attempt_resource_admissions, control_attempt_resource_scopes,
  work_batches, work_batch_revisions, work_batch_items, control_action_inbox TO control_room_private_web;
GRANT SELECT ON pipeline_templates, pipeline_runs, pipeline_stage_runs,
  pipeline_ordered_stage_runs, pipeline_unattended_transitions,
  control_pipeline_build_publications, control_codex_result_publications
  TO control_room_private_web;
GRANT SELECT ON work_batch_queue_admissions, work_batch_effective_queue_admissions,
  work_batch_agent_queue_heads, control_native_task_queue, control_job_dependencies TO control_room_private_web;
GRANT SELECT ON control_task_model_selections, control_task_declared_scopes,
  control_assignment_lease_scopes TO control_room_private_web;
GRANT SELECT ON control_durable_result_write_reservations TO control_room_private_web;
-- Owner Web Push: browser subscriptions and delivery reservations only. This
-- does not grant task, approval, scheduler, or configuration authority.
GRANT SELECT, INSERT, DELETE ON owner_web_push_subscriptions TO control_room_private_web;
GRANT SELECT, INSERT ON owner_web_push_deliveries TO control_room_private_web;
GRANT UPDATE (state, status_code, completed_at) ON owner_web_push_deliveries TO control_room_private_web;
-- Per-project settings (eligible worker kinds, concurrency cap, defaults): the
-- web role reads them both for the owner-facing Settings tab and to enforce
-- eligibility/concurrency during assignment, and writes them only through the
-- owner-gated settings action.
GRANT SELECT ON control_project_settings TO control_room_private_web;
GRANT INSERT ON control_project_settings TO control_room_private_web;
GRANT UPDATE (eligible_worker_kinds, max_concurrent_tasks, default_worker_kind, default_model,
  default_effort, version, updated_by_identity_id, updated_at) ON control_project_settings
  TO control_room_private_web;
-- Project coordination page (attentionList, readDependencies): exactly the
-- read, filter and join columns the composer names. No payload, deep_link or
-- source columns and no writes; tenant scoping is the composer's WHERE clause.
GRANT SELECT (id, tenant_id, project_id, attention_type, title, summary, due_at, observed_at, work_item_id)
  ON attention_items TO control_room_private_web;
GRANT SELECT (tenant_id, job_id, depends_on_job_id) ON control_job_dependencies TO control_room_private_web;
GRANT UPDATE (web_lock) ON control_identities, control_role_grants, workspaces,
  control_connection_registry_heads, control_completion_gate_integrity, control_completion_gate_records,
  control_jobs TO control_room_private_web;
GRANT INSERT ON control_web_sessions, adapter_registry, projects, control_manual_project_heads,
  control_web_project_commands, audit_events, control_audit_chain_heads,
  control_requests, control_workflows, control_jobs, control_web_task_commands,
  control_idea_canonical_task_sessions, control_idea_canonical_task_links,
  control_completion_gate_records, control_web_task_review_commands, control_news_source_settings, control_news_story_archives,
  control_policy_decisions, control_project_lifecycle_events,
  control_project_coordinator_heads, control_project_delegation_policies TO control_room_private_web;
GRANT INSERT ON control_task_model_selections, control_task_declared_scopes TO control_room_private_web;
GRANT INSERT ON control_project_event_stream_heads, control_project_events TO control_room_private_web;
GRANT UPDATE (last_sequence,last_event_digest,head_auth_tag,updated_at)
  ON control_project_event_stream_heads TO control_room_private_web;
GRANT INSERT ON work_batch_revisions, work_batch_items TO control_room_private_web;
GRANT INSERT ON work_batch_queue_admissions, work_batch_agent_queue_heads TO control_room_private_web;
GRANT INSERT ON pipeline_templates, pipeline_runs, pipeline_stage_runs TO control_room_private_web;
-- Owner-authored dependent proposals (pipeline stages, approved batch items)
-- write the edge between two jobs this role itself inserts. Append-only: no
-- UPDATE or DELETE, and SELECT stays the three coordination-page columns.
GRANT INSERT ON control_job_dependencies TO control_room_private_web;
GRANT INSERT ON pipeline_unattended_transitions TO control_room_private_web;
GRANT UPDATE (may_advance_unattended, version, updated_at, record_digest, auth_tag)
  ON pipeline_templates TO control_room_private_web;
GRANT UPDATE (unattended, state, started_at, updated_at, version, template_version, template_digest,
  record_digest, auth_tag) ON pipeline_runs TO control_room_private_web;
GRANT UPDATE (stage_kind, stage_ordinal, pipeline_run_id) ON control_jobs TO control_room_private_web;
-- Coordinator lifecycle idempotency ledger: exact-match replay before any
-- head mutation. SELECT plus the five inserted columns plus the completion
-- update; INSERT is column-scoped so the role can never smuggle
-- result/completed_at values into a fresh receipt.
GRANT SELECT ON control_idempotency TO control_room_private_web;
GRANT INSERT (tenant_id, operation_scope, idempotency_key, request_digest, status)
  ON control_idempotency TO control_room_private_web;
GRANT UPDATE (status, result, completed_at) ON control_idempotency TO control_room_private_web;
-- Tenant existence lock for the lifecycle transaction. The web path never
-- mutates the tenant row; SELECT covers the read, UPDATE the row lock.
GRANT SELECT ON tenants TO control_room_private_web;
GRANT UPDATE (coordinator_lock) ON tenants TO control_room_private_web;
GRANT UPDATE (state, coordinator_identity_id, coordinator_actor_type, executor_id, adapter_id,
  connector_profile_digest, execution_binding_digest, assigned_by_owner_identity_id, version,
  assigned_at, updated_at, revoked_at, payload) ON control_project_coordinator_heads
  TO control_room_private_web;
GRANT UPDATE (state, version, updated_at) ON control_project_delegation_policies
  TO control_room_private_web;
GRANT UPDATE (revision, record_count, state_digest, state_auth_tag) ON control_completion_gate_integrity TO control_room_private_web;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_private_web;
GRANT UPDATE (domain_state, source_version, normalized_state, updated_at, payload, observed_at) ON projects TO control_room_private_web;
GRANT UPDATE (lifecycle, version, updated_at) ON control_manual_project_heads TO control_room_private_web;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_private_web;
GRANT UPDATE (state, payload) ON control_action_inbox TO control_room_private_web;
GRANT UPDATE (state, approval_identity_id, approved_at, decision_reason_code, decision_digest,
  decision_auth_tag, version, updated_at)
  ON work_batches TO control_room_private_web;
GRANT UPDATE (next_position, updated_at) ON work_batch_agent_queue_heads TO control_room_private_web;
-- Installation-wide operations mode. The owner session is the only writer, and
-- 0155's guard trigger refuses any identity that is not a live human owner.
-- No UPDATE or DELETE: a recorded decision is appended, never rewritten.
GRANT SELECT, INSERT ON installation_operations_mode_revisions TO control_room_private_web;
GRANT SELECT ON installation_effective_operations_mode TO control_room_private_web;
GRANT SELECT ON work_intake_tenant_binding TO control_room_private_web;
COMMIT;
