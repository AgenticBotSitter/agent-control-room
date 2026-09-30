-- OFFLINE OPERATOR SETUP ONLY. Never executed by application startup.
-- Dedicated, separately rehearsed database; fresh NOLOGIN role only. A private LOGIN
-- may inherit ONLY this role without ADMIN option or database/object ownership.
BEGIN;
CREATE ROLE control_room_task_coordinator NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO control_room_task_coordinator;
-- This GRANT is kept as one contiguous block with no comment inside it: the
-- down-migration lane rewrites role files by exact text match
-- (tests/postgres-production-lifecycle.test.mjs), and a comment in the middle of
-- the table list makes the whole statement stop matching.
GRANT SELECT ON tenants, workspaces, control_identities, control_role_grants, control_web_sessions,
  projects, control_manual_project_heads, control_requests, control_workflows, control_jobs,
  control_attempts, control_leases, control_task_execution_plans, control_nodes, control_node_keys,
  control_node_fleet_current, control_job_dependencies, control_transition_events, control_outbox,
  audit_events, control_audit_chain_heads, control_completion_gate_integrity, control_completion_gate_records,
  control_native_approval_packets, control_native_task_queue, control_native_delivery_preparations, control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts,
  control_codex_delivery_envelopes, control_codex_transmission_intents, control_codex_delivery_receipts, control_codex_activation_transmission_intents,
  control_worker_delivery_receipts,
  control_codex_result_publications,
  control_harness_runs, control_harness_run_events, control_native_review_plans, control_artifact_manifests, control_native_artifact_receipts,
  control_action_inbox, control_project_coordinator_heads, control_project_coordination_proposals,
  control_project_delegation_policies, control_project_coordination_operation_receipts,
  control_project_coordination_operation_jobs, control_work_resources,
  control_attempt_resource_admissions, control_attempt_resource_scopes,
  work_batches, work_batch_items, work_batch_effective_queue_admissions,
  pipeline_templates, pipeline_runs, pipeline_stage_runs, pipeline_ordered_stage_runs, control_agent_review_plans,
  control_pipeline_build_publications, pipeline_unattended_transitions, pipeline_advance_receipts,
  pipeline_installation_allowances, pipeline_machine_capacity_observations, pipeline_stage_loop_counts,
  control_improvement_requests, control_update_candidates,
  control_installation_transition_revisions,
  control_supervisor_task_heads, control_supervisor_reconciliation_events, control_supervisor_agent_health,
  control_supervisor_loop_heads, control_supervisor_health_observations, control_provider_waits,
  control_service_incident_heads, control_service_incidents,
  installation_operations_mode_revisions
  TO control_room_task_coordinator;
GRANT SELECT ON control_skills, control_skill_versions, control_task_skill_bindings,
  control_recurring_rules, control_recurring_proposals TO control_room_task_coordinator;
-- Read-only, and only for the supervisor's stall decision: reconciling a stalled
-- attempt asks whether an effect intent is still executing, confirmed or
-- ambiguous, which is what separates "requeue it" from "the outcome is
-- uncertain, a human must look". Postgres checks the privilege on every
-- relation the statement names, so without this the reconciliation query fails
-- for every eligible candidate. No INSERT, UPDATE or DELETE: intents are
-- written by the owning paths alone.
GRANT SELECT ON control_effect_intents TO control_room_task_coordinator;
GRANT SELECT ON control_task_model_selections, control_task_declared_scopes,
  control_assignment_lease_scopes TO control_room_task_coordinator;
-- Read-only: the coordinator enforces a project's eligible-worker-kinds and
-- concurrency-cap settings during assignment (task-assignment-coordinator.ts's
-- #assignLocked), but never writes them -- that stays an owner-gated web action.
GRANT SELECT ON control_project_settings TO control_room_task_coordinator;
GRANT INSERT ON control_web_sessions, control_requests, control_workflows, control_jobs,
  control_attempts, control_leases, control_task_execution_plans, control_transition_events,
  control_outbox, audit_events, control_audit_chain_heads, control_native_approval_packets, control_native_task_queue, control_native_delivery_preparations, control_native_delivery_envelopes, control_native_transmission_intents, control_native_delivery_receipts,
  control_codex_delivery_envelopes, control_codex_transmission_intents, control_codex_delivery_receipts, control_codex_activation_transmission_intents,
  control_worker_delivery_receipts TO control_room_task_coordinator;
GRANT INSERT ON control_task_model_selections, control_task_declared_scopes,
  control_assignment_lease_scopes TO control_room_task_coordinator;
GRANT SELECT, INSERT ON control_project_event_stream_heads, control_project_events TO control_room_task_coordinator;
GRANT UPDATE (last_sequence,last_event_digest,head_auth_tag,updated_at)
  ON control_project_event_stream_heads TO control_room_task_coordinator;
-- Assignment owns this derived lease evidence and may remove only its rows
-- once the canonical lease is terminal or elapsed.
GRANT DELETE ON control_assignment_lease_scopes TO control_room_task_coordinator;
GRANT INSERT ON control_installation_transition_revisions TO control_room_task_coordinator;
GRANT INSERT ON control_agent_review_plans TO control_room_task_coordinator;
GRANT INSERT ON control_pipeline_build_publications TO control_room_task_coordinator;
GRANT INSERT ON control_update_candidates TO control_room_task_coordinator;
GRANT INSERT ON control_recurring_proposals TO control_room_task_coordinator;
GRANT UPDATE (state,attempt_count,batch_id,safe_reason_code,updated_at)
  ON control_recurring_proposals TO control_room_task_coordinator;
GRANT UPDATE (last_evaluated_at) ON control_recurring_rules TO control_room_task_coordinator;
GRANT INSERT ON control_project_coordination_proposals,
  control_project_coordination_operation_receipts, control_project_coordination_operation_jobs,
  control_action_inbox TO control_room_task_coordinator;
GRANT INSERT ON pipeline_advance_receipts TO control_room_task_coordinator;
-- The counted fix rounds. The coordinator appends a round against the receipt
-- that opened it; it can never rewrite or delete one.
GRANT INSERT ON pipeline_stage_loop_counts TO control_room_task_coordinator;
-- The installation ceilings are read-only here, and the only updatable column
-- is the false-valued lock the row lock needs.
GRANT UPDATE (coordinator_lock) ON pipeline_installation_allowances, pipeline_stage_loop_counts
  TO control_room_task_coordinator;
GRANT INSERT ON control_supervisor_task_heads, control_supervisor_reconciliation_events,
  control_supervisor_agent_health, control_supervisor_loop_heads, control_supervisor_health_observations,
  control_provider_waits TO control_room_task_coordinator;
GRANT UPDATE (lapse_count,last_attempt_id,state,updated_at)
  ON control_supervisor_task_heads TO control_room_task_coordinator;
GRANT UPDATE (node_id,state,safe_reason_code,last_heartbeat_at,observed_at)
  ON control_supervisor_agent_health TO control_room_task_coordinator;
GRANT UPDATE (version,last_started_at,last_completed_at,state)
  ON control_supervisor_loop_heads TO control_room_task_coordinator;
GRANT UPDATE (state,released_at) ON control_provider_waits TO control_room_task_coordinator;
GRANT INSERT (tenant_id,correlation_key) ON control_service_incident_heads TO control_room_task_coordinator;
GRANT UPDATE (next_generation) ON control_service_incident_heads TO control_room_task_coordinator;
GRANT INSERT (id,tenant_id,correlation_key,generation,service_id,severity,safe_reason_code,safe_remedy_code,state,opened_at,last_observed_at)
  ON control_service_incidents TO control_room_task_coordinator;
GRANT UPDATE (severity,safe_reason_code,safe_remedy_code,state,last_observed_at,resolved_at)
  ON control_service_incidents TO control_room_task_coordinator;
GRANT UPDATE (state, completed_at, current_stage_ordinal, updated_at, version, record_digest, auth_tag, unattended_last_swept_at)
  ON pipeline_runs TO control_room_task_coordinator;
GRANT INSERT ON control_work_resources, control_attempt_resource_admissions,
  control_attempt_resource_scopes TO control_room_task_coordinator;
GRANT UPDATE (state,version,retired_at,retirement_kind,retirement_proof_digest)
  ON control_attempt_resource_admissions TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_project_coordinator_heads,
  control_project_coordination_proposals, control_project_delegation_policies,
  control_project_coordination_operation_receipts, control_project_coordination_operation_jobs,
  control_work_resources, control_attempt_resource_scopes TO control_room_task_coordinator;
GRANT INSERT ON control_job_dependencies TO control_room_task_coordinator;
GRANT UPDATE (state, version, payload, updated_at) ON control_requests, control_workflows,
  control_jobs, control_attempts, control_leases TO control_room_task_coordinator;
GRANT UPDATE (stage_kind, stage_ordinal, pipeline_run_id) ON control_jobs TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON tenants, control_nodes, control_node_keys, control_manual_project_heads, projects
  TO control_room_task_coordinator;
GRANT UPDATE (web_lock) ON control_identities, control_role_grants, workspaces,
  control_completion_gate_integrity TO control_room_task_coordinator;
GRANT UPDATE (revoked_at) ON control_web_sessions TO control_room_task_coordinator;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_task_coordinator;
GRANT INSERT ON control_completion_gate_records TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_harness_runs TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_native_artifact_receipts, control_native_review_plans TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_worker_delivery_receipts TO control_room_task_coordinator;
GRANT UPDATE (web_lock) ON control_completion_gate_records TO control_room_task_coordinator;
GRANT UPDATE (revision, record_count, state_digest, state_auth_tag) ON control_completion_gate_integrity TO control_room_task_coordinator;
-- Mac-local readiness signals only; migration 0087's guard confines these to the
-- local worker nodes and to capability/telemetry, and keeps history append-only.
GRANT SELECT, INSERT ON control_node_fleet_signals TO control_room_task_coordinator;
GRANT UPDATE (coordinator_lock) ON control_node_fleet_signals TO control_room_task_coordinator;
GRANT INSERT ON control_node_fleet_current TO control_room_task_coordinator;
GRANT UPDATE (signal_sequence, fingerprint, trust, observed_at, expires_at, payload)
  ON control_node_fleet_current TO control_room_task_coordinator;
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_task_coordinator;
GRANT SELECT ON work_intake_tenant_binding TO control_room_task_coordinator;
COMMIT;
