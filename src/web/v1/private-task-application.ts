import { createPrivateWebProcess, type PrivateWebProcessOptions } from "./private-process";
import { createTaskCoordinatorLifecycle, type TaskCoordinatorConfiguration, type TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";

/** Trusted composition for two separately verified resources; not a deployment preflight bypass.
 * No pools are opened here. Production bootstrap remains unconfigured pending a coordinator role gate.
 */
export async function createPrivateTaskApplication(web: Omit<PrivateWebProcessOptions, "planning" | "assignment" | "database"> & { database: TaskCoordinatorDatabase },
  coordinator: TaskCoordinatorConfiguration) {
  if ("planning" in web || "assignment" in web || web.tenantId !== coordinator.scope.tenantId
    || web.workspaceId !== coordinator.scope.workspaceId || web.database.client === coordinator.database.client
    || typeof web.database.isAvailable !== "function" || typeof web.database.close !== "function")
    throw new Error("private_task_application_config_invalid");
  // Until construction succeeds, the caller retains both resources.
  const tasks = createTaskCoordinatorLifecycle(coordinator);
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
  try { app = createPrivateWebProcess({ ...web, database, planning: tasks.planning, assignment: tasks.assignment }); }
  catch {
    const results = await Promise.allSettled([tasks.close(), database.close()]);
    if (results.some(result => result.status === "rejected")) throw new Error("private_task_application_cleanup_uncertain");
    throw new Error("private_task_application_install_failed");
  }
  let closing = false, closePromise: Promise<void> | undefined;
  return Object.freeze({
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
