import type { DatabaseClient } from "../../persistence/database";
import type { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import type { MacLocalTaskRuntimeV1 } from "./mac-local-task-runtime";
import { buildMacLocalTaskTemplatesV1, MAC_LOCAL_MAX_PROJECTS_V1 } from "./mac-local-task-provider-templates";
import { createMacLocalTextScenarioV1 } from "./mac-local-owner-review-profile";
import type { NativeTaskTemplateRegistryV1 } from "./task-execution-planner";
import type { TaskQualityScenarioRegistryV1 } from "./task-quality-coordinator";

type Project = Readonly<{ projectId: string; createdAt: string }>;

/** Adds one active database project to the already-running Mac task
 * composition. The completion-gate registration is the same reviewed writer
 * used at startup; the in-flight map coalesces concurrent HTTP reads, while
 * the durable writer independently reconciles an exact replay. */
export function createMacLocalLiveProjectProvisionerV1(input: Readonly<{
  db: DatabaseClient;
  tenantId: string;
  workspaceId: string;
  configuration: MacLocalProtectedConfigurationV1;
  runtime: MacLocalTaskRuntimeV1;
  profileGate: Pick<CompletionGateStoreV1, "registerProfile">;
  templates: NativeTaskTemplateRegistryV1;
  scenarios: TaskQualityScenarioRegistryV1;
  initialProjects: readonly Project[];
}>) {
  const known = new Set(input.initialProjects.map(value => value.projectId));
  const pending = new Map<string, Promise<void>>();
  const ensureProject = (projectId: string): Promise<void> => {
    if (known.has(projectId)) return Promise.resolve();
    const existing = pending.get(projectId);
    if (existing) return existing;
    const operation = (async () => {
      const result = await input.db.query<{ project_id: string; created_at: string | Date; active_count: string }>(
        `SELECT p.id AS project_id,h.created_at,
          (SELECT count(*)::text FROM projects ap
            JOIN control_manual_project_heads ah ON ah.tenant_id=ap.tenant_id AND ah.project_id=ap.id
            WHERE ap.tenant_id=$1 AND ap.workspace_id=$2 AND ah.lifecycle='active') AS active_count
          FROM projects p JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
          WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND h.lifecycle='active'`,
        [input.tenantId, input.workspaceId, projectId]);
      const row = result.rows[0];
      if (!row) throw new Error("mac_local_project_unavailable");
      const count = Number(row.active_count);
      if (!Number.isSafeInteger(count) || count < 1 || count > MAC_LOCAL_MAX_PROJECTS_V1)
        throw new Error("mac_local_project_limit_50");
      const built = buildMacLocalTaskTemplatesV1([{ projectId: row.project_id,
        createdAt: new Date(row.created_at).toISOString() }], input.configuration, input.runtime);
      await input.profileGate.registerProfile(built.profiles[0]);
      input.templates.register(built.templates);
      input.scenarios.register([createMacLocalTextScenarioV1(built.profiles[0]!)]);
      known.add(projectId);
    })().finally(() => pending.delete(projectId));
    pending.set(projectId, operation);
    return operation;
  };
  return Object.freeze({ ensureProject, projectIds: () => Object.freeze([...known].sort()) });
}
