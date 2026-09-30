-- Run as the schema owner (control_room_schema_owner) after migrations have
-- applied. This file is the table/sequence/function-level grants portion of
-- the production role setup; the role CREATE statements live in
-- db/roles/production_roles.sql and run during bootstrap as the bootstrap
-- superuser. Splitting them lets the migrator session apply table-level
-- grants after migrations without needing CREATEROLE privilege.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO control_room_application, control_room_reader, control_room_backup,
  control_room_schedule_admissions, control_room_github_broker, control_room_work_intake;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO control_room_application;
GRANT DELETE ON projects, work_items, executions, blockers, attention_items, machine_nodes, worker_runtimes, agent_identities
  TO control_room_application;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO control_room_reader, control_room_backup;

REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events, projection_changes, command_receipts, control_transition_events,
  control_policy_decisions, control_approval_consumptions, control_audit_anchors,
  node_protocol_replay
  FROM control_room_application, control_room_reader, control_room_backup;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
  FROM control_room_reader, control_room_backup;

-- The migration ledger is operator/migrator state: application, reader, backup
-- and scheduler roles can never read it (least-privilege denial proof).
REVOKE ALL ON control_room_schema_migrations
  FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;

-- Schedule-admission service (issue #120): the narrow write path for
-- control_scheduled_task_admissions plus SELECT on exactly the tables it
-- references. No UPDATE/DELETE (the table is append-only), no DDL, and the
-- read-only web role (control_room_reader) never gains this INSERT.
GRANT SELECT, INSERT ON control_scheduled_task_admissions TO control_room_schedule_admissions;
GRANT SELECT ON workspaces, projects, control_schedule_occurrences, control_schedules,
  control_requests, control_workflows, control_jobs TO control_room_schedule_admissions;

-- GitHub App broker: it can claim replay keys and append/read/prune content-free
-- wake hints. It cannot read Control Room projects, work, identities,
-- credentials, or audit content.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM control_room_github_broker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM control_room_github_broker;
REVOKE ALL ON control_github_webhook_replays FROM control_room_application, control_room_reader,
  control_room_backup, control_room_schedule_admissions;
REVOKE ALL ON control_github_worker_wake_hints FROM control_room_application, control_room_reader,
  control_room_backup, control_room_schedule_admissions;
GRANT SELECT, INSERT, DELETE ON control_github_webhook_replays TO control_room_github_broker;
GRANT SELECT, INSERT, DELETE ON control_github_worker_wake_hints TO control_room_github_broker;
GRANT USAGE ON SEQUENCE control_github_worker_wake_hints_hint_id_seq TO control_room_github_broker;

-- Proposal-only machine intake: no task, queue, assignment, approval or effect
-- tables. Migration 0093 additionally confines the shared-ledger grants below
-- by login-aware triggers and row-level policies; they are not unrestricted
-- shared-ledger authority.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM control_room_work_intake;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM control_room_work_intake;
REVOKE ALL ON work_intake_role_anchor FROM control_room_application, control_room_reader,
  control_room_backup, control_room_schedule_admissions, control_room_github_broker;
GRANT SELECT ON work_intake_role_anchor TO control_room_work_intake;
-- The intake tenant binding is written only by the owner bootstrap. Every role
-- that evaluates the intake policies must read it; none of them may change it.
REVOKE ALL ON work_intake_tenant_binding FROM control_room_application, control_room_reader,
  control_room_backup, control_room_schedule_admissions, control_room_github_broker;
GRANT SELECT ON work_intake_tenant_binding TO control_room_application, control_room_reader,
  control_room_backup, control_room_work_intake;
REVOKE ALL ON work_batches, work_batch_revisions, work_batch_items, work_batch_queue_admissions,
  work_batch_effective_queue_admissions, work_batch_agent_queue_heads FROM control_room_application,
  control_room_reader, control_room_schedule_admissions, control_room_github_broker;
REVOKE ALL ON pipeline_templates, pipeline_runs, pipeline_stage_runs, pipeline_ordered_stage_runs,
  pipeline_unattended_transitions, pipeline_advance_receipts,
  pipeline_installation_allowances, pipeline_machine_capacity_observations, pipeline_stage_loop_counts
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
REVOKE ALL ON control_agent_review_plans FROM control_room_application, control_room_reader,
  control_room_schedule_admissions, control_room_github_broker, control_room_work_intake;
REVOKE ALL ON control_pipeline_build_publications
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
REVOKE ALL ON control_improvement_requests, control_update_candidates, control_update_candidate_decisions
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
-- MIG-A (0200-0202): the orchestrator's split suggestions and its durable run
-- bookkeeping. The shared intake login may APPEND a suggestion and nothing else --
-- no UPDATE, DELETE or TRUNCATE, and the table's own triggers refuse a mutation
-- even for a role that had one. It reads the revision-scoped suggestion list
-- through one SECURITY DEFINER function and never holds the planner's failure
-- counter or the Needs-you ledger: those are the coordinator's, and the intake
-- login has no planner of its own. Every other shared login holds nothing here.
REVOKE ALL ON work_batch_split_suggestions, control_planner_failure_counters,
  control_planner_needs_you_items
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker;
-- Installation-wide operations mode (Pause / Drain / Stop). Read-only for the
-- shared ledgers, the reader and the backup role; only the private owner web
-- login may append a revision, and the guard trigger refuses anything but a
-- live human owner's grant. The shared intake login reads nothing here.
--
-- The coordinator's SELECT is in task_coordinator_roles.sql, because that role
-- does not exist yet when this file is applied: naming it here would fail the
-- whole grant file on a fresh install.
REVOKE ALL ON installation_operations_mode_revisions, installation_effective_operations_mode
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
GRANT SELECT ON installation_operations_mode_revisions, installation_effective_operations_mode
  TO control_room_application, control_room_reader, control_room_backup;
-- Owner module install approvals (0195) belong to the private web login alone.
REVOKE ALL ON control_module_install_approvals
  FROM control_room_application, control_room_reader, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
-- The result-file catalog and its download grants (0206-0208) are the private
-- web login's and the native result publisher's. The shared application,
-- reader, backup, intake and schedule roles reach none of them, so a shared
-- login cannot read a project's result-file names, digests or storage keys,
-- and cannot mint a download grant. The reader and backup revokes are what
-- keep the grant ledger out of a backup role's blind SELECT-on-everything.
REVOKE ALL ON control_result_file_sets, control_result_files, control_result_file_download_grants
  FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions,
  control_room_github_broker, control_room_work_intake;
GRANT SELECT ON control_identities, control_role_grants, projects, work_batches,
  work_batch_revisions, work_batch_items, control_idempotency, audit_events, control_audit_chain_heads
  TO control_room_work_intake;
GRANT INSERT ON work_batches, work_batch_revisions, audit_events,
  control_audit_chain_heads TO control_room_work_intake;
GRANT INSERT (tenant_id, operation_scope, idempotency_key, request_digest, status)
  ON control_idempotency TO control_room_work_intake;
GRANT UPDATE (status, result, completed_at) ON control_idempotency TO control_room_work_intake;
GRANT UPDATE (head_hash, event_count, updated_at) ON control_audit_chain_heads TO control_room_work_intake;
-- Row-lock carrier columns are CHECK-pinned false. They permit FOR SHARE
-- authorization locks without granting mutation of identity, grant or project data.
GRANT UPDATE (web_lock) ON control_identities, control_role_grants TO control_room_work_intake;
GRANT UPDATE (coordinator_lock) ON projects TO control_room_work_intake;
GRANT EXECUTE ON FUNCTION work_intake_canonical_jsonb(jsonb) TO control_room_work_intake;
-- Shared-ledger policies call this predicate for the roles that can reach the
-- protected ledgers. Keep it off PUBLIC so unprovisioned roles cannot invoke a
-- SECURITY DEFINER function.
GRANT EXECUTE ON FUNCTION is_work_intake_session() TO control_room_application,
  control_room_reader, control_room_backup, control_room_work_intake;
GRANT INSERT ON control_action_inbox TO control_room_work_intake;
-- MIG-A: the shared intake login is the proposer the orchestrator runs as, so it
-- appends one split suggestion and reads back only the ones still bound to the
-- batch's current revision. It is granted NO counter and NO Needs-you row.
GRANT SELECT, INSERT ON work_batch_split_suggestions TO control_room_work_intake;
GRANT SELECT ON work_batch_current_split_suggestions TO control_room_work_intake;
REVOKE ALL ON control_planner_failure_counters, control_planner_needs_you_items FROM control_room_work_intake;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM control_room_github_broker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM control_room_github_broker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM control_room_work_intake;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM control_room_work_intake;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM control_room_application, control_room_reader, control_room_backup, control_room_schedule_admissions;
-- MIG-A 0203: EXECUTE on the split-suggestion visibility predicate, granted HERE
-- rather than in the migration. This file runs after every migration and after
-- the ALTER DEFAULT PRIVILEGES above, which is the only place a function grant
-- survives a fresh install and an upgrade alike -- a grant inside 0203 is
-- re-revoked by that line before anybody connects.
--
-- The intake login needs it because 0203 now calls the predicate from the view's
-- WHERE clause, and a view's WHERE clause is privilege-checked against
-- session_user, not against the view's owner. The predicate returns one boolean
-- about three values the caller already supplied, so this is not a window onto
-- work_batches or work_intake_tenant_binding.
GRANT EXECUTE ON FUNCTION work_intake_split_suggestion_visible(text, text, text)
  TO control_room_work_intake;
