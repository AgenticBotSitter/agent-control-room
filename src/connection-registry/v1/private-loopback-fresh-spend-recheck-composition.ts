import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import {
  exactHostDataSnapshotV1,
  exactHostErrorCodeV1,
  isHostProxyV1,
} from "../../security/host-value";
import {
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
} from "./private-loopback-fresh-spend-recheck-composition-contract";
import {
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1,
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1,
  type ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1,
} from "./private-loopback-invocation-authorization-store";

const arrayIncludesV1 = Array.prototype.includes;
const arraySomeV1 = Array.prototype.some;
const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

const consumeForInvocationV1 =
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.consumeForInvocation;
const recheckAfterConsumptionV1 =
  ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1.prototype.recheckAfterConsumption;
const storeErrorPrototypeV1 = ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreErrorV1.prototype;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-fresh-spend-recheck-composition-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-fresh-spend-recheck-composition-implementation-status/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-fresh-spend-recheck-composition-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1 =
  objectFreezeV1([
    "rejected_before_spend",
    "terminal_spend_uncertain",
    "terminal_already_consumed",
    "terminal_recheck_failed",
    "completed_and_stopped_before_lookup",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionTerminalOutcomeV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1[number];

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_V1;
  implementationReference: string;
  live390ProductCommit: "34640c7c6a3c63b781aa848f687ae1c23e7c2dee";
  acceptedLive390ReviewSha256: "c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586";
  terminalOutcomes:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1;
  maximumSpendCallsPerFlow: 1;
  maximumRecheckCallsPerFlow: 1;
  maximumSourceLookupsPerFlow: 0;
  exactStoreConstructedInsideFactory: true;
  exactStoreMethodsCaptured: true;
  sameSealedAuthorizationValueRequired: true;
  exactFreshReceiptPrivatelyForwarded: true;
  receiptsAcceptedFromCaller: false;
  receiptsReturnedToCaller: false;
  automaticRetryImplemented: false;
  replacementAuthorizationImplemented: false;
  fallbackImplemented: false;
  sourceImported: false;
  sourceLookupImplemented: false;
  sourceInvocationImplemented: false;
  implementationBarrelExported: false;
  runtimeWired: false;
  productionDatabaseConfigured: false;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  implementationDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1 = Readonly<{
  statusVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_implementation_unwired_non_execution";
  compositionState: "implemented_unwired";
  sourceState: "not_imported_or_reachable";
  runtimeState: "not_wired";
  actualFactoryCalls: 0;
  actualCompositionCalls: 0;
  actualAuthorizationConsumptions: 0;
  actualPostTransactionRechecks: 0;
  actualReceiptInputs: 0;
  actualReceiptExports: 0;
  actualRetryAttempts: 0;
  actualReplacementAuthorizations: 0;
  actualFallbackAttempts: 0;
  actualSourceImports: 0;
  actualSourceLookups: 0;
  actualSourceInvocations: 0;
  actualNativeReads: 0;
  actualRawObservationReturns: 0;
  actualAttestationsCreated: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPhysicalAttempts: 0;
  actualNativeListenerAttempts: 0;
  actualNetworkIoEvents: 0;
  actualProviderCalls: 0;
  actualProtectedValuesRead: 0;
  actualCommandsExecuted: 0;
  externalEffectOccurred: false;
  sourceBoundaryCrossed: false;
  targetRuntimeBlockerCleared: false;
  physicalQualificationAccepted: false;
  runtimeWired: false;
  candidateEligible: false;
  activationEligible: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  statusDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RESULT_V1;
  implementationReference: string;
  implementationDigest: string;
  outcome: ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionTerminalOutcomeV1;
  spendState: "not_spent" | "spent" | "unknown_or_spent";
  spendCalls: 1;
  recheckCalls: 0 | 1;
  postTransactionTimeRechecked: boolean;
  terminal: true;
  retryAllowedByResult: false;
  receiptExported: false;
  sourceLookupPerformed: false;
  sourceInvocationPerformed: false;
  nativeReadPerformed: false;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  resultDigest: string;
}>;

export interface ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionRunnerV1 {
  run(sealedAuthorization: unknown):
    Promise<ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1>;
}

export class ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "invalid_result" | "invalid_factory_input"
    | "integrity_failed";

  constructor(code: unknown) {
    const allowed = ["invalid_implementation", "invalid_status", "invalid_result", "invalid_factory_input",
      "integrity_failed"] as const;
    const safeCode = typeof code === "string" && reflectApplyV1(arrayIncludesV1, allowed, [code])
      ? code as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1["safeCode"]
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(
  code: ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1["safeCode"],
): never {
  throw new ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "fresh spend recheck composition implementation record"); }
  catch { failV1("integrity_failed"); }
}

const implementationSeedV1 = sha256Digest({
  live390ProductCommit: "34640c7c6a3c63b781aa848f687ae1c23e7c2dee",
  acceptedLive390ReviewSha256: "c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586",
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1,
});

const implementationMaterialV1 = {
  implementationVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_V1,
  implementationReference: `fresh-spend-recheck-composition-implementation:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live390ProductCommit: "34640c7c6a3c63b781aa848f687ae1c23e7c2dee" as const,
  acceptedLive390ReviewSha256: "c41370441890e64ef53c76c65a8990119520f550cea093e59aa71d7a4926e586" as const,
  terminalOutcomes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1,
  maximumSpendCallsPerFlow: 1 as const,
  maximumRecheckCallsPerFlow: 1 as const,
  maximumSourceLookupsPerFlow: 0 as const,
  exactStoreConstructedInsideFactory: true as const,
  exactStoreMethodsCaptured: true as const,
  sameSealedAuthorizationValueRequired: true as const,
  exactFreshReceiptPrivatelyForwarded: true as const,
  receiptsAcceptedFromCaller: false as const,
  receiptsReturnedToCaller: false as const,
  automaticRetryImplemented: false as const,
  replacementAuthorizationImplemented: false as const,
  fallbackImplemented: false as const,
  sourceImported: false as const,
  sourceLookupImplemented: false as const,
  sourceInvocationImplemented: false as const,
  implementationBarrelExported: false as const,
  runtimeWired: false as const,
  productionDatabaseConfigured: false as const,
  externalEffectOccurred: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(implementationMaterialV1);
export const connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1 = objectFreezeV1({
  ...implementationMaterialV1,
  implementationDigest: sha256Digest(implementationMaterialV1),
});
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1,
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationDigest]);

const zeroActualsV1 = {
  actualFactoryCalls: 0 as const,
  actualCompositionCalls: 0 as const,
  actualAuthorizationConsumptions: 0 as const,
  actualPostTransactionRechecks: 0 as const,
  actualReceiptInputs: 0 as const,
  actualReceiptExports: 0 as const,
  actualRetryAttempts: 0 as const,
  actualReplacementAuthorizations: 0 as const,
  actualFallbackAttempts: 0 as const,
  actualSourceImports: 0 as const,
  actualSourceLookups: 0 as const,
  actualSourceInvocations: 0 as const,
  actualNativeReads: 0 as const,
  actualRawObservationReturns: 0 as const,
  actualAttestationsCreated: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPhysicalAttempts: 0 as const,
  actualNativeListenerAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProviderCalls: 0 as const,
  actualProtectedValuesRead: 0 as const,
  actualCommandsExecuted: 0 as const,
};

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_IMPLEMENTATION_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationDigest,
  evidenceClass: "repository_implementation_unwired_non_execution" as const,
  compositionState: "implemented_unwired" as const,
  sourceState: "not_imported_or_reachable" as const,
  runtimeState: "not_wired" as const,
  ...zeroActualsV1,
  externalEffectOccurred: false as const,
  sourceBoundaryCrossed: false as const,
  targetRuntimeBlockerCleared: false as const,
  physicalQualificationAccepted: false as const,
  runtimeWired: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(statusMaterialV1);
export const connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1,
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1.statusDigest]);

function buildResultV1(
  outcome: ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionTerminalOutcomeV1,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1 {
  const spendState = outcome === "rejected_before_spend" ? "not_spent" as const
    : outcome === "terminal_spend_uncertain" ? "unknown_or_spent" as const : "spent" as const;
  const recheckCalls = outcome === "terminal_recheck_failed" || outcome === "completed_and_stopped_before_lookup"
    ? 1 as const : 0 as const;
  const material = {
    resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RESULT_V1,
    implementationReference:
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationReference,
    implementationDigest:
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationDigest,
    outcome,
    spendState,
    spendCalls: 1 as const,
    recheckCalls,
    postTransactionTimeRechecked: outcome === "completed_and_stopped_before_lookup",
    terminal: true as const,
    retryAllowedByResult: false as const,
    receiptExported: false as const,
    sourceLookupPerformed: false as const,
    sourceInvocationPerformed: false as const,
    nativeReadPerformed: false as const,
    grantsApproval: false as const,
    grantsQualificationAuthority: false as const,
    grantsCandidateAuthority: false as const,
    grantsActivationAuthority: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  safePublicRecordV1(material);
  const result = objectFreezeV1({ ...material, resultDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, resultRecordsV1, [result]);
  reflectApplyV1(weakMapSetV1, resultDigestsV1, [result, result.resultDigest]);
  return result;
}

async function runPrivateFreshSpendRecheckV1(
  store: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1,
  sealedAuthorization: unknown,
): Promise<ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1> {
  try {
    if (parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
    ) !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1) {
      return buildResultV1("rejected_before_spend");
    }
  } catch {
    return buildResultV1("rejected_before_spend");
  }

  let freshReceipt: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1 | undefined;
  let recheckReceipt: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1 | undefined;
  try {
    try {
      freshReceipt = await reflectApplyV1(consumeForInvocationV1, store, [sealedAuthorization]) as
        ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationConsumptionV1;
    } catch (error) {
      const code = exactHostErrorCodeV1(error, storeErrorPrototypeV1, "safeCode");
      return buildResultV1(code === "terminal_ambiguity" || code === undefined
        ? "terminal_spend_uncertain" : "rejected_before_spend");
    }

    if (freshReceipt.freshConsumption !== true
      || freshReceipt.state !== "consumed_pending_post_transaction_time_recheck") {
      return buildResultV1("terminal_already_consumed");
    }

    try {
      recheckReceipt = await reflectApplyV1(recheckAfterConsumptionV1, store,
        [sealedAuthorization, freshReceipt]) as ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationRecheckV1;
    } catch {
      return buildResultV1("terminal_recheck_failed");
    }

    if (recheckReceipt.state !== "consumed_and_post_transaction_time_rechecked"
      || recheckReceipt.postTransactionTimeRechecked !== true
      || recheckReceipt.sourceLookupPerformed !== false
      || recheckReceipt.sourceInvocationPerformed !== false
      || recheckReceipt.nativeReadPerformed !== false) {
      return buildResultV1("terminal_recheck_failed");
    }
    return buildResultV1("completed_and_stopped_before_lookup");
  } finally {
    freshReceipt = undefined;
    recheckReceipt = undefined;
  }
}

export const createConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionV1 = objectFreezeV1((
  database: DatabaseClient,
  protectedKeys: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionRunnerV1 => {
  let store: ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1;
  try {
    store = new ConnectionEnrollmentPrivateLoopbackInvocationAuthorizationStoreV1(database, protectedKeys);
  } catch {
    failV1("invalid_factory_input");
  }
  const run = objectFreezeV1((sealedAuthorization: unknown) =>
    runPrivateFreshSpendRecheckV1(store, sealedAuthorization));
  return objectFreezeV1({ run });
});

export function parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live390ProductCommit", "acceptedLive390ReviewSha256",
    "terminalOutcomes", "maximumSpendCallsPerFlow", "maximumRecheckCallsPerFlow", "maximumSourceLookupsPerFlow",
    "exactStoreConstructedInsideFactory", "exactStoreMethodsCaptured", "sameSealedAuthorizationValueRequired",
    "exactFreshReceiptPrivatelyForwarded", "receiptsAcceptedFromCaller", "receiptsReturnedToCaller",
    "automaticRetryImplemented", "replacementAuthorizationImplemented", "fallbackImplemented", "sourceImported",
    "sourceLookupImplemented", "sourceInvocationImplemented", "implementationBarrelExported", "runtimeWired",
    "productionDatabaseConfigured", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1
    || record.terminalOutcomes !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1
    || record.maximumSpendCallsPerFlow !== 1 || record.maximumRecheckCallsPerFlow !== 1
    || record.maximumSourceLookupsPerFlow !== 0 || !record.exactStoreConstructedInsideFactory
    || !record.exactStoreMethodsCaptured || !record.sameSealedAuthorizationValueRequired
    || !record.exactFreshReceiptPrivatelyForwarded || record.receiptsAcceptedFromCaller
    || record.receiptsReturnedToCaller || record.automaticRetryImplemented
    || record.replacementAuthorizationImplemented || record.fallbackImplemented || record.sourceImported
    || record.sourceLookupImplemented || record.sourceInvocationImplemented || record.implementationBarrelExported
    || record.runtimeWired || record.productionDatabaseConfigured || record.externalEffectOccurred
    || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass", "compositionState",
    "sourceState", "runtimeState", "actualFactoryCalls", "actualCompositionCalls",
    "actualAuthorizationConsumptions", "actualPostTransactionRechecks", "actualReceiptInputs",
    "actualReceiptExports", "actualRetryAttempts", "actualReplacementAuthorizations", "actualFallbackAttempts",
    "actualSourceImports", "actualSourceLookups", "actualSourceInvocations", "actualNativeReads",
    "actualRawObservationReturns", "actualAttestationsCreated", "actualCandidateAssemblerEntries",
    "actualOwnerAuthorizationSpends", "actualPhysicalAttempts", "actualNativeListenerAttempts",
    "actualNetworkIoEvents", "actualProviderCalls", "actualProtectedValuesRead", "actualCommandsExecuted",
    "externalEffectOccurred", "sourceBoundaryCrossed", "targetRuntimeBlockerCleared",
    "physicalQualificationAccepted", "runtimeWired", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const actuals = [record.actualFactoryCalls, record.actualCompositionCalls, record.actualAuthorizationConsumptions,
    record.actualPostTransactionRechecks, record.actualReceiptInputs, record.actualReceiptExports,
    record.actualRetryAttempts, record.actualReplacementAuthorizations, record.actualFallbackAttempts,
    record.actualSourceImports, record.actualSourceLookups, record.actualSourceInvocations, record.actualNativeReads,
    record.actualRawObservationReturns, record.actualAttestationsCreated, record.actualCandidateAssemblerEntries,
    record.actualOwnerAuthorizationSpends, record.actualPhysicalAttempts, record.actualNativeListenerAttempts,
    record.actualNetworkIoEvents, record.actualProviderCalls, record.actualProtectedValuesRead,
    record.actualCommandsExecuted];
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationDigest
    || record.evidenceClass !== "repository_implementation_unwired_non_execution"
    || record.compositionState !== "implemented_unwired" || record.sourceState !== "not_imported_or_reachable"
    || record.runtimeState !== "not_wired" || actuals.length !== 23
    || reflectApplyV1(arraySomeV1, actuals, [(entry: number) => entry !== 0])
    || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])
    || record.externalEffectOccurred || record.sourceBoundaryCrossed || record.targetRuntimeBlockerCleared
    || record.physicalQualificationAccepted || record.runtimeWired || record.candidateEligible
    || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "implementationReference", "implementationDigest", "outcome", "spendState", "spendCalls",
    "recheckCalls", "postTransactionTimeRechecked", "terminal", "retryAllowedByResult", "receiptExported",
    "sourceLookupPerformed", "sourceInvocationPerformed", "nativeReadPerformed", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  const expectedSpendState = record.outcome === "rejected_before_spend" ? "not_spent"
    : record.outcome === "terminal_spend_uncertain" ? "unknown_or_spent" : "spent";
  const expectedRecheckCalls = record.outcome === "terminal_recheck_failed"
    || record.outcome === "completed_and_stopped_before_lookup" ? 1 : 0;
  const grants = [record.grantsApproval, record.grantsQualificationAuthority, record.grantsCandidateAuthority,
    record.grantsActivationAuthority, record.grantsNetworkAuthority, record.grantsCommandAuthority,
    record.grantsLeaseAuthority, record.grantsExecutionAuthority];
  if (!captured || digest !== record.resultDigest
    || record.resultVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RESULT_V1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1.implementationDigest
    || !reflectApplyV1(arrayIncludesV1,
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_TERMINAL_OUTCOMES_V1, [record.outcome])
    || record.spendState !== expectedSpendState || record.spendCalls !== 1
    || record.recheckCalls !== expectedRecheckCalls
    || record.postTransactionTimeRechecked !== (record.outcome === "completed_and_stopped_before_lookup")
    || record.terminal !== true || record.retryAllowedByResult !== false || record.receiptExported !== false
    || record.sourceLookupPerformed !== false || record.sourceInvocationPerformed !== false
    || record.nativeReadPerformed !== false
    || reflectApplyV1(arraySomeV1, grants, [(entry: boolean) => entry !== false])) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionImplementationStatusV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionResultV1);
