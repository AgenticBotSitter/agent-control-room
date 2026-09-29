import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Source-only preparation for the native boundary required by the retained
 * installation-plan journal. It does not open the journal or supply a path-
 * based fallback. A later native adapter must implement this exact held-
 * descriptor operation contract before operator composition can be ready.
 */
export const PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1 =
  "control-room.private-installation-journal-native-custody-preparation/v1" as const;
export const PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1 =
  "control-room.private-installation-journal-native-operation/v1" as const;

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const maximumOperationDeadlineMs = 30_000;

const privateInstallationJournalNativeReadPrimitivesV1 = Object.freeze([
  "openat_no_follow",
  "fstat",
  "fstatat_no_follow",
  "fdopendir_readdir",
  "openat_read",
] as const);

export const privateInstallationJournalNativeInspectionPrimitivesV1 = Object.freeze([
  ...privateInstallationJournalNativeReadPrimitivesV1,
  "close_all_descriptors",
] as const);

export const privateInstallationJournalNativeRecoveryPrimitivesV1 = Object.freeze([
  ...privateInstallationJournalNativeReadPrimitivesV1,
  "unlinkat_exact_identity",
  "fsync_directory",
  "close_all_descriptors",
] as const);

export const privateInstallationJournalNativeAppendPrimitivesV1 = Object.freeze([
  ...privateInstallationJournalNativeReadPrimitivesV1,
  "unlinkat_exact_identity",
  "fsync_directory",
  "openat_create_exclusive",
  "write_exact_bounded",
  "fsync_file",
  "linkat_no_replace",
  "close_all_descriptors",
] as const);

export const privateInstallationJournalNativeGuaranteesV1 = Object.freeze({
  opensEveryAncestorNoFollow: true as const,
  holdsAncestorChainUntilOperationClose: true as const,
  holdsJournalRootUntilOperationClose: true as const,
  performsEveryEntryOperationRelativeToHeldRoot: true as const,
  permitsPathBasedEntryOperation: false as const,
  reopensAndMatchesNamedChainBeforeSuccess: true as const,
  verifiesOwnerModeAndNoExtendedAcl: true as const,
  writesExactBoundedBytesOnlyToNewlyCreatedHeldFile: true as const,
  retriesMutationAfterUncertainReply: false as const,
});

export type PrivateInstallationJournalNativeOperationKindV1 =
  "read_history" | "inspect_settled_history" | "append";

export type PrivateInstallationJournalRootIdentityV1 = Readonly<{
  device: number;
  inode: number;
}>;

export type PrivateInstallationJournalNativePrimitiveV1 =
  typeof privateInstallationJournalNativeAppendPrimitivesV1[number];

export type PrivateInstallationJournalNativeCapabilitiesV1 = Readonly<{
  recoversRetainedPublication: boolean;
  createsExclusiveEntry: boolean;
  writesExactBoundedEntry: boolean;
  publishesNoReplaceHardLink: boolean;
  unlinksExactIdentity: boolean;
  syncsFile: boolean;
  syncsDirectory: boolean;
}>;

export type PrivateInstallationJournalNativeOperationRequestV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1;
  operationId: string;
  operation: PrivateInstallationJournalNativeOperationKindV1;
  journalRootPath: string;
  journalBindingDigest: string;
  installationId: string;
  expectedRootIdentity: PrivateInstallationJournalRootIdentityV1;
  expectedOwnerUid: number;
  expectedRootMode: 0o700;
  maximumPlanBytes: 65_536;
  maximumWitnessBytes: 1_024;
  maximumRevisions: 10_000;
  deadlineUnixMs: number;
  signal: AbortSignal;
  requiredPrimitives: readonly PrivateInstallationJournalNativePrimitiveV1[];
  capabilities: PrivateInstallationJournalNativeCapabilitiesV1;
  requiredGuarantees: typeof privateInstallationJournalNativeGuaranteesV1;
  recoveryScope: "none" | "retained_publication_only";
  mayMutateForRecovery: boolean;
  mayAppend: boolean;
}>;

export type PrivateInstallationJournalNativeCustodyPreparationV1 = Readonly<{
  schema: typeof PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1;
  status: "prepared";
  journalBindingDigest: string;
  prepareOperation(operation: PrivateInstallationJournalNativeOperationKindV1,
    signal: AbortSignal): PrivateInstallationJournalNativeOperationRequestV1;
  retainsInstallationPlanJournal: true;
  constructsJournal: false;
  createsStore: false;
  performsNativeOperation: false;
  readyForOperatorComposition: false;
  remainingBlocker: "native_held_journal_session_and_adapter_missing";
}>;

type Captured = Readonly<{
  journalRootPath: string;
  installationId: string;
  expectedRootIdentity: PrivateInstallationJournalRootIdentityV1;
  expectedOwnerUid: number;
  operationDeadlineMs: number;
  journalBindingDigest: string;
}>;

function refused(): never {
  const error = new Error("private_installation_journal_native_custody_preparation_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))
    || names.some(name => !actual.includes(name))) return refused();
  for (const name of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
  }
  return value as Readonly<Record<string, unknown>>;
}

function safeInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) return refused();
  return value as number;
}

function rootPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value === "/"
    || value.endsWith("/") || Buffer.byteLength(value, "utf8") > 4096
    || Buffer.from(value, "utf8").toString("utf8") !== value || /[\u0000-\u001f\u007f]/u.test(value)) return refused();
  return value;
}

function identity(value: unknown): PrivateInstallationJournalRootIdentityV1 {
  const item = exact(value, ["device", "inode"]);
  return Object.freeze({ device: safeInteger(item.device, Number.MAX_SAFE_INTEGER),
    inode: safeInteger(item.inode, Number.MAX_SAFE_INTEGER) });
}

function capture(value: unknown): Captured {
  const input = exact(value, ["schema", "journalRootPath", "installationId", "expectedRootIdentity",
    "expectedOwnerUid", "operationDeadlineMs"]);
  if (input.schema !== PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1
    || typeof input.installationId !== "string" || !installationIdPattern.test(input.installationId)) return refused();
  const journalRootPath = rootPath(input.journalRootPath);
  const installationId = input.installationId;
  const expectedRootIdentity = identity(input.expectedRootIdentity);
  const expectedOwnerUid = safeInteger(input.expectedOwnerUid, 0x7fffffff);
  const operationDeadlineMs = safeInteger(input.operationDeadlineMs, maximumOperationDeadlineMs);
  if (operationDeadlineMs < 1) return refused();
  const journalBindingDigest = sha256Digest({ purpose: "private-installation-journal-native-binding/v1",
    journalRootPath, installationId, expectedRootIdentity, expectedOwnerUid, expectedRootMode: 0o700,
    maximumPlanBytes: 64 * 1024, maximumWitnessBytes: 1_024, maximumRevisions: 10_000 });
  return Object.freeze({ journalRootPath, installationId, expectedRootIdentity,
    expectedOwnerUid, operationDeadlineMs, journalBindingDigest });
}

function operation(value: unknown): PrivateInstallationJournalNativeOperationKindV1 {
  if (value !== "read_history" && value !== "inspect_settled_history" && value !== "append") return refused();
  return value;
}

function operationBoundary(selected: PrivateInstallationJournalNativeOperationKindV1): Readonly<{
  requiredPrimitives: readonly PrivateInstallationJournalNativePrimitiveV1[];
  capabilities: PrivateInstallationJournalNativeCapabilitiesV1;
  recoveryScope: "none" | "retained_publication_only";
}> {
  if (selected === "inspect_settled_history") return Object.freeze({
    requiredPrimitives: privateInstallationJournalNativeInspectionPrimitivesV1,
    capabilities: Object.freeze({ recoversRetainedPublication: false, createsExclusiveEntry: false,
      writesExactBoundedEntry: false, publishesNoReplaceHardLink: false, unlinksExactIdentity: false,
      syncsFile: false, syncsDirectory: false }),
    recoveryScope: "none" as const,
  });
  if (selected === "read_history") return Object.freeze({
    requiredPrimitives: privateInstallationJournalNativeRecoveryPrimitivesV1,
    capabilities: Object.freeze({ recoversRetainedPublication: true, createsExclusiveEntry: false,
      writesExactBoundedEntry: false, publishesNoReplaceHardLink: false, unlinksExactIdentity: true,
      syncsFile: false, syncsDirectory: true }),
    recoveryScope: "retained_publication_only" as const,
  });
  return Object.freeze({ requiredPrimitives: privateInstallationJournalNativeAppendPrimitivesV1,
    capabilities: Object.freeze({ recoversRetainedPublication: true, createsExclusiveEntry: true,
      writesExactBoundedEntry: true, publishesNoReplaceHardLink: true, unlinksExactIdentity: true,
      syncsFile: true, syncsDirectory: true }),
    recoveryScope: "retained_publication_only" as const,
  });
}

/**
 * Captures only immutable binding data. prepareOperation creates a request for
 * a later reviewed native session; it does not call a native port itself.
 */
export function preparePrivateInstallationJournalNativeCustodyV1(inputValue: unknown):
  PrivateInstallationJournalNativeCustodyPreparationV1 {
  const input = capture(inputValue);
  const prepareOperation = (operationValue: PrivateInstallationJournalNativeOperationKindV1,
    signal: AbortSignal): PrivateInstallationJournalNativeOperationRequestV1 => {
    const selected = operation(operationValue);
    if (!(signal instanceof AbortSignal) || signal.aborted) return refused();
    const deadlineUnixMs = Date.now() + input.operationDeadlineMs;
    if (!Number.isSafeInteger(deadlineUnixMs)) return refused();
    const boundary = operationBoundary(selected);
    return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1,
      operationId: randomUUID(), operation: selected, journalRootPath: input.journalRootPath,
      journalBindingDigest: input.journalBindingDigest, installationId: input.installationId,
      expectedRootIdentity: input.expectedRootIdentity, expectedOwnerUid: input.expectedOwnerUid,
      expectedRootMode: 0o700 as const, maximumPlanBytes: 65_536 as const,
      maximumWitnessBytes: 1_024 as const, maximumRevisions: 10_000 as const, deadlineUnixMs, signal,
      requiredPrimitives: boundary.requiredPrimitives, capabilities: boundary.capabilities,
      requiredGuarantees: privateInstallationJournalNativeGuaranteesV1,
      recoveryScope: boundary.recoveryScope, mayMutateForRecovery: boundary.capabilities.recoversRetainedPublication,
      mayAppend: selected === "append" });
  };
  return Object.freeze({ schema: PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1,
    status: "prepared" as const, journalBindingDigest: input.journalBindingDigest, prepareOperation,
    retainsInstallationPlanJournal: true as const, constructsJournal: false as const,
    createsStore: false as const, performsNativeOperation: false as const,
    readyForOperatorComposition: false as const,
    remainingBlocker: "native_held_journal_session_and_adapter_missing" as const });
}
