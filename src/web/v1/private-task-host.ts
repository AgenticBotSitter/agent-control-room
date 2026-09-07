import { createPrivateTaskBootstrap, type PrivateTaskStartupConfiguration } from "./private-task-startup";
export { bindPrivateHostShutdown } from "./private-host-shutdown";
export { startPrivateHostLifecycle } from "./private-host-lifecycle";
import { createPrivateNodeService } from "./private-serving";
import { createInstalledNativeQueueFactories } from "./installed-native-queue";
import { createPrivatePostgresDatabase } from "./private-postgres";
import { installPrivateApplication } from "./private-process";
import { captureNativeHttpsConfiguration, createNativeHttpsService, type NativeHttpsConfiguration } from "./native-https-service";

type Serving = Parameters<typeof createPrivateNodeService>[0];
/** Trusted in-process composition. Construction is inert; start may open databases,
 * pick up approved work and bind loopback, and requires deployment/rehearsal authority.
 * Configuration/keys/assets must already be supplied by trusted operator setup.
 */
export function createPrivateTaskHost(dependencies: Parameters<typeof createPrivateTaskBootstrap>[0] & {
  createServer?: Serving["createServer"];
  createNativeServer?: Parameters<typeof createNativeHttpsService>[0]["createServer"];
}) {
  const bootstrap = createPrivateTaskBootstrap(dependencies);
  const createServer = dependencies.createServer;
  const createNativeServer = dependencies.createNativeServer;
  let attempted = false;
  return Object.freeze({ async start(input: {
    configuration: PrivateTaskStartupConfiguration; port: number;
    handler: Serving["handler"]; assets: Serving["assets"];
    nativeHttps?: NativeHttpsConfiguration;
    signal?: AbortSignal;
  }) {
    if (attempted) throw new Error("private_task_host_already_attempted");
    attempted = true;
    const { port, handler, assets, signal } = input, origin = input.configuration.web.origin;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof handler !== "function"
      || !assets || typeof assets.respond !== "function") throw new Error("private_task_host_config_invalid");
    if (input.nativeHttps && (!input.configuration.coordinator.nativeHttp
      || Number(new URL(input.configuration.coordinator.nativeHttp.origin).port || 443) !== input.nativeHttps.port))
      throw new Error("private_task_host_config_invalid");
    const tls = input.nativeHttps ? captureNativeHttpsConfiguration(input.nativeHttps) : undefined;
    const erase = () => { tls?.key.fill(0); tls?.cert.fill(0); tls?.ca.fill(0); };
    let application: Awaited<ReturnType<typeof bootstrap.start>>;
    try { application = await bootstrap.start(input.configuration, signal); } catch (error) { erase(); throw error; }
    let closing: Promise<void> | undefined;
    let service: ReturnType<typeof createPrivateNodeService> | undefined;
    let native: ReturnType<typeof createNativeHttpsService> | undefined;
    const closeApplication = () => closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([application.close(), native?.close()]);
      if (results.some(result => result.status === "rejected")) throw new Error("private_task_host_cleanup_uncertain");
    });
    const ready = () => !closing && application.isReady() && (!native || native.isReady());
    const cancelStartup = () => { void (service ? service.close() : closeApplication()).catch(() => {}); };
    const requireActive = () => { if (signal?.aborted) throw new Error("private_task_host_start_canceled"); };
    signal?.addEventListener("abort", cancelStartup, { once: true });
    try {
      requireActive();
      if (tls) {
        if (!application.nativeHttp) throw new Error();
        native = createNativeHttpsService({ ...tls, application: application.nativeHttp, createServer: createNativeServer,
          onUnavailable: () => { void (service ? service.close() : closeApplication()).catch(() => {}); } });
        await native.start();
        requireActive();
      }
      service = createPrivateNodeService({ origin, port, handler, assets, createServer,
        application: { isReady: ready, close: closeApplication } });
      await service.start();
      requireActive();
      return Object.freeze({ ...application, isReady: service.isReady, close: service.close });
    } catch {
      const results = await Promise.allSettled([service?.close(), closeApplication()]);
      if (results.some(result => result.status === "rejected")) throw new Error("private_task_host_cleanup_uncertain");
      throw new Error("private_task_host_start_failed");
    } finally { signal?.removeEventListener("abort", cancelStartup); erase(); }
  } });
}

/** Real PostgreSQL and pinned installed queue package; no PGlite production fallback.
 * No listener, pool, environment or credential read occurs at construction/import.
 */
export function createInstalledPrivateTaskHost() {
  return createPrivateTaskHost({ openDatabase: createPrivatePostgresDatabase, install: installPrivateApplication,
    ...createInstalledNativeQueueFactories({ openWorkerDatabase: createPrivatePostgresDatabase }) });
}
