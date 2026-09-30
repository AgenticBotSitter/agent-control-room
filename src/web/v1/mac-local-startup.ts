import type { DatabaseClient } from "../../persistence/database";
import { verifyOwnerTrustedLocalEnablementV1 } from "../../harness/v1/owner-trusted-local-enablements";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalWorkerReadinessV1, type MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type LocalService = Readonly<{ start(): Promise<void>; close(): Promise<void> }>;
type ServiceInput = Readonly<{ configuration: MacLocalProtectedConfigurationV1; database: OpenedDatabase;
  workerReadiness?: MacLocalWorkerReadinessV1; databaseRoles?: MacLocalDatabaseRolesV1 }>;
type StartupCommon = Readonly<{
  openDatabase(configuration: MacLocalProtectedConfigurationV1["database"]): OpenedDatabase;
  verifyModelPolicy?: Parameters<typeof verifyOwnerTrustedLocalEnablementV1>[2];
  createService(input: ServiceInput): LocalService | Promise<LocalService>;
}>;
type DirectStartupInput = StartupCommon & Readonly<{ connectorOnly?: false;
  readVersion(executablePath: string): Promise<string> }>;
type ConnectorStartupInput = StartupCommon & Readonly<{ connectorOnly: true;
  readVersion?: (executablePath: string) => Promise<string> }>;
type Started = Readonly<{ close(): Promise<void> }>;

export function createMacLocalStartupV1(input: DirectStartupInput): Readonly<{
  start(configuration: MacLocalProtectedConfigurationV1, databaseRoles?: MacLocalDatabaseRolesV1):
    Promise<Started & Readonly<{ workerReadiness: MacLocalWorkerReadinessV1 }>>;
}>;
export function createMacLocalStartupV1(input: ConnectorStartupInput): Readonly<{
  start(configuration: MacLocalProtectedConfigurationV1, databaseRoles?: MacLocalDatabaseRolesV1): Promise<Started>;
}>;

/** Explicit Mac-local startup bridge. Legacy direct mode verifies owner-pinned
 * executables; connector-only service mode performs no bot process access.
 * Both transfer cleanup only after service construction succeeds. */
export function createMacLocalStartupV1(input: DirectStartupInput | ConnectorStartupInput) {
  if (!input || typeof input.openDatabase !== "function" || typeof input.createService !== "function"
    || (input.connectorOnly !== true && typeof input.readVersion !== "function"))
    throw new Error("mac_local_startup_invalid");
  let attempted = false;
  return Object.freeze({ async start(configuration: MacLocalProtectedConfigurationV1, databaseRoles?: MacLocalDatabaseRolesV1) {
    if (attempted) throw new Error("mac_local_startup_already_attempted");
    attempted = true;
    const workerReadiness = input.connectorOnly === true ? undefined : createMacLocalWorkerReadinessV1(configuration.enablement,
      await verifyOwnerTrustedLocalEnablementV1(configuration.enablement, input.readVersion!, input.verifyModelPolicy));
    let database: OpenedDatabase | undefined, service: LocalService | undefined;
    try {
      database = input.openDatabase(configuration.database);
      if (!database || !database.client || typeof database.close !== "function") throw new Error();
      service = await input.createService({ configuration, database, ...(workerReadiness ? { workerReadiness } : {}),
        ...(databaseRoles ? { databaseRoles } : {}) });
      if (!service || typeof service.start !== "function" || typeof service.close !== "function") throw new Error();
      await service.start();
      return Object.freeze({ close: service.close.bind(service), ...(workerReadiness ? { workerReadiness } : {}) });
    } catch (error) {
      // Keep a bounded, non-secret diagnostic when the composed host refuses
      // startup. Raw driver messages can contain connection details.
      const code = error instanceof Error && /^[a-z][a-z0-9_]{2,80}$/u.test(error.message)
        ? error.message : "unclassified_failure";
      console.error(`mac-local-startup: ${code}`);
      try { await (service?.close() ?? database?.close()); } catch { throw new Error("mac_local_startup_cleanup_uncertain"); }
      throw new Error("mac_local_startup_failed");
    }
  } });
}
