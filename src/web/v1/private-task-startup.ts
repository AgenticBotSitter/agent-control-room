import { assertNoSecretMaterial } from "../../security";
import { localId } from "../../harness/v1/native-run-identifiers";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { verifyPrivateDatabase, verifyTaskCoordinatorDatabase } from "./private-database-preflight";
import { validatePrivateStartupConfiguration, type PrivateStartupConfiguration } from "./private-startup";
import { installPrivateApplication } from "./private-process";
import { createPrivateTaskApplication } from "./private-task-application";
import { nativeTaskTemplateSchema } from "./task-execution-planner";
import { validateTaskAssignmentRoutes, validateNativeApprovalEnrollments } from "./task-assignment-coordinator";
import type { TaskCoordinatorConfiguration, TaskCoordinatorDatabase } from "./task-coordinator-lifecycle";
import { captureTaskQualityConfiguration, validateTaskQualityKeys } from "./task-quality-coordinator";

export type PrivateTaskStartupConfiguration = {
  web: PrivateStartupConfiguration;
  coordinator: Pick<TaskCoordinatorConfiguration, "planning" | "routes" | "approvals" | "quality"> & { database: PrivatePostgresConfiguration };
};
function configuration(input: PrivateTaskStartupConfiguration) {
  try {
    const web = validatePrivateStartupConfiguration(input.web);
    localId.parse(web.tenantId); localId.parse(web.workspaceId);
    const database = validatePrivatePostgresConfiguration(input.coordinator.database);
    if (database.host !== web.database.host || database.port !== web.database.port || database.database !== web.database.database
      || database.username === web.database.username) throw new Error();
    const key = (value: Uint8Array) => { if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error(); return Uint8Array.from(value); };
    const p = input.coordinator.planning, template = nativeTaskTemplateSchema.parse(p.template);
    assertNoSecretMaterial(template);
    const read = p.checkpoints.read.bind(p.checkpoints);
    const denied = (): never => { throw new Error("private_task_checkpoint_write_denied"); };
    const planning = { template, integrityKey: key(p.integrityKey), reviewIntegrityKey: key(p.reviewIntegrityKey),
      checkpoints: Object.freeze({ read, initialize: denied, advance: denied }),
      ...(p.ideaIntegrityKey ? { ideaIntegrityKey: key(p.ideaIntegrityKey) } : {}) };
    const routes = validateTaskAssignmentRoutes(input.coordinator.routes), a = input.coordinator.approvals;
    if (a && (typeof a.store?.acceptInSession !== "function" || typeof a.store?.readInSession !== "function")) throw new Error();
    const approvals = a ? { enrollments: validateNativeApprovalEnrollments(a.enrollments, web.tenantId, routes), store: a.store } : undefined;
    const quality = input.coordinator.quality ? captureTaskQualityConfiguration(input.coordinator.quality) : undefined;
    if (quality) validateTaskQualityKeys(quality, planning.reviewIntegrityKey, web.tasks);
    return { web, database, planning, routes, approvals, quality };
  } catch { throw new Error("private_task_startup_config_invalid"); }
}

/** Trusted server-only startup. Import is inert; explicit start is the first possible pool effect.
 * Both logins must independently pass their fixed gate against one primary before shared mounting.
 * Never opens a listener, provisions SQL, loads credentials or starts agent work.
 */
export function createPrivateTaskBootstrap(dependencies: {
  openDatabase: (config: PrivatePostgresConfiguration) => TaskCoordinatorDatabase;
  install: typeof installPrivateApplication; clock?: () => number;
}) {
  let started = false;
  return Object.freeze({ async start(input: PrivateTaskStartupConfiguration) {
    if (started) throw new Error("private_task_startup_already_attempted");
    started = true;
    const config = configuration(input);
    const acquired: TaskCoordinatorDatabase[] = [];
    const resources = new Set<TaskCoordinatorDatabase>();
    let application: Awaited<ReturnType<typeof createPrivateTaskApplication>> | undefined;
    // Own every returned resource immediately; memoized bounded close tolerates construction failure
    // before or after ownership transfers to the combined application, without a second pool close.
    function open(database: PrivatePostgresConfiguration) {
      const raw = dependencies.openDatabase(database);
      if (resources.has(raw)) throw new Error("private_task_startup_shared_resource");
      resources.add(raw);
      let closing: Promise<void> | undefined;
      const close = raw.close.bind(raw);
      const owned = Object.freeze({ client: raw.client, isAvailable: raw.isAvailable.bind(raw), close: () => {
        closing ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("private_task_startup_cleanup_uncertain")), 5000);
          })]); } finally { clearTimeout(timer); }
        })();
        return closing;
      } });
      acquired.push(owned); return owned;
    }
    try {
      const clock = dependencies.clock ?? Date.now;
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      const web = open(config.web.database);
      await verifyPrivateDatabase(web.client, config.web.database, config.web, now);
      const coordinator = open(config.database);
      if (web.client === coordinator.client) throw new Error();
      await verifyTaskCoordinatorDatabase(coordinator.client, config.database, config.web, now);
      if (!web.isAvailable() || !coordinator.isAvailable()) throw new Error();
      application = await createPrivateTaskApplication({ ...config.web, database: web, clock }, {
        scope: { tenantId: config.web.tenantId, workspaceId: config.web.workspaceId }, database: coordinator,
        planning: config.planning, routes: config.routes, approvals: config.approvals, quality: config.quality, clock,
      });
      if (!application.isReady()) throw new Error();
      dependencies.install(application);
      // Only the optional scoped quality command is exposed to trusted server composition, never HTTP or raw SQL/keys.
      return Object.freeze({ isReady: application.isReady, close: application.close,
        ...(application.quality ? { quality: application.quality } : {}) });
    } catch {
      const results = await Promise.allSettled(application ? [application.close()] : acquired.map(pool => pool.close()));
      if (results.some(result => result.status === "rejected")) throw new Error("private_task_startup_cleanup_uncertain");
      throw new Error("private_task_startup_prerequisites_failed");
    }
  } });
}
const production = createPrivateTaskBootstrap({ openDatabase: createPrivatePostgresDatabase, install: installPrivateApplication });
export const startPrivateTaskApplication = production.start;
