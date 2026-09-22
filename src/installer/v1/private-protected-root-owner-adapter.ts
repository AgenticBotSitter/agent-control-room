import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { PersistentLocalArtifactStorageV1 } from "../../artifacts/v1/persistent-local-storage";
import { sha256Digest } from "../../security/canonical-digest";
import { capturePrivateArtifactStorageConfigurationV1,
  type PrivateArtifactStorageConfigurationV1 } from "../../web/v1/private-artifact-storage";
import { PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1,
  type ProtectedDataRecoveryOwnerActionRequestV1 } from "./protected-data-recovery-owner-action";
import { PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1,
  runPrivateProtectedRootOwnerActionV1,
  type PrivateProtectedRootOwnerAttachedTerminalV1,
  type PrivateProtectedRootOwnerObservationV1,
  type PrivateProtectedRootOwnerRuntimeV1,
  type PrivateProtectedRootRunnerContextV1 } from "./private-protected-root-owner-runner";

/**
 * POSIX production composition for the accepted protected-root runner.
 *
 * Node does not expose mkdirat(2)/fstatat(2), so this module deliberately has
 * no path-based creation fallback. A separately reviewed native binding must
 * implement the exact descriptor-relative port below. Until one is supplied,
 * real protected-root creation is unavailable rather than race-prone.
 */
export const PRIVATE_PROTECTED_ROOT_OWNER_ADAPTER_V1 =
  "control-room.private-protected-root-owner-adapter/v1" as const;
export const PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1 =
  "control-room.private-protected-root-native-directory/v1" as const;
export const PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1 =
  "control-room.private-protected-root-native-receipt/v1" as const;

type Identity = Readonly<{ device: number; inode: number }>;
type ProtectedOperation = "owner_create_private_data_root" | "verify_owner_private_data_root"
  | "bind_verified_protected_storage";

export type PrivateProtectedRootNativeCreateRequestV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1;
  operation: "create_one_private_child";
  /** Private input to the native boundary. It must never be returned or logged. */
  parentPath: string;
  /** Exactly one basename: no slash, dot segment, NUL or line ending. */
  childName: string;
  expectedParentIdentity: Identity;
  expectedOwnerUid: number;
  mode: 0o700;
  deadlineUnixMs: number;
  signal: AbortSignal;
}>;

export type PrivateProtectedRootNativeReceiptV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1;
  operation: "mkdirat_then_fstatat";
  parentIdentity: Identity;
  rootIdentity: Identity;
  ownerUid: number;
  mode: 0o700;
  created: true;
  directory: true;
  symbolicLink: false;
  parentOpenedNoFollow: true;
  childInspectedNoFollow: true;
}>;

export type PrivateProtectedRootNativeDirectoryV1 = Readonly<{
  schema: typeof PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1;
  /**
   * Required native semantics, as one indivisible port operation:
   * 1. open the exact canonical parent directory without following a symlink;
   * 2. fstat that descriptor and match owner, mode and expected identity;
   * 3. mkdirat that descriptor for exactly childName with mode 0700 and no recursion;
   * 4. fstatat(AT_SYMLINK_NOFOLLOW) the child through the same descriptor;
   * 5. return only identities and security facts, never a path.
   *
   * EEXIST, any identity change, abort/deadline after entry, or an incomplete
   * receipt is uncertainty. This port has no remove, repair or retry method.
   */
  createOnePrivateChild(request: PrivateProtectedRootNativeCreateRequestV1):
    Promise<PrivateProtectedRootNativeReceiptV1>;
}>;

export type PrivateProtectedRootAttachedTerminalV1 = Readonly<{
  confirmOwnerAttachedTerminal(context: PrivateProtectedRootRunnerContextV1):
    Promise<PrivateProtectedRootOwnerAttachedTerminalV1>;
}>;

type AdapterInput = Readonly<{
  privateConfiguration: PrivateArtifactStorageConfigurationV1;
  selectedParentPath: string;
  selectedRootPath: string;
  signal: AbortSignal;
  controlDeadlineMs: number;
  nativeDirectory: PrivateProtectedRootNativeDirectoryV1;
  terminal: PrivateProtectedRootAttachedTerminalV1;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const refused = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };
function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_protected_root_owner_adapter_${kind}`);
  error.stack = undefined;
  return error;
}

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(name => !names.includes(name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function identity(value: unknown): Identity {
  const item = exactRecord(value, ["device", "inode"]);
  if (!Number.isSafeInteger(item.device) || (item.device as number) < 0
    || !Number.isSafeInteger(item.inode) || (item.inode as number) < 0) return refused();
  return Object.freeze({ device: item.device as number, inode: item.inode as number });
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function canonicalPath(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\0")
    || value.includes("\n") || value.includes("\r") || !isAbsolute(value) || resolve(value) !== value) return refused();
  return value;
}

function requestBinding(value: unknown): Readonly<{
  request: ProtectedDataRecoveryOwnerActionRequestV1;
  requestDigest: string;
  operation: ProtectedOperation;
}> {
  const request = exactRecord(value, ["schema", "action", "stage", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "preparationDigest", "protectedDataBindingDigest", "storageConfigurationDigest",
    "storageNamespaceDigest", "operation", "precondition", "tool", "requiresOwnerPrivateConfiguration", "performsEffect",
    "opensStorage", "runsBackup", "runsRestore", "promotesRestore", "startsService", "grantsExecutionAuthority"]);
  if (request.schema !== PROTECTED_DATA_RECOVERY_OWNER_ACTION_V1 || request.action !== "protected_data"
    || request.stage !== "protected_data" || (request.operation !== "owner_create_private_data_root"
      && request.operation !== "verify_owner_private_data_root" && request.operation !== "bind_verified_protected_storage")) return refused();
  digest(request.protectedDataBindingDigest);
  try {
    return Object.freeze({ request: request as ProtectedDataRecoveryOwnerActionRequestV1,
      requestDigest: sha256Digest({ purpose: "protected-data-recovery-owner-action-request/v1", request }),
      operation: request.operation });
  } catch { return refused(); }
}

function captureInput(value: unknown): AdapterInput {
  const input = exactRecord(value, ["privateConfiguration", "selectedParentPath", "selectedRootPath", "signal",
    "controlDeadlineMs", "nativeDirectory", "terminal"]);
  const parent = canonicalPath(input.selectedParentPath), root = canonicalPath(input.selectedRootPath);
  if (dirname(root) !== parent || basename(root) === "." || basename(root) === ".." || parent === root) return refused();
  if (!input.signal || typeof input.signal !== "object" || typeof (input.signal as AbortSignal).aborted !== "boolean"
    || typeof (input.signal as AbortSignal).addEventListener !== "function"
    || !Number.isSafeInteger(input.controlDeadlineMs) || (input.controlDeadlineMs as number) < 1
    || (input.controlDeadlineMs as number) > 30_000) return refused();
  const native = exactRecord(input.nativeDirectory, ["schema", "createOnePrivateChild"]);
  const terminal = exactRecord(input.terminal, ["confirmOwnerAttachedTerminal"]);
  if (native.schema !== PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1 || typeof native.createOnePrivateChild !== "function"
    || typeof terminal.confirmOwnerAttachedTerminal !== "function") return refused();
  const createOnePrivateChild = (native.createOnePrivateChild as PrivateProtectedRootNativeDirectoryV1["createOnePrivateChild"])
    .bind(input.nativeDirectory);
  const confirmOwnerAttachedTerminal = (terminal.confirmOwnerAttachedTerminal as
    PrivateProtectedRootAttachedTerminalV1["confirmOwnerAttachedTerminal"]).bind(input.terminal);
  let configuration: PrivateArtifactStorageConfigurationV1;
  try { configuration = capturePrivateArtifactStorageConfigurationV1(input.privateConfiguration as PrivateArtifactStorageConfigurationV1); }
  catch { return refused(); }
  if (configuration.local.rootPath !== root || process.platform === "win32" || typeof process.geteuid !== "function") return refused();
  return Object.freeze({ privateConfiguration: configuration, selectedParentPath: parent, selectedRootPath: root,
    signal: input.signal as AbortSignal, controlDeadlineMs: input.controlDeadlineMs as number,
    nativeDirectory: Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, createOnePrivateChild }),
    terminal: Object.freeze({ confirmOwnerAttachedTerminal }) });
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") return refused();
  const value = process.geteuid();
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) return refused();
  return value;
}

function nativeReceipt(value: unknown, expectedParent: Identity, expectedUid: number): Identity {
  const receipt = exactRecord(value, ["schema", "operation", "parentIdentity", "rootIdentity", "ownerUid", "mode", "created",
    "directory", "symbolicLink", "parentOpenedNoFollow", "childInspectedNoFollow"]);
  const parentIdentity = identity(receipt.parentIdentity), rootIdentity = identity(receipt.rootIdentity);
  if (receipt.schema !== PRIVATE_PROTECTED_ROOT_NATIVE_RECEIPT_V1 || receipt.operation !== "mkdirat_then_fstatat"
    || !sameIdentity(parentIdentity, expectedParent) || receipt.ownerUid !== expectedUid || receipt.mode !== 0o700
    || receipt.created !== true || receipt.directory !== true || receipt.symbolicLink !== false
    || receipt.parentOpenedNoFollow !== true || receipt.childInspectedNoFollow !== true) return uncertain();
  return rootIdentity;
}

/**
 * Builds only the runtime required by the accepted owner runner. It performs no
 * I/O until the runner invokes it, and it exposes no path in a receipt.
 */
export function createPrivateProtectedRootOwnerAdapterV1(requestInput: unknown,
  input: unknown): PrivateProtectedRootOwnerRuntimeV1 {
  const binding = requestBinding(requestInput), captured = captureInput(input);
  const expectedUid = effectiveUid();
  const deadlineUnixMs = Date.now() + captured.controlDeadlineMs;
  let creationEntered = false, preflightEntered = false;
  return Object.freeze({
    privateConfiguration: captured.privateConfiguration,
    selectedParentPath: captured.selectedParentPath,
    selectedRootPath: captured.selectedRootPath,
    signal: captured.signal,
    controlDeadlineMs: captured.controlDeadlineMs,
    async effectiveOwnerUid() { return expectedUid; },
    filesystem: Object.freeze({
      lstat,
      realpath,
      async createExactPrivateDirectory(path: string, parent: Identity, mode: number): Promise<Identity> {
        if (creationEntered || path !== captured.selectedRootPath || mode !== 0o700 || captured.signal.aborted) return uncertain();
        creationEntered = true;
        const expectedParent = identity(parent);
        const childName = basename(captured.selectedRootPath);
        const request = Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1,
          operation: "create_one_private_child" as const, parentPath: captured.selectedParentPath, childName,
          expectedParentIdentity: expectedParent, expectedOwnerUid: expectedUid, mode: 0o700 as const,
          deadlineUnixMs, signal: captured.signal });
        try {
          return nativeReceipt(await captured.nativeDirectory.createOnePrivateChild(request), expectedParent, expectedUid);
        } catch { return uncertain(); }
      },
    }),
    confirmOwnerAttachedTerminal(context: PrivateProtectedRootRunnerContextV1) {
      return captured.terminal.confirmOwnerAttachedTerminal(context);
    },
    async preflightExistingStorage(configuration, context) {
      if (preflightEntered || context.signal !== captured.signal || context.signal.aborted
        || context.requestDigest !== binding.requestDigest || context.operation !== binding.operation) return uncertain();
      preflightEntered = true;
      try { await PersistentLocalArtifactStorageV1.create(configuration); }
      catch { return refused(); }
      return Object.freeze({ schema: PRIVATE_PROTECTED_ROOT_STORAGE_PREFLIGHT_V1,
        requestDigest: binding.requestDigest,
        priorProtectedDataBindingDigest: digest(binding.request.protectedDataBindingDigest),
        storageConfigurationDigest: sha256Digest({ purpose: "protected-artifact-storage-configuration/v1",
          local: captured.privateConfiguration.local, inventory: captured.privateConfiguration.inventory }),
        storageNamespaceDigest: captured.privateConfiguration.inventory.storageNamespaceDigest,
        rootIdentityDigest: digest(context.rootIdentityDigest), outcome: "verified" as const });
    },
  });
}

/** Runs the accepted transaction using this adapter. No default native port is supplied. */
export async function runPrivateProtectedRootOwnerAdapterV1(requestInput: unknown,
  input: unknown): Promise<PrivateProtectedRootOwnerObservationV1> {
  return runPrivateProtectedRootOwnerActionV1(requestInput,
    createPrivateProtectedRootOwnerAdapterV1(requestInput, input));
}
