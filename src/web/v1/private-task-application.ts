import { createPrivateWebProcess, type PrivateWebProcessOptions } from "./private-process";
import { createTaskCoordinatorLifecycle, type TaskCoordinatorConfiguration, type TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import { validateTaskQualityKeys } from "./task-quality-coordinator";
import { timingSafeEqual } from "node:crypto";
import { DatabaseOperatorFleetReadSourceV1, OperatorSurfaceReadServiceV1, OperatorSurfaceStoreV1 } from "../../operator-surfaces/v1";
import { ServiceIncidentStore } from "../../services/v1/incident-store";

/** Trusted composition for two separately verified resources; not a deployment preflight bypass.
 * No pools are opened here. The separate task bootstrap verifies both roles before calling this factory.
 */
export async function createPrivateTaskApplication(web: Omit<PrivateWebProcessOptions, "planning" | "assignment" | "approvals" | "submission" | "revisions" | "queueAttention" | "ideaCreation" | "ideaResultProjection" | "database"> & { database: TaskCoordinatorDatabase },
  coordinator: TaskCoordinatorConfiguration) {
  if ("ideaCreation" in web || "ideaResultProjection" in web || "planning" in web || "assignment" in web || "approvals" in web || "submission" in web || "revisions" in web || "queueAttention" in web || web.tenantId !== coordinator.scope.tenantId
    || web.workspaceId !== coordinator.scope.workspaceId || web.database.client === coordinator.database.client
    || coordinator.resultDatabase?.client === web.database.client
    || coordinator.evidence?.database.client === web.database.client
    || coordinator.sessions?.database.client === web.database.client
    || coordinator.ideaCreation?.database.client === web.database.client
    || coordinator.ideaRuntime?.database.client === web.database.client
    || typeof web.database.isAvailable !== "function" || typeof web.database.close !== "function")
    throw new Error("private_task_application_config_invalid");
  if (coordinator.ideaCreation && (!web.ideaProjects
    || !(coordinator.ideaCreation.integrityKey instanceof Uint8Array)
    || !(web.ideaProjects.integrityKey instanceof Uint8Array)
    || coordinator.ideaCreation.integrityKey.length !== 32 || web.ideaProjects.integrityKey.length !== 32
    || !timingSafeEqual(coordinator.ideaCreation.integrityKey, web.ideaProjects.integrityKey)))
    throw new Error("private_task_application_config_invalid");
  // Until construction succeeds, the caller retains both resources.
  if (coordinator.quality) validateTaskQualityKeys(coordinator.quality, coordinator.planning.reviewIntegrityKey, web.tasks);
  const tasks = createTaskCoordinatorLifecycle(coordinator);
  // The coordinator-side pool already owns the canonical task records. Give
  // the web process only a narrow read callback, never that pool or a worker
  // control handle. This uses the existing operator projection rather than a
  // local dashboard cache, so the same screen can later serve local and remote
  // workers from the one installation database.
  const operatorSurfaceService = new OperatorSurfaceReadServiceV1(
    new OperatorSurfaceStoreV1(coordinator.database.client),
    new ServiceIncidentStore(coordinator.database.client),
    new DatabaseOperatorFleetReadSourceV1(coordinator.database.client),
  );
  const operatorSurface = Object.freeze({ read: async (input: {
    tenantId: string; actorId: string; grantedAt: string; now: string;
  }) => (await operatorSurfaceService.read({
    scope: { tenantId: input.tenantId, actorId: input.actorId, grantedAt: input.grantedAt }, now: input.now,
  })).snapshot });
  const available = web.database.isAvailable.bind(web.database), closePool = web.database.close.bind(web.database);
  let poolClose: Promise<void> | undefined;
  const database = { client: web.database.client, close: () => {
    poolClose ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(closePool), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("private_task_application_cleanup_uncertain")), 5000);
      })]); } finally { clearTimeout(timer); }
    })();
    return poolClose;
  } };
  let app: ReturnType<typeof createPrivateWebProcess>;
  try { app = createPrivateWebProcess({ ...web, database, operatorSurface, planning: tasks.planning, assignment: tasks.assignment, approvals: tasks.approvals, submission: tasks.submission, revisions: tasks.revisions, queueAttention: tasks.queueAttention, ideaCreation: tasks.ideaCreation, ideaResultProjection: tasks.ideaResultProjection }); }
  catch {
    const results = await Promise.allSettled([tasks.close(), database.close()]);
    if (results.some(result => result.status === "rejected")) throw new Error("private_task_application_cleanup_uncertain");
    throw new Error("private_task_application_install_failed");
  }
  let closing = false, closePromise: Promise<void> | undefined;
  return Object.freeze({
    ...(tasks.queueDelivery ? { queueDelivery: tasks.queueDelivery } : {}),
    // Narrow authenticated submission is shared with HTTP; recovery stays server-only.
    ...(tasks.submission ? { submission: tasks.submission } : {}),
    ...(tasks.queueRecovery ? { queueRecovery: tasks.queueRecovery } : {}),
    ...(tasks.quality ? { quality: tasks.quality } : {}),
    ...(tasks.revisions ? { revisions: tasks.revisions } : {}),
    ...(tasks.results ? { results: tasks.results } : {}),
    ...(tasks.evidence ? { evidence: tasks.evidence } : {}),
    ...(tasks.connections ? { connections: tasks.connections } : {}),
    ...(tasks.nativeHttp ? { nativeHttp: tasks.nativeHttp } : {}),
    isReady: () => !closing && available() && tasks.isReady(),
    handle: app.handle.bind(app),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const results = await Promise.allSettled([app.close(), tasks.close()]);
        if (results.some(result => result.status === "rejected")) throw new Error("private_task_application_cleanup_uncertain");
      })();
      return closePromise;
    },
  });
}
