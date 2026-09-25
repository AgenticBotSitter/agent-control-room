import type { PrivateWebProcessOptions } from "./private-process";
import { WebTaskReviewService } from "./task-review-service";
import { WebTaskVerificationService } from "./task-verification-service";
import { createTaskCoordinatorLifecycle, type TaskCoordinatorConfiguration, type TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import type { MacLocalCanonicalTaskOperationsV1 } from "./mac-local-web-process";
import { validateTaskQualityKeys } from "./task-quality-coordinator";

/**
 * The Mac-local counterpart to the hosted task application composition.
 *
 * It deliberately does not create a planner, queue, result store, review
 * store, or worker.  It assembles the existing controller lifecycle and
 * exposes only its already-scoped browser operations to the loopback site.
 * The web and coordinator connections may reach the same PostgreSQL database,
 * but must remain different restricted role connections.
 */
export type MacLocalTaskApplicationV1 = Readonly<{
  operations: MacLocalCanonicalTaskOperationsV1;
  isReady(): boolean;
  close(): Promise<void>;
  queueDelivery?: ReturnType<typeof createTaskCoordinatorLifecycle>["queueDelivery"];
  queueRecovery?: ReturnType<typeof createTaskCoordinatorLifecycle>["queueRecovery"];
  results?: ReturnType<typeof createTaskCoordinatorLifecycle>["results"];
  quality?: ReturnType<typeof createTaskCoordinatorLifecycle>["quality"];
}>;

export type MacLocalTaskApplicationInputV1 = Readonly<{
  web: Pick<PrivateWebProcessOptions, "tenantId" | "workspaceId" | "tasks" | "ideaProjects"> & {
    database: TaskCoordinatorDatabase;
  };
  coordinator: TaskCoordinatorConfiguration;
  clock?: () => number;
}>;

/**
 * Builds the browser-facing half of the existing task lifecycle for one Mac.
 * Starting a queue poller or a local adapter remains a separate, explicit
 * service action; constructing this object cannot start a task.
 */
export async function createMacLocalTaskApplicationV1(input: MacLocalTaskApplicationInputV1): Promise<MacLocalTaskApplicationV1> {
  const web = input?.web, coordinator = input?.coordinator;
  if (!web?.database?.client || typeof web.database.close !== "function" || !coordinator?.database?.client
    || typeof coordinator.database.close !== "function" || !web.tenantId || !web.workspaceId
    || web.tenantId !== coordinator.scope?.tenantId || web.workspaceId !== coordinator.scope?.workspaceId
    || web.database.client === coordinator.database.client)
    throw new Error("mac_local_task_application_config_invalid");

  const tasks = web.tasks;
  if (tasks?.ownerReviews && (!tasks.harnessIntegrityKey || !tasks.results))
    throw new Error("mac_local_task_application_config_invalid");
  if (tasks?.manualVerificationScenarios && (!tasks.harnessIntegrityKey || !tasks.results || !tasks.reviews))
    throw new Error("mac_local_task_application_config_invalid");
  if (coordinator.quality) validateTaskQualityKeys(coordinator.quality, coordinator.planning.reviewIntegrityKey, tasks);

  let lifecycle: ReturnType<typeof createTaskCoordinatorLifecycle> | undefined;
  try {
    lifecycle = createTaskCoordinatorLifecycle(coordinator);
    const clock = input.clock ?? Date.now;
    const ownerReviews = tasks?.ownerReviews ? new WebTaskReviewService(web.database.client,
      { tenantId: web.tenantId, workspaceId: web.workspaceId }, {
        ...tasks.ownerReviews, harnessIntegrityKey: tasks.harnessIntegrityKey!, results: tasks.results!,
        ideaIntegrityKey: web.ideaProjects?.integrityKey,
      }, clock) : undefined;
    const ownerVerifications = tasks?.manualVerificationScenarios ? new WebTaskVerificationService(web.database.client,
      { tenantId: web.tenantId, workspaceId: web.workspaceId }, {
        ...tasks.reviews!, harnessIntegrityKey: tasks.harnessIntegrityKey!, results: tasks.results!,
        ideaIntegrityKey: web.ideaProjects?.integrityKey, manualVerificationScenarios: tasks.manualVerificationScenarios,
      }, clock) : undefined;
    const operations: MacLocalCanonicalTaskOperationsV1 = Object.freeze({
      planning: lifecycle.planning,
      assignment: lifecycle.assignment,
      ...(lifecycle.approvals ? { approvals: lifecycle.approvals } : {}),
      // Deliberately `macLocalSubmission`, never `lifecycle.submission`: the
      // latter's `enqueue` is the remote, signed-packet `enqueueNativeTask`
      // path, which the Mac-local site must never be able to reach.
      ...(lifecycle.macLocalSubmission ? { submission: lifecycle.macLocalSubmission } : {}),
      ...(lifecycle.revisions ? { revisions: lifecycle.revisions } : {}),
      ...(ownerReviews ? { ownerReviews } : {}),
      ...(ownerVerifications ? { ownerVerifications } : {}),
    });
    return Object.freeze({
      operations,
      isReady: lifecycle.isReady.bind(lifecycle),
      close: lifecycle.close.bind(lifecycle),
      ...(lifecycle.queueDelivery ? { queueDelivery: lifecycle.queueDelivery } : {}),
      ...(lifecycle.queueRecovery ? { queueRecovery: lifecycle.queueRecovery } : {}),
      ...(lifecycle.results ? { results: lifecycle.results } : {}),
      ...(lifecycle.quality ? { quality: lifecycle.quality } : {}),
    });
  } catch (error) {
    if (lifecycle) {
      try { await lifecycle.close(); }
      catch { throw new Error("mac_local_task_application_cleanup_uncertain"); }
    }
    throw error;
  }
}
