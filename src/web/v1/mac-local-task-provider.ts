import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { NativeQueueWorkerStartupConfiguration } from "./native-queue-worker-startup";
import type { DatabaseClient } from "../../persistence/database";

export const MAC_LOCAL_TASK_PROVIDER_V1 = "control-room.mac-local-task-provider/v1" as const;

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type TaskApplication = Readonly<{
  operations: object;
  isReady(): boolean;
  close(): Promise<void>;
  queueDelivery?: unknown;
  queueRecovery?: unknown;
}>;
type QueueWorker = Readonly<{ close(): Promise<void>; status(): { accepting: boolean } }>;

/** Owner-held executable configuration for the existing, already-composed task
 * lifecycle. It has no browser input and must not create an alternative queue,
 * database, review path, or agent protocol. */
export type MacLocalTaskProviderV1 = Readonly<{
  schema: typeof MAC_LOCAL_TASK_PROVIDER_V1;
  createTaskApplication(input: Readonly<{
    configuration: MacLocalProtectedConfigurationV1;
    database: OpenedDatabase;
    workerReadiness: MacLocalWorkerReadinessV1;
    databaseRoles: MacLocalDatabaseRolesV1;
  }>): Promise<TaskApplication> | TaskApplication;
  startQueueWorker(configuration: NativeQueueWorkerStartupConfiguration): Promise<QueueWorker>;
}>;

type Runtime = Readonly<{
  lstat: typeof lstat;
  load(path: string): Promise<unknown>;
}>;
const production: Runtime = Object.freeze({ lstat, load: path => import(pathToFileURL(path).href) });

function captureProvider(value: unknown): MacLocalTaskProviderV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0) throw new Error("mac_local_task_provider_invalid");
  const record = value as Record<string, unknown>, names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || !names.includes("schema") || !names.includes("createTaskApplication") || !names.includes("startQueueWorker")
    || record.schema !== MAC_LOCAL_TASK_PROVIDER_V1 || typeof record.createTaskApplication !== "function"
    || typeof record.startQueueWorker !== "function") throw new Error("mac_local_task_provider_invalid");
  return Object.freeze({ schema: MAC_LOCAL_TASK_PROVIDER_V1,
    createTaskApplication: record.createTaskApplication as MacLocalTaskProviderV1["createTaskApplication"],
    startQueueWorker: record.startQueueWorker as MacLocalTaskProviderV1["startQueueWorker"],
  });
}

/** The task provider is always the one owner-held file below the protected
 * root. Callers cannot choose a filename, module URL, or environment variable. */
export async function loadMacLocalTaskProviderFromRootV1(protectedRoot: string,
  runtime: Runtime = production): Promise<MacLocalTaskProviderV1> {
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) throw new Error("mac_local_task_provider_root_invalid");
  const runtimeRoot = join(protectedRoot, "runtime"), path = join(runtimeRoot, "task-provider.mjs");
  if (resolve(path) !== path) throw new Error("mac_local_task_provider_root_invalid");
  try {
    for (const directory of [protectedRoot, runtimeRoot]) {
      const entry = await runtime.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error();
    }
    const entry = await runtime.lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 512 * 1024) throw new Error();
    return captureProvider(await runtime.load(path));
  } catch { throw new Error("mac_local_task_provider_invalid"); }
}
