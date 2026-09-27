import type { Server, ServerOptions } from "node:http";
import type { DatabaseClient } from "../../persistence/database";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import { createWorkIntakeLoopbackService } from "../../web/v1/private-serving";
import { createFixedWorkIntakeCredentialVerifierV1 } from "./machine-auth";
import { createWorkIntakeNodeBridgeV1 } from "./node-handler";
import { WorkBatchServiceV1 } from "./service";
import { WorkBatchStoreV1 } from "./store";
import type { AuthenticatedPrincipal } from "../../security";

export const WORK_INTAKE_DATABASE_ROLE_V1 = "control_room_work_intake_agent";
type OwnedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void>; isAvailable(): boolean }>;
export type WorkIntakePrivateServiceConfigurationV1 = Readonly<{ port: number; database: PrivatePostgresConfiguration;
  bearerSecret: string; principal: AuthenticatedPrincipal; integrityKey: Uint8Array; queueDepthLimit?: number }>;

export async function prepareWorkIntakePrivateServiceV1(input: WorkIntakePrivateServiceConfigurationV1,
  dependencies: Readonly<{ openDatabase(config: PrivatePostgresConfiguration): OwnedDatabase;
    createServer?: (options: Readonly<ServerOptions>) => Server; now?: () => string }>
  = { openDatabase: createPrivatePostgresDatabase }) {
  let database: OwnedDatabase | undefined;
  try {
    const config = validatePrivatePostgresConfiguration(input.database);
    if (config.username !== WORK_INTAKE_DATABASE_ROLE_V1 || !Number.isSafeInteger(input.port)
      || input.port < 1 || input.port > 65535 || !(input.integrityKey instanceof Uint8Array)
      || input.integrityKey.length !== 32) throw new Error();
    const verifier = createFixedWorkIntakeCredentialVerifierV1(input.bearerSecret, input.principal);
    database = dependencies.openDatabase(config);
    const service = new WorkBatchServiceV1(new WorkBatchStoreV1(database.client, input.integrityKey),
      input.queueDepthLimit ?? 10);
    const bridge = createWorkIntakeNodeBridgeV1({ verifier, service,
      now: dependencies.now ?? (() => new Date().toISOString()), close: () => database!.close(),
      isReady: () => database!.isAvailable() });
    return createWorkIntakeLoopbackService(bridge, { port: input.port,
      ...(dependencies.createServer ? { createServer: dependencies.createServer } : {}) });
  } catch {
    if (database) try { await database.close(); } catch { throw new Error("work_intake_private_service_cleanup_uncertain"); }
    throw new Error("work_intake_private_service_prepare_failed");
  }
}
