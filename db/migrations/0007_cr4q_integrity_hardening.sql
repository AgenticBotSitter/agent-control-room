-- CR-4Q independent review hardening. Tenant scope and lineage must survive
-- a public implementation and must not depend only on globally unique IDs.

ALTER TABLE adapter_registry ADD CONSTRAINT uq_adapter_registry_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE projects ADD CONSTRAINT uq_projects_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE work_items ADD CONSTRAINT uq_work_items_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE worker_runtimes ADD CONSTRAINT uq_worker_runtimes_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE agent_identities ADD CONSTRAINT uq_agent_identities_tenant_id UNIQUE (tenant_id, id);
ALTER TABLE worker_capability_routes ADD CONSTRAINT uq_worker_routes_tenant_id UNIQUE (tenant_id, id);

ALTER TABLE projects DROP CONSTRAINT projects_workspace_id_fkey;
ALTER TABLE projects DROP CONSTRAINT projects_adapter_id_fkey;
ALTER TABLE projects ADD CONSTRAINT fk_projects_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE projects ADD CONSTRAINT fk_projects_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE work_items DROP CONSTRAINT work_items_workspace_id_fkey;
ALTER TABLE work_items DROP CONSTRAINT work_items_project_id_fkey;
ALTER TABLE work_items DROP CONSTRAINT work_items_adapter_id_fkey;
ALTER TABLE work_items ADD CONSTRAINT fk_work_items_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE work_items ADD CONSTRAINT fk_work_items_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE work_items ADD CONSTRAINT fk_work_items_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE executions DROP CONSTRAINT executions_workspace_id_fkey;
ALTER TABLE executions DROP CONSTRAINT executions_project_id_fkey;
ALTER TABLE executions DROP CONSTRAINT executions_work_item_id_fkey;
ALTER TABLE executions DROP CONSTRAINT executions_adapter_id_fkey;
ALTER TABLE executions ADD CONSTRAINT fk_executions_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE executions ADD CONSTRAINT fk_executions_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE executions ADD CONSTRAINT fk_executions_tenant_work_item
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_items(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE executions ADD CONSTRAINT fk_executions_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE blockers DROP CONSTRAINT blockers_workspace_id_fkey;
ALTER TABLE blockers DROP CONSTRAINT blockers_project_id_fkey;
ALTER TABLE blockers DROP CONSTRAINT blockers_work_item_id_fkey;
ALTER TABLE blockers DROP CONSTRAINT blockers_adapter_id_fkey;
ALTER TABLE blockers ADD CONSTRAINT fk_blockers_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE blockers ADD CONSTRAINT fk_blockers_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE blockers ADD CONSTRAINT fk_blockers_tenant_work_item
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_items(tenant_id, id) ON DELETE SET NULL (work_item_id);
ALTER TABLE blockers ADD CONSTRAINT fk_blockers_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE attention_items DROP CONSTRAINT attention_items_workspace_id_fkey;
ALTER TABLE attention_items DROP CONSTRAINT attention_items_project_id_fkey;
ALTER TABLE attention_items DROP CONSTRAINT attention_items_work_item_id_fkey;
ALTER TABLE attention_items DROP CONSTRAINT attention_items_adapter_id_fkey;
ALTER TABLE attention_items ADD CONSTRAINT fk_attention_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE attention_items ADD CONSTRAINT fk_attention_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE attention_items ADD CONSTRAINT fk_attention_tenant_work_item
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_items(tenant_id, id) ON DELETE SET NULL (work_item_id);
ALTER TABLE attention_items ADD CONSTRAINT fk_attention_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE worker_capability_routes DROP CONSTRAINT worker_capability_routes_worker_id_fkey;
ALTER TABLE worker_capability_routes ADD CONSTRAINT fk_worker_routes_tenant_worker
  FOREIGN KEY (tenant_id, worker_id) REFERENCES worker_runtimes(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE workspace_agent_grants DROP CONSTRAINT workspace_agent_grants_workspace_id_fkey;
ALTER TABLE workspace_agent_grants DROP CONSTRAINT workspace_agent_grants_agent_id_fkey;
ALTER TABLE workspace_agent_grants ADD CONSTRAINT fk_workspace_grants_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE workspace_agent_grants ADD CONSTRAINT fk_workspace_grants_tenant_agent
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agent_identities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE project_worker_allocations DROP CONSTRAINT project_worker_allocations_project_id_fkey;
ALTER TABLE project_worker_allocations DROP CONSTRAINT project_worker_allocations_worker_id_fkey;
ALTER TABLE project_worker_allocations ADD CONSTRAINT fk_allocations_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE project_worker_allocations ADD CONSTRAINT fk_allocations_tenant_worker
  FOREIGN KEY (tenant_id, worker_id) REFERENCES worker_runtimes(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE capability_benchmarks DROP CONSTRAINT capability_benchmarks_route_id_fkey;
ALTER TABLE capability_benchmarks ADD CONSTRAINT fk_benchmarks_tenant_route
  FOREIGN KEY (tenant_id, route_id) REFERENCES worker_capability_routes(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE recommendations DROP CONSTRAINT recommendations_workspace_id_fkey;
ALTER TABLE recommendations DROP CONSTRAINT recommendations_project_id_fkey;
ALTER TABLE recommendations DROP CONSTRAINT recommendations_worker_id_fkey;
ALTER TABLE recommendations ADD CONSTRAINT fk_recommendations_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE recommendations ADD CONSTRAINT fk_recommendations_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE recommendations ADD CONSTRAINT fk_recommendations_tenant_worker
  FOREIGN KEY (tenant_id, worker_id) REFERENCES worker_runtimes(tenant_id, id) ON DELETE SET NULL (worker_id);

ALTER TABLE command_receipts DROP CONSTRAINT command_receipts_adapter_id_fkey;
ALTER TABLE command_receipts DROP CONSTRAINT command_receipts_workspace_id_fkey;
ALTER TABLE command_receipts DROP CONSTRAINT command_receipts_project_id_fkey;
ALTER TABLE command_receipts ADD CONSTRAINT fk_command_receipts_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE command_receipts ADD CONSTRAINT fk_command_receipts_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE command_receipts ADD CONSTRAINT fk_command_receipts_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_workspace_id_fkey;
ALTER TABLE audit_events DROP CONSTRAINT audit_events_project_id_fkey;
ALTER TABLE audit_events ADD CONSTRAINT fk_audit_events_tenant_workspace
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE audit_events ADD CONSTRAINT fk_audit_events_tenant_project
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id) ON DELETE RESTRICT;

-- Projection feed rows now carry tenant scope themselves. Drop the append-only
-- row trigger only for this deterministic backfill, then restore it.
DROP TRIGGER IF EXISTS projection_changes_append_only ON projection_changes;
ALTER TABLE projection_cursors ADD COLUMN tenant_id text;
ALTER TABLE projection_changes ADD COLUMN tenant_id text;
UPDATE projection_cursors c SET tenant_id=a.tenant_id FROM adapter_registry a WHERE a.id=c.adapter_id;
UPDATE projection_changes c SET tenant_id=a.tenant_id FROM adapter_registry a WHERE a.id=c.adapter_id;
ALTER TABLE projection_cursors ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE projection_changes ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE projection_cursors ADD CONSTRAINT fk_projection_cursors_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE projection_changes ADD CONSTRAINT fk_projection_changes_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
ALTER TABLE projection_cursors DROP CONSTRAINT projection_cursors_adapter_id_fkey;
ALTER TABLE projection_changes DROP CONSTRAINT projection_changes_adapter_id_fkey;
ALTER TABLE projection_cursors ADD CONSTRAINT fk_projection_cursors_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE projection_changes ADD CONSTRAINT fk_projection_changes_tenant_adapter
  FOREIGN KEY (tenant_id, adapter_id) REFERENCES adapter_registry(tenant_id, id) ON DELETE CASCADE;
CREATE TRIGGER projection_changes_append_only
BEFORE UPDATE OR DELETE ON projection_changes
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Canonical lineage that carries authority must agree across every edge.
ALTER TABLE control_workflows ADD CONSTRAINT uq_control_workflows_tenant_id_project UNIQUE (tenant_id, id, project_id);
ALTER TABLE control_jobs ADD CONSTRAINT uq_control_jobs_tenant_id_project UNIQUE (tenant_id, id, project_id);
ALTER TABLE control_jobs ADD CONSTRAINT uq_control_jobs_tenant_id_workflow_project UNIQUE (tenant_id, id, workflow_id, project_id);
ALTER TABLE control_attempts ADD CONSTRAINT uq_control_attempts_tenant_id_job UNIQUE (tenant_id, id, job_id);

ALTER TABLE control_jobs DROP CONSTRAINT control_jobs_tenant_id_workflow_id_fkey;
ALTER TABLE control_jobs ADD CONSTRAINT fk_control_jobs_tenant_workflow_project
  FOREIGN KEY (tenant_id, workflow_id, project_id) REFERENCES control_workflows(tenant_id, id, project_id) ON DELETE RESTRICT;
ALTER TABLE control_leases DROP CONSTRAINT control_leases_tenant_id_attempt_id_fkey;
ALTER TABLE control_leases ADD CONSTRAINT fk_control_leases_tenant_attempt_job
  FOREIGN KEY (tenant_id, attempt_id, job_id) REFERENCES control_attempts(tenant_id, id, job_id) ON DELETE RESTRICT;
ALTER TABLE control_effect_intents DROP CONSTRAINT control_effect_intents_tenant_id_attempt_id_fkey;
ALTER TABLE control_effect_intents ADD CONSTRAINT fk_control_effects_tenant_attempt_job
  FOREIGN KEY (tenant_id, attempt_id, job_id) REFERENCES control_attempts(tenant_id, id, job_id) ON DELETE RESTRICT;
ALTER TABLE control_artifact_manifests DROP CONSTRAINT control_artifact_manifests_tenant_id_attempt_id_fkey;
ALTER TABLE control_artifact_manifests ADD CONSTRAINT fk_control_artifacts_tenant_attempt_job
  FOREIGN KEY (tenant_id, attempt_id, job_id) REFERENCES control_attempts(tenant_id, id, job_id) ON DELETE RESTRICT;
ALTER TABLE control_artifact_manifests DROP CONSTRAINT control_artifact_manifests_tenant_id_job_id_fkey;
ALTER TABLE control_artifact_manifests ADD CONSTRAINT fk_control_artifacts_tenant_job_project
  FOREIGN KEY (tenant_id, job_id, project_id) REFERENCES control_jobs(tenant_id, id, project_id) ON DELETE RESTRICT;
ALTER TABLE control_artifact_manifests DROP CONSTRAINT control_artifact_manifests_tenant_id_workflow_id_fkey;
ALTER TABLE control_artifact_manifests ADD CONSTRAINT fk_control_artifacts_tenant_workflow_project
  FOREIGN KEY (tenant_id, workflow_id, project_id) REFERENCES control_workflows(tenant_id, id, project_id) ON DELETE RESTRICT;

ALTER TABLE control_transition_events ADD CONSTRAINT uq_control_transition_idempotency
  UNIQUE (tenant_id, entity_kind, idempotency_key);
