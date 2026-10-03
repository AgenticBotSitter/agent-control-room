import type { Server, ServerOptions } from "node:http";
import type { DatabaseClient } from "../../persistence/database";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import { createWorkIntakeLoopbackService } from "../../web/v1/private-serving";
import { createMappedWorkIntakeCredentialVerifierV1 } from "./machine-auth";
import { createWorkIntakeNodeBridgeV1 } from "./node-handler";
import { WorkBatchServiceV1 } from "./service";
import { WorkBatchStoreV1 } from "./store";
import { RecurringRuleSchedulerV1, recurringWorkBatchProposalPortV1 } from "../../recurring/v1/scheduler";
import { startSupervisorLoopV1, type SupervisorLoopHandleV1 } from "../../supervisor/v1/loop";
import { readInstallationOperationsModeV1 } from "../../web/v1/operations-mode-service";
import type { WorkIntakeCredentialMappingV1 } from "./installed-configuration";

export const WORK_INTAKE_DATABASE_ROLE_V1 = "control_room_work_intake_agent";
type OwnedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void>; isAvailable(): boolean }>;
export type WorkIntakePrivateServiceConfigurationV1 = Readonly<{ port: number; database: PrivatePostgresConfiguration;
  credentials: readonly WorkIntakeCredentialMappingV1[]; integrityKey: Uint8Array; queueDepthLimit?: number;
  /** The installed coordinator login owns recurring bookkeeping; proposal writes
   * remain on the intake login and retain their ordinary owner-approval gate. */
  recurring?: Readonly<{ tenantId: string; database: PrivatePostgresConfiguration }> }>;

export async function prepareWorkIntakePrivateServiceV1(input: WorkIntakePrivateServiceConfigurationV1,
  dependencies: Readonly<{ openDatabase(config: PrivatePostgresConfiguration): OwnedDatabase;
    createServer?: (options: Readonly<ServerOptions>) => Server; now?: () => string;
    loopRuntime?: Parameters<typeof startSupervisorLoopV1>[0]["runtime"] }>
  = { openDatabase: createPrivatePostgresDatabase }) {
  let database: OwnedDatabase | undefined, coordinator: OwnedDatabase | undefined;
  try {
    const config = validatePrivatePostgresConfiguration(input.database);
    if (config.username !== WORK_INTAKE_DATABASE_ROLE_V1 || !Number.isSafeInteger(input.port)
      || input.port < 1 || input.port > 65535 || !(input.integrityKey instanceof Uint8Array)
      || input.integrityKey.length !== 32) throw new Error();
    const verifier = createMappedWorkIntakeCredentialVerifierV1(input.credentials);
    database = dependencies.openDatabase(config);
    const service = new WorkBatchServiceV1(new WorkBatchStoreV1(database.client, input.integrityKey),
      input.queueDepthLimit ?? 10);
    const bridge = createWorkIntakeNodeBridgeV1({ verifier, service,
      now: dependencies.now ?? (() => new Date().toISOString()), close: () => database!.close(),
      isReady: () => database!.isAvailable() });
    const listener = createWorkIntakeLoopbackService(bridge, { port: input.port,
      ...(dependencies.createServer ? { createServer: dependencies.createServer } : {}) });
    if (!input.recurring) return listener;
    const recurring = input.recurring, coordinatorConfig = validatePrivatePostgresConfiguration(recurring.database);
    if (coordinatorConfig.username !== "control_room_coordinator"
      || coordinatorConfig.host !== config.host || coordinatorConfig.port !== config.port
      || coordinatorConfig.database !== config.database
      || JSON.stringify(coordinatorConfig.privateEndpoint) !== JSON.stringify(config.privateEndpoint)
      || input.credentials.some(mapping => mapping.principal.tenantId !== recurring.tenantId)) throw new Error();
    coordinator = dependencies.openDatabase(coordinatorConfig);
    const ownedCoordinator = coordinator, clock = () => Date.parse(dependencies.now?.() ?? new Date().toISOString());
    const key = Uint8Array.from(input.integrityKey);
    const scheduler = new RecurringRuleSchedulerV1(ownedCoordinator.client, recurring.tenantId,
      { read: async () => (await readInstallationOperationsModeV1(ownedCoordinator.client, recurring.tenantId, key)).mode },
      { async propose(request) {
        // Use an existing, owner-registered proposer that is authorized for this
        // project. No synthetic identity or new execution authority is created.
        for (const mapping of input.credentials) {
          const allowed = await service.authorizeBeforeBody(mapping.principal, request.projectId, new Date(clock()).toISOString());
          if (allowed.allowed) return recurringWorkBatchProposalPortV1(service, mapping.principal, clock).propose(request);
        }
        throw new Error("recurring_proposer_unavailable");
      } }, clock);
    let loop: SupervisorLoopHandleV1 | undefined, starting: Promise<void> | undefined, closing: Promise<void> | undefined;
    return Object.freeze({
      isReady: () => !closing && listener.isReady() && ownedCoordinator.isAvailable(),
      start() {
        if (closing) return Promise.reject(new Error("work_intake_private_service_closed"));
        return starting ??= (async () => {
          await listener.start();
          loop = await startSupervisorLoopV1({ toleratesFirstCycleFailure: true,
            service: { cycle: async () => {
              const outcome = await scheduler.tick();
              if (outcome.failed.length) throw new Error("recurring_cycle_failed");
            } },
            runtime: { setInterval: dependencies.loopRuntime?.setInterval ?? ((run, ms) => setInterval(run, ms)),
              clearInterval: dependencies.loopRuntime?.clearInterval ?? (timer => clearInterval(timer)),
              report: () => {
                const safe = new Error("recurring_cycle_unavailable");
                if (dependencies.loopRuntime) dependencies.loopRuntime.report(safe);
                else process.stderr.write(`${safe.message}\n`);
              } } });
        })();
      },
      close() {
        return closing ??= (async () => {
          await starting?.catch(() => {});
          // A selected tick may still be writing. Drain it before either of the
          // restricted pools beneath it closes, including on a failed startup.
          const drained = await Promise.allSettled([loop?.close()]);
          const results = await Promise.allSettled([listener.close(), ownedCoordinator.close()]);
          if ([...drained, ...results].some(result => result.status === "rejected"))
            throw new Error("work_intake_private_service_cleanup_uncertain");
        })();
      },
    });
  } catch {
    const cleanup = await Promise.allSettled([database?.close(), coordinator?.close()]);
    if (cleanup.some(result => result.status === "rejected")) throw new Error("work_intake_private_service_cleanup_uncertain");
    throw new Error("work_intake_private_service_prepare_failed");
  }
}
