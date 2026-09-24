import type { DatabaseClient } from "../../persistence/database";
import { verifyOwnerTrustedLocalEnablementV1 } from "../../harness/v1/owner-trusted-local-enablements";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { createMacLocalWorkerReadinessV1, type MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type LocalService = Readonly<{ start(): Promise<void>; close(): Promise<void> }>;

/** Explicit Mac-local startup bridge. It verifies the owner-pinned executables
 * before opening its supplied database and transfers cleanup to the service
 * only after construction succeeds. It has no file or environment access. */
export function createMacLocalStartupV1(input: Readonly<{
  openDatabase(configuration: MacLocalProtectedConfigurationV1["database"]): OpenedDatabase;
  readVersion(executablePath: string): Promise<string>;
  createService(input: Readonly<{ configuration: MacLocalProtectedConfigurationV1; database: OpenedDatabase;
    workerReadiness: MacLocalWorkerReadinessV1; databaseRoles?: MacLocalDatabaseRolesV1 }>): LocalService | Promise<LocalService>;
}>) {
  if (!input || typeof input.openDatabase !== "function" || typeof input.readVersion !== "function" || typeof input.createService !== "function")
    throw new Error("mac_local_startup_invalid");
  let attempted = false;
  return Object.freeze({ async start(configuration: MacLocalProtectedConfigurationV1, databaseRoles?: MacLocalDatabaseRolesV1) {
    if (attempted) throw new Error("mac_local_startup_already_attempted");
    attempted = true;
    const verified = await verifyOwnerTrustedLocalEnablementV1(configuration.enablement, input.readVersion);
    const workerReadiness = createMacLocalWorkerReadinessV1(configuration.enablement, verified);
    let database: OpenedDatabase | undefined, service: LocalService | undefined;
    try {
      database = input.openDatabase(configuration.database);
      if (!database || !database.client || typeof database.close !== "function") throw new Error();
      service = await input.createService({ configuration, database, workerReadiness, ...(databaseRoles ? { databaseRoles } : {}) });
      if (!service || typeof service.start !== "function" || typeof service.close !== "function") throw new Error();
      await service.start();
      return Object.freeze({ close: service.close.bind(service), workerReadiness });
    } catch {
      try { await (service?.close() ?? database?.close()); } catch { throw new Error("mac_local_startup_cleanup_uncertain"); }
      throw new Error("mac_local_startup_failed");
    }
  } });
}
