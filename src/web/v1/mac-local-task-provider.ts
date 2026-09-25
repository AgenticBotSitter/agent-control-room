import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import type { MacLocalDatabaseRolesV1 } from "./mac-local-database-roles";
import type { MacLocalWorkerReadinessV1 } from "./mac-local-worker-readiness";
import type { DatabaseClient } from "../../persistence/database";

export const MAC_LOCAL_TASK_PROVIDER_V1 = "control-room.mac-local-task-provider/v1" as const;
/** Product worker identities are harness names, not an upstream release. */
export const MAC_LOCAL_THREE_AGENT_KINDS_V1 = Object.freeze(["hermes", "claude-code", "codex"] as const);
type MacLocalWorkerKindV1 = typeof MAC_LOCAL_THREE_AGENT_KINDS_V1[number];

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type TaskApplication = Readonly<{
  operations: object;
  isReady(): boolean;
  close(): Promise<void>;
  queueDelivery?: unknown;
  queueRecovery?: unknown;
}>;

/** Owner-held executable configuration for the existing, already-composed task
 * lifecycle. It has no browser input and must not create an alternative
 * database, review path, or agent protocol. The existing release-owned queue
 * factory—not this provider—starts the one queue worker. */
export type MacLocalTaskProviderV1 = Readonly<{
  schema: typeof MAC_LOCAL_TASK_PROVIDER_V1;
  /** The task host is the three-agent product path, not a partial local
   * deployment. The fixed list is checked again against verified host state. */
  workerKinds: readonly MacLocalWorkerKindV1[];
  createTaskApplication(input: Readonly<{
    configuration: MacLocalProtectedConfigurationV1;
    database: OpenedDatabase;
    workerReadiness: MacLocalWorkerReadinessV1;
    databaseRoles: MacLocalDatabaseRolesV1;
  }>): Promise<TaskApplication> | TaskApplication;
}>;

type Runtime = Readonly<{
  lstat: typeof lstat;
  load(path: string): Promise<unknown>;
}>;
const production: Runtime = Object.freeze({ lstat, load: path => import(pathToFileURL(path).href) });

/** A real `import()` namespace carries exactly one own symbol, the standard
 * `Symbol.toStringTag` of "Module". Any other symbol is refused. */
function onlyModuleTag(value: object): boolean {
  const symbols = Object.getOwnPropertySymbols(value);
  return symbols.length === 0 || (symbols.length === 1 && symbols[0] === Symbol.toStringTag
    && Object.getPrototypeOf(value) === null && (value as Record<symbol, unknown>)[Symbol.toStringTag] === "Module");
}

function captureProvider(value: unknown): MacLocalTaskProviderV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || !onlyModuleTag(value)) throw new Error("mac_local_task_provider_invalid");
  const record = value as Record<string, unknown>, names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || !names.includes("schema") || !names.includes("workerKinds") || !names.includes("createTaskApplication")
    || record.schema !== MAC_LOCAL_TASK_PROVIDER_V1 || typeof record.createTaskApplication !== "function"
    || !sameThreeWorkerKinds(record.workerKinds)) throw new Error("mac_local_task_provider_invalid");
  return Object.freeze({ schema: MAC_LOCAL_TASK_PROVIDER_V1,
    workerKinds: MAC_LOCAL_THREE_AGENT_KINDS_V1,
    createTaskApplication: record.createTaskApplication as MacLocalTaskProviderV1["createTaskApplication"],
  });
}

function sameThreeWorkerKinds(value: unknown): value is readonly MacLocalWorkerKindV1[] {
  return Array.isArray(value) && value.length === MAC_LOCAL_THREE_AGENT_KINDS_V1.length
    && new Set(value).size === value.length
    && MAC_LOCAL_THREE_AGENT_KINDS_V1.every(kind => value.includes(kind));
}

/** A task host cannot silently become a one- or two-agent deployment. This
 * check uses host-generation executable verification only; a prior result is
 * not required to call an installed worker ready. */
export function requireMacLocalThreeAgentReadinessV1(provider: MacLocalTaskProviderV1,
  workerReadiness: Pick<MacLocalWorkerReadinessV1, "read">): void {
  if (!provider || !workerReadiness || typeof workerReadiness.read !== "function" || !sameThreeWorkerKinds(provider.workerKinds))
    throw new Error("mac_local_task_provider_invalid");
  const current = workerReadiness.read();
  if (!Array.isArray(current) || current.length !== MAC_LOCAL_THREE_AGENT_KINDS_V1.length
    || new Set(current.map(item => item.kind)).size !== current.length
    || current.some(item => item.state !== "ready")
    || !MAC_LOCAL_THREE_AGENT_KINDS_V1.every(kind => current.some(item => item.kind === kind)))
    throw new Error("mac_local_three_agent_readiness_required");
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
