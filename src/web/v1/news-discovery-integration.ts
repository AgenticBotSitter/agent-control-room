import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { absFeedJobReferenceSchema, type AbsFeedJobReference } from "../../persistence/pg-boss-abs-feed-worker";
import { absDiscoveryJobConfigurationSchema } from "../../project-adapters/abs-news/v1/discovery-job-configuration";
import { AbsFeedPlanStore } from "../../project-adapters/abs-news/v1/feed-plan-store";
import { createAbsFeedJobExecution } from "../../project-adapters/abs-news/v1/feed-job-execution";
import type { AbsCurrentSourceAuthority } from "../../project-adapters/abs-news/v1/current-source-authority";
import type { PinnedFetchDependencies } from "../../vendor/control-center/pinned-fetch";
import { localId } from "../../harness/v1/native-run-identifiers";
import { sha256Digest } from "../../security";
import { WebNewsCollectionPlanning } from "./news-collection-planning";
import { WebNewsCollectionAdmission } from "./news-collection-admission";

const schema = z.object({ tenantId: localId, workspaceId: localId,
  assignments: z.array(z.object({ configuration: absDiscoveryJobConfigurationSchema,
    nodeId: localId, executorId: localId.refine(value => value !== "executor:unassigned"),
    windowSeconds: z.number().int().min(60).max(3600) }).strict()).min(1).max(100),
}).strict();

export function captureNewsDiscoveryConfiguration(value: unknown) {
  const input = schema.parse(value), sources = new Set<string>(), workers = new Map<string, string>();
  for (const assignment of input.assignments) {
    const config = assignment.configuration, route = JSON.stringify([config.projectId, config.source.sourceId]);
    const worker = JSON.stringify([assignment.nodeId, assignment.executorId]);
    if (config.tenantId !== input.tenantId || config.workspaceId !== input.workspaceId || sources.has(route))
      throw new Error("news_integration_config_invalid");
    if (workers.has(config.projectId) && workers.get(config.projectId) !== worker)
      throw new Error("news_integration_assignment_conflict");
    sources.add(route); workers.set(config.projectId, worker);
  }
  return input;
}

/** Assembly only. Caller retains ownership of separately verified pools, prepared
 * submission and qualified transport. Construction performs no reads or startup.
 * Pass web operations into the private process and collect into the existing news
 * worker; drain that worker before closing these supplied resources. */
export function createNewsDiscoveryIntegration(value: unknown, databases: { coordinator: DatabaseClient; ingestion: DatabaseClient },
  keyValue: Uint8Array, submission: { enqueueInSession(tx: DatabaseSession, reference: AbsFeedJobReference): Promise<void> },
  source: AbsCurrentSourceAuthority, ports: Required<Pick<PinnedFetchDependencies, "lookup" | "fetch">>, clock: () => number = Date.now) {
  const input = captureNewsDiscoveryConfiguration(value);
  if (!(keyValue instanceof Uint8Array) || keyValue.length !== 32 || databases.coordinator === databases.ingestion)
    throw new Error("news_integration_config_invalid");
  const key = Uint8Array.from(keyValue), keys = new Set<string>();
  const projects = new Map<string, { nodeId: string; executorId: string; configurations: Set<string>;
    plans: AbsFeedPlanStore; executor: ReturnType<typeof createAbsFeedJobExecution> }>();
  const web = input.assignments.map(assignment => {
    const { configuration, nodeId, executorId } = assignment, { tenantId, workspaceId, projectId } = configuration;
    const sourceId = configuration.source.sourceId, routeKey = JSON.stringify([projectId, sourceId]);
    if (tenantId !== input.tenantId || workspaceId !== input.workspaceId || keys.has(routeKey)) throw new Error("news_integration_config_invalid");
    keys.add(routeKey);
    const scope = { tenantId, workspaceId, projectId, nodeId, executorId };
    const existing = projects.get(projectId);
    if (existing && (existing.nodeId !== nodeId || existing.executorId !== executorId)) throw new Error("news_integration_assignment_conflict");
    const project = existing ?? { nodeId, executorId, configurations: new Set<string>(),
      plans: new AbsFeedPlanStore(databases.coordinator, { tenantId, workspaceId, projectId }, key),
      executor: createAbsFeedJobExecution(databases, scope, key, source, clock, undefined, ports) };
    project.configurations.add(sha256Digest(configuration)); projects.set(projectId, project);
    const planning = new WebNewsCollectionPlanning(databases.coordinator,
      { configuration, executorId, windowSeconds: assignment.windowSeconds }, key, clock);
    const admission = new WebNewsCollectionAdmission(databases.coordinator, scope, key, submission, clock, "discovery");
    return Object.freeze({ tenantId, workspaceId, projectId, sourceId,
      planning: Object.freeze({ describe: planning.describe.bind(planning), status: planning.status.bind(planning), history: planning.history.bind(planning), propose: planning.propose.bind(planning) }),
      admission: Object.freeze({ approve: (identity: Parameters<typeof admission.approve>[0], request: unknown, expectedSourceId?: string) => {
        if (expectedSourceId !== undefined && expectedSourceId !== sourceId) return Promise.reject(new Error("news_integration_source_mismatch"));
        return admission.approve(identity, request, sourceId);
      } }) });
  });
  return Object.freeze({ web: Object.freeze(web),
    async collect(value: unknown, signal: AbortSignal) {
      signal.throwIfAborted();
      const reference = absFeedJobReferenceSchema.parse(value), project = projects.get(reference.projectId);
      if (reference.tenantId !== input.tenantId || !project) throw new Error("news_integration_route_unavailable");
      const work = await project.plans.get(reference.jobId); signal.throwIfAborted();
      if (!work || work.plan.schema !== "control-room.abs-discovery-plan/v1"
        || !project.configurations.has(sha256Digest(work.plan.configuration))) throw new Error("news_integration_plan_unavailable");
      return project.executor.collect(reference, signal);
    },
  });
}
