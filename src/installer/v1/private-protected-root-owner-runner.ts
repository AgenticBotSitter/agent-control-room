import { dirname, isAbsolute, resolve } from "node:path";
import { sha256Digest } from "../../security/canonical-digest";
import { capturePrivateArtifactStorageConfigurationV1,
  type PrivateArtifactStorageConfigurationV1 } from "../../web/v1/private-artifact-storage";
import { protectedDataBindingDigestV1 } from "./protected-data-recovery-preparation";
import { PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1,
  type ProtectedDataRecoveryOwnerActionRequestV1 } from "./protected-data-recovery-owner-action";

/** Source-only owner runner: production filesystem and identity bindings remain injected. */
export const PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1 =
  "control-room.private-protected-root-owner-runner/v1" as const;
export const PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1 =
  "control-room.private-protected-root-owner-attached-terminal/v1" as const;
export const PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1 =
  "control-room.private-protected-root-storage-preflight/v1" as const;

type Operation = "owner_create_private_data_root" | "verify_owner_private_data_root"
  | "bind_verified_protected_storage";
type Identity = Readonly<{ device: number; inode: number }>;

export type PrivateProtectedRootFileStatV1 = Readonly<{
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
}>;

export type PrivateProtectedRootFilesystemV1 = Readonly<{
  lstat(path: string): Promise<PrivateProtectedRootFileStatV1>;
  realpath(path: string): Promise<string>;
  /** Reviewed binding: no-follow, non-recursive creation beneath this exact parent identity. */
  createExactPrivateDirectory(path: string, parent: Identity, mode: number): Promise<Identity>;
}>;

export type PrivateProtectedRootRunnerContextV1 = Readonly<{
  requestDigest: string;
  operation: Operation;
  signal: AbortSignal;
}>;

export type PrivateProtectedRootOwnerAttachedTerminalV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1;
  requestDigest: string;
  operation: "owner_create_private_data_root" | "verify_owner_private_data_root";
  ownerAttached: true;
  confirmed: true;
}>;

export type PrivateProtectedRootPreflightReceiptV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1;
  requestDigest: string;
  priorProtectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  rootIdentityDigest: string;
  outcome: "verified";
}>;

export type PrivateProtectedRootOwnerRuntimeV1 = Readonly<{
  /** Never returned, serialized, logged, or included in an error. */
  privateConfiguration: PrivateArtifactStorageConfigurationV1;
  selectedParentPath: string;
  selectedRootPath: string;
  /** Production binding derives this from the effective OS identity; callers do not provide a UID value. */
  effectiveOwnerUid(): Promise<number>;
  signal: AbortSignal;
  controlDeadlineMs: number;
  filesystem: PrivateProtectedRootFilesystemV1;
  confirmOwnerAttachedTerminal(context: PrivateProtectedRootRunnerContextV1): Promise<PrivateProtectedRootOwnerAttachedTerminalV1>;
  /** Calls the existing PersistentLocalArtifactStorageV1 preflight exactly once. */
  preflightExistingStorage(configuration: PrivateArtifactStorageConfigurationV1["local"],
    context: PrivateProtectedRootRunnerContextV1 & Readonly<{ rootIdentityDigest: string }>): Promise<PrivateProtectedRootPreflightReceiptV1>;
}>;

export type PrivateProtectedRootOwnerObservationV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1;
  requestDigest: string;
  operation: Operation;
  observedState: "verified";
  observationDigest: string;
  protectedDataBindingDigest: string;
  storageConfigurationDigest: string;
  storageNamespaceDigest: string;
  preflightReceiptDigest: string;
  createdDirectory: boolean;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const failureKinds = new WeakMap<object, "refused" | "uncertain">();
function sanitizedError(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_protected_root_owner_runner_${kind}`);
  error.stack = undefined; failureKinds.set(error, kind); return error;
}
function failureKind(value: unknown): "refused" | "uncertain" | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? failureKinds.get(value as object) : undefined;
}
function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) throw sanitizedError("refused");
  const result = value as Readonly<Record<string, unknown>>;
  if (Object.getOwnPropertyNames(result).some(name => {
    const descriptor = Object.getOwnPropertyDescriptor(result, name);
    return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
  })) throw sanitizedError("refused");
  return result;
}
function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  const result = plainRecord(value), keys = Object.keys(result);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !Object.prototype.hasOwnProperty.call(result, name))) throw sanitizedError("refused");
  return result;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw sanitizedError("refused");
  return value;
}
function operation(value: unknown): Operation {
  if (value === "owner_create_private_data_root" || value === "verify_owner_private_data_root"
    || value === "bind_verified_protected_storage") return value;
  throw sanitizedError("refused");
}
function uid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0x7fffffff) throw sanitizedError("refused");
  return value as number;
}
function identity(value: unknown): Identity {
  const item = exactRecord(value, ["device", "inode"]);
  if (!Number.isSafeInteger(item.device) || (item.device as number) < 0 || !Number.isSafeInteger(item.inode)
    || (item.inode as number) < 0) throw sanitizedError("refused");
  return Object.freeze({ device: item.device as number, inode: item.inode as number });
}
function sameIdentity(left: Identity, right: Identity): boolean { return left.device === right.device && left.inode === right.inode; }
function privateMode(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && (value & 0o777) === 0o700; }
function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || value.includes("\n")
    || value.includes("\r") || !isAbsolute(value) || resolve(value) !== value) throw sanitizedError("refused");
  return value;
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT"; }

function verifiedRequest(value: unknown): ProtectedDataRecoveryOwnerActionRequestV1 & Readonly<{ operation: Operation }> {
  const request = exactRecord(value, ["schema", "action", "stage", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "preparationDigest", "protectedDataBindingDigest", "storageConfigurationDigest",
    "storageNamespaceDigest", "operation", "precondition", "tool", "requiresOwnerPrivateConfiguration", "performsEffect",
    "opensStorage", "runsBackup", "runsRestore", "promotesRestore", "startsService", "grantsExecutionAuthority"]);
  const selected = operation(request.operation);
  const precondition = selected === "owner_create_private_data_root" ? "owner_attendance_and_unowned_target"
    : selected === "verify_owner_private_data_root" ? "existing_candidate_and_owner_attendance" : "verified_private_root_only";
  if (request.schema !== PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1 || request.action !== "protected_data" || request.stage !== "protected_data"
    || !Number.isSafeInteger(request.installationPlanRevision) || (request.installationPlanRevision as number) < 0
    || request.precondition !== precondition || request.requiresOwnerPrivateConfiguration !== true || request.performsEffect !== false
    || request.opensStorage !== false || request.runsBackup !== false || request.runsRestore !== false || request.promotesRestore !== false
    || request.startsService !== false || request.grantsExecutionAuthority !== false) throw sanitizedError("refused");
  for (const name of ["installationPlanDigest", "topologyPlanDigest", "releaseDigest", "preparationDigest",
    "protectedDataBindingDigest", "storageConfigurationDigest", "storageNamespaceDigest"] as const) digest(request[name]);
  const tool = exactRecord(request.tool, ["kind", "entrypoints"]);
  if (tool.kind !== "existing_private_storage_and_recovery_tools" || !Array.isArray(tool.entrypoints) || tool.entrypoints.length !== 2
    || tool.entrypoints[0] !== "src/web/v1/private-artifact-storage.ts" || tool.entrypoints[1] !== "src/artifacts/v1/persistent-local-storage.ts") {
    throw sanitizedError("refused");
  }
  return request as ProtectedDataRecoveryOwnerActionRequestV1 & Readonly<{ operation: Operation }>;
}

function verifiedRuntime(value: unknown): PrivateProtectedRootOwnerRuntimeV1 {
  const runtime = exactRecord(value, ["privateConfiguration", "selectedParentPath", "selectedRootPath", "effectiveOwnerUid", "signal",
    "controlDeadlineMs", "filesystem", "confirmOwnerAttachedTerminal", "preflightExistingStorage"]);
  if (typeof runtime.effectiveOwnerUid !== "function" || !runtime.signal || typeof runtime.signal !== "object"
    || typeof (runtime.signal as AbortSignal).aborted !== "boolean" || typeof (runtime.signal as AbortSignal).addEventListener !== "function"
    || !Number.isSafeInteger(runtime.controlDeadlineMs) || (runtime.controlDeadlineMs as number) < 1
    || (runtime.controlDeadlineMs as number) > 30_000 || typeof runtime.confirmOwnerAttachedTerminal !== "function"
    || typeof runtime.preflightExistingStorage !== "function") throw sanitizedError("refused");
  const filesystem = exactRecord(runtime.filesystem, ["lstat", "realpath", "createExactPrivateDirectory"]);
  if (typeof filesystem.lstat !== "function" || typeof filesystem.realpath !== "function"
    || typeof filesystem.createExactPrivateDirectory !== "function") throw sanitizedError("refused");
  try {
    const configuration = capturePrivateArtifactStorageConfigurationV1(runtime.privateConfiguration as PrivateArtifactStorageConfigurationV1);
    const root = canonicalPath(runtime.selectedRootPath), parent = canonicalPath(runtime.selectedParentPath);
    if (root !== configuration.local.rootPath || parent !== dirname(root) || parent === root) throw sanitizedError("refused");
  } catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
  return runtime as unknown as PrivateProtectedRootOwnerRuntimeV1;
}
function storageConfigurationDigest(configuration: PrivateArtifactStorageConfigurationV1): string {
  return sha256Digest({ purpose: "protected-artifact-storage-configuration/v1", local: configuration.local, inventory: configuration.inventory });
}
function rootIdentityDigest(item: Identity): string { return sha256Digest({ purpose: "private-protected-root-identity/v1", item }); }
function requestDigest(request: ProtectedDataRecoveryOwnerActionRequestV1): string {
  return sha256Digest({ purpose: "protected-data-recovery-owner-action-request/v1", request });
}

async function invoke<T>(call: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted || Date.now() >= deadline) throw sanitizedError("uncertain");
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer); signal.removeEventListener("abort", cancel);
    };
    const cancel = () => { done(); reject(sanitizedError("uncertain")); };
    timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(call).then(value => { done(); resolve(value); }, error => { done(); reject(error); });
  });
}

async function inspectExactDirectory(runtime: PrivateProtectedRootOwnerRuntimeV1, path: string, expectedUid: number,
  deadline: number, signal: AbortSignal, expected?: Identity): Promise<Identity> {
  let stats: PrivateProtectedRootFileStatV1; let canonical: string;
  try { [stats, canonical] = await invoke(() => Promise.all([runtime.filesystem.lstat(path), runtime.filesystem.realpath(path)]), signal, deadline); }
  catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
  try {
    if (!stats || typeof stats.isDirectory !== "function" || typeof stats.isSymbolicLink !== "function" || stats.isDirectory() !== true
      || stats.isSymbolicLink() !== false || canonical !== path || stats.uid !== expectedUid || !privateMode(stats.mode)) throw sanitizedError("refused");
    const found = identity({ device: stats.dev, inode: stats.ino });
    if (expected && !sameIdentity(found, expected)) throw sanitizedError("uncertain");
    return found;
  } catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
}
async function rootIsMissing(runtime: PrivateProtectedRootOwnerRuntimeV1, root: string, signal: AbortSignal, deadline: number): Promise<boolean> {
  try { await invoke(() => runtime.filesystem.lstat(root), signal, deadline); return false; }
  catch (error) { if (missing(error)) return true; throw sanitizedError(failureKind(error) ?? "refused"); }
}
function attached(value: unknown, requestDigestValue: string, selected: Operation): void {
  const confirmation = exactRecord(value, ["schema", "requestDigest", "operation", "ownerAttached", "confirmed"]);
  if (confirmation.schema !== PRIVATE_PROTECTED_ROOT_OWNER_ATTACHED_TERMINAL_V1 || confirmation.requestDigest !== requestDigestValue
    || confirmation.operation !== selected || confirmation.ownerAttached !== true || confirmation.confirmed !== true) throw sanitizedError("refused");
}
function verifiedReceipt(value: unknown, requestDigestValue: string, request: ProtectedDataRecoveryOwnerActionRequestV1,
  configurationDigest: string, namespaceDigest: string, identityDigest: string): PrivateProtectedRootPreflightReceiptV1 {
  const receipt = exactRecord(value, ["schema", "requestDigest", "priorProtectedDataBindingDigest", "storageConfigurationDigest",
    "storageNamespaceDigest", "rootIdentityDigest", "outcome"]);
  if (receipt.schema !== PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1 || receipt.requestDigest !== requestDigestValue
    || receipt.priorProtectedDataBindingDigest !== request.protectedDataBindingDigest || receipt.storageConfigurationDigest !== configurationDigest
    || receipt.storageNamespaceDigest !== namespaceDigest || receipt.rootIdentityDigest !== identityDigest || receipt.outcome !== "verified") {
    throw sanitizedError("refused");
  }
  return receipt as PrivateProtectedRootPreflightReceiptV1;
}

async function runInternal(requestInput: unknown, runtimeInput: unknown): Promise<PrivateProtectedRootOwnerObservationV1> {
  const request = verifiedRequest(requestInput), runtime = verifiedRuntime(runtimeInput), preparedRequestDigest = requestDigest(request);
  if (runtime.signal.aborted) throw sanitizedError("refused");
  const deadline = Date.now() + runtime.controlDeadlineMs;
  let creationAttempted = false;
  try {
    const configuration = capturePrivateArtifactStorageConfigurationV1(runtime.privateConfiguration);
    const configDigest = storageConfigurationDigest(configuration);
    if (configuration.inventory.releaseDigest !== request.releaseDigest || configDigest !== request.storageConfigurationDigest
      || configuration.inventory.storageNamespaceDigest !== request.storageNamespaceDigest) throw sanitizedError("refused");
    const expectedUid = uid(await invoke(() => runtime.effectiveOwnerUid(), runtime.signal, deadline));
    const context = Object.freeze({ requestDigest: preparedRequestDigest, operation: request.operation, signal: runtime.signal });
    if (request.operation !== "bind_verified_protected_storage") {
      attached(await invoke(() => runtime.confirmOwnerAttachedTerminal(context), runtime.signal, deadline), preparedRequestDigest, request.operation);
    }
    const root = runtime.selectedRootPath, parent = runtime.selectedParentPath;
    const parentIdentity = await inspectExactDirectory(runtime, parent, expectedUid, deadline, runtime.signal);
    const absent = await rootIsMissing(runtime, root, runtime.signal, deadline);
    let createdDirectory = false;
    let rootIdentity: Identity;
    if (request.operation === "owner_create_private_data_root") {
      if (!absent) throw sanitizedError("refused");
      creationAttempted = true;
      rootIdentity = identity(await invoke(() => runtime.filesystem.createExactPrivateDirectory(root, parentIdentity, 0o700), runtime.signal, deadline));
      createdDirectory = true;
    } else {
      if (absent) throw sanitizedError("refused");
      rootIdentity = await inspectExactDirectory(runtime, root, expectedUid, deadline, runtime.signal);
    }
    await inspectExactDirectory(runtime, parent, expectedUid, deadline, runtime.signal, parentIdentity);
    rootIdentity = await inspectExactDirectory(runtime, root, expectedUid, deadline, runtime.signal, rootIdentity);
    const identityDigest = rootIdentityDigest(rootIdentity);
    const receipt = verifiedReceipt(await invoke(() => runtime.preflightExistingStorage(configuration.local,
      Object.freeze({ ...context, rootIdentityDigest: identityDigest })), runtime.signal, deadline), preparedRequestDigest, request,
    configDigest, configuration.inventory.storageNamespaceDigest, identityDigest);
    await inspectExactDirectory(runtime, parent, expectedUid, deadline, runtime.signal, parentIdentity);
    await inspectExactDirectory(runtime, root, expectedUid, deadline, runtime.signal, rootIdentity);
    const preflightReceiptDigest = sha256Digest({ purpose: "private-protected-root-preflight-receipt/v1", receipt });
    const observationDigest = sha256Digest({ purpose: "private-protected-root-observation/v1", requestDigest: preparedRequestDigest,
      priorProtectedDataBindingDigest: request.protectedDataBindingDigest, storageConfigurationDigest: configDigest,
      storageNamespaceDigest: configuration.inventory.storageNamespaceDigest, rootIdentityDigest: identityDigest,
      preflightReceiptDigest, createdDirectory });
    return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1, requestDigest: preparedRequestDigest, operation: request.operation,
      observedState: "verified" as const, observationDigest, protectedDataBindingDigest: protectedDataBindingDigestV1({ storageConfiguration: configuration,
        observedState: "verified", observationDigest }), storageConfigurationDigest: configDigest,
      storageNamespaceDigest: configuration.inventory.storageNamespaceDigest, preflightReceiptDigest, createdDirectory });
  } catch (error) {
    const uncertain = creationAttempted || runtime.signal.aborted || failureKind(error) === "uncertain" || Date.now() >= deadline;
    throw sanitizedError(uncertain ? "uncertain" : "refused");
  }
}

export async function runPrivateProtectedRootOwnerActionV1(requestInput: unknown,
  runtimeInput: unknown): Promise<PrivateProtectedRootOwnerObservationV1> {
  try { return await runInternal(requestInput, runtimeInput); }
  catch (error) { throw sanitizedError(failureKind(error) ?? "refused"); }
}
