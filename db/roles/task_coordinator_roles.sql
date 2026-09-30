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
-- MIG-A (0201, 0202): the orchestrator's selection read and its durable run
-- bookkeeping. 0201's planner columns ride on the existing 0135 SELECT, so the
-- coordinator holds nothing new there. For 0202 it holds SELECT and INSERT on the
-- counter plus a five-column UPDATE that guard_planner_failure_counter_write
-- constrains to exactly two transitions, and SELECT plus INSERT on the append-only
-- ledger. It holds NO UPDATE or DELETE on either table, so a recorded escalation
-- cannot be edited afterwards, and no privilege on either of the owner views.
GRANT SELECT, INSERT ON control_planner_failure_counters TO control_room_task_coordinator;
-- The sixth column is 0205's `owner_retry_cleared_at`, and it is the SPEND, not
-- the grant: the retry latch is cleared by the run it authorised, so a granted
-- retry cannot authorise a second one. The coordinator can therefore UNSET a latch
-- and never SET one -- setting it is 0205's SECURITY DEFINER function, which
-- refuses anything but a live counter at >= 2 -- and the guard trigger admits
-- exactly that one transition.
GRANT UPDATE (failure_count, last_failure_at, cleared_at, version, updated_at, owner_retry_cleared_at)
  ON control_planner_failure_counters TO control_room_task_coordinator;
GRANT SELECT, INSERT ON control_planner_needs_you_items TO control_room_task_coordinator;
-- MIG-A 0204: EXECUTE on the failure-scope key helper. 0204's guard trigger calls
-- it as the table owner, but the coordinator's own INSERT fires that trigger, and
-- PostgreSQL checks EXECUTE for the INSERTing role as well -- measured: without
-- this every escalation is refused with "permission denied for function
-- planner_failure_scope_key", which reads as a broken guard rather than a missing
-- grant. The grant is issued HERE rather than in the migration for the same reason
-- the intake login's predicate grant is: this file runs after
-- `ALTER DEFAULT PRIVILEGES ... REVOKE ALL ON FUNCTIONS FROM PUBLIC`, and it is
-- the only file where the coordinator role exists.
--
-- The helper is IMMUTABLE and a pure function of a kind plus a jsonb preimage the
-- caller already holds, so EXECUTE discloses nothing the login could not compute.
GRANT EXECUTE ON FUNCTION planner_failure_scope_key(text, jsonb) TO control_room_task_coordinator;

-- MIG-A 0205: NO EXECUTE on the owner's deliberate retry for the coordinator, and
-- that is a change rather than an omission. Round 4 measured the consequence of
-- having granted it: the coordinator login can set `owner_retry_cleared_at`
-- directly, and can clear an escalated counter with no success at all -- so the
-- "the only login that can ask is the owner's own web login" and "the
-- coordinator holds no UPDATE on the column" claims were both false on a
-- database built from these files.
--
-- The impact was low (the coordinator could always clear counters since 0202, so
-- the loop bound was never enforced by the database against that login), but the
-- grant had no user: no coordinator code calls
-- `control_room_planner_grant_owner_retry`. The retry is asked for over the owner's
-- own web pool by `PostgresIntakeOwnerRetryStoreV1` (see private_web_roles.sql),
-- and the coordinator only READS the latch through its own SELECT.
--
-- The REVOKE is what makes an already-installed cluster converge: this file runs
-- on every install and upgrade, so an install that carried the old grant drops it
-- rather than keeping it. It names the function the file created, and the Mac
-- upgrade path reaches the same state through
-- scripts/mac-local/database-upgrade-grants.mjs, whose `plannerFunctions` map pins
-- this function to the web login alone.
REVOKE EXECUTE ON FUNCTION control_room_planner_grant_owner_retry(text, text, text[])
  FROM control_room_task_coordinator;
COMMIT;
