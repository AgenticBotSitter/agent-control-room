import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "./private-task-startup";
import { createPrivateNodeService } from "./private-serving";
import { createInstalledNativeQueueFactories } from "./installed-native-queue";
import { createPrivatePostgresDatabase } from "./private-postgres";
import { installPrivateApplication } from "./private-process";

type Serving = Parameters<typeof createPrivateNodeService>[0];
/** Trusted in-process composition. Construction is inert; start may open databases,
 * pick up approved work and bind loopback, and requires deployment/rehearsal authority.
 * Configuration/keys/assets must already be supplied by trusted operator setup.
 */
export function createPrivateTaskHost(dependencies: Parameters<typeof createPrivateTaskBootstrap>[0] & {
  createServer?: Serving["createServer"];
}) {
  const bootstrap = createPrivateTaskBootstrap(dependencies);
  const createServer = dependencies.createServer;
  let attempted = false;
  return Object.freeze({ async start(input: {
    configuration: PrivateTaskStartupConfiguration; port: number;
    handler: Serving["handler"]; assets: Serving["assets"];
  }) {
    if (attempted) throw new Error("private_task_host_already_attempted");
    attempted = true;
    const { port, handler, assets } = input, origin = input.configuration.web.origin;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof handler !== "function"
      || !assets || typeof assets.respond !== "function") throw new Error("private_task_host_config_invalid");
    const application = await bootstrap.start(input.configuration);
    let closing: Promise<void> | undefined;
    const closeApplication = () => closing ??= Promise.resolve().then(() => application.close());
    let service: ReturnType<typeof createPrivateNodeService> | undefined;
    try {
      service = createPrivateNodeService({ origin, port, handler, assets, createServer,
        application: { isReady: application.isReady, close: closeApplication } });
      await service.start();
      return Object.freeze({ ...application, isReady: service.isReady, close: service.close });
    } catch {
      const results = await Promise.allSettled([service?.close(), closeApplication()]);
      if (results.some(result => result.status === "rejected")) throw new Error("private_task_host_cleanup_uncertain");
      throw new Error("private_task_host_start_failed");
    }
  } });
}

/** Real PostgreSQL and pinned installed queue package; no PGlite production fallback.
 * No listener, pool, environment or credential read occurs at construction/import.
 */
export function createInstalledPrivateTaskHost() {
  return createPrivateTaskHost({ openDatabase: createPrivatePostgresDatabase, install: installPrivateApplication,
    ...createInstalledNativeQueueFactories({ openWorkerDatabase: createPrivatePostgresDatabase }) });
}
