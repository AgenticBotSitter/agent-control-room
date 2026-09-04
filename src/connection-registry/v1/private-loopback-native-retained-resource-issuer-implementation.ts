import {
  createServer as createNodeNetServerV1,
  Server as NodeNetServerV1,
  type Server,
} from "node:net";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const promiseConstructorV1 = Promise;
const promiseResolveV1 = Promise.resolve;

// Capture the only native authority at module initialization. No exported path can retrieve these bindings.
const createServerV1 = createNodeNetServerV1;
const serverListenV1 = NodeNetServerV1.prototype.listen;
const serverCloseV1 = NodeNetServerV1.prototype.close;
const serverOnceV1 = NodeNetServerV1.prototype.once;
const serverRemoveListenerV1 = NodeNetServerV1.prototype.removeListener;
const literalIpv4LoopbackV1 = "127.0.0.1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_IMPLEMENTATION_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-native-implementation/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-native-retained-resource-issuer-native-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1 =
  objectFreezeV1([
    "node:net.createServer",
    "node:net.Server.prototype.listen",
    "node:net.Server.prototype.close",
    "node:net.Server.prototype.once",
    "node:net.Server.prototype.removeListener",
  ] as const);

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1 = Readonly<{
  implementationVersion:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_IMPLEMENTATION_V1;
  implementationReference: string;
  live210ProductCommit: "c4cac41561214117161c9764604f5dc06ecd63b6";
  acceptedLive210ReviewSha256: "c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7";
  serverModule: "node:net";
  bindHostPolicy: "literal_ipv4_loopback_only";
  portSelectionPolicy: "kernel_assigned_private_unobserved";
  capturedPrimitiveSet:
    typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1;
  maximumNativeServerConstructions: 1;
  maximumListenerAttempts: 1;
  maximumCloses: 1;
  nativeImplementationPresent: true;
  nativeFactoryExported: false;
  nativeFactoryReachable: false;
  callerNativeInputAccepted: false;
  locatorInspectionImplemented: false;
  retainedServerTransferImplemented: false;
  liveClaimOrSpendImplemented: false;
  livePersistenceImplemented: false;
  nativeInvocationAllowed: false;
  repositoryNonExecutionOnly: true;
  runtimeWired: false;
  physicalQualificationAccepted: false;
  clearsCustodyOrHandoffBlocker: false;
  candidateEligible: false;
  activationEligible: false;
  actualNativeBackendConstructions: 0;
  actualListenerAttempts: 0;
  actualCloseAttempts: 0;
  actualNetworkIoEvents: 0;
  externalEffectOccurred: false;
  requiresIndependentReview: true;
  requiresFreshOwnerAuthorizationForPhysicalAttempt: true;
  status: "implemented_unwired_unexercised_review_required";
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

export type ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_STATUS_V1;
  implementationReference: string;
  implementationDigest: string;
  evidenceClass: "repository_static_non_execution";
  nativeImplementationPresent: true;
  nativeFactoryExported: false;
  nativeFactoryReachable: false;
  nativeInvocationAllowed: false;
  nativeAttemptState: "not_attempted";
  locatorState: "not_selected_or_observed";
  retainedResourceState: "not_created";
  handoffState: "not_issued_or_spent";
  cleanupState: "not_required";
  liveClaimOrSpendImplemented: false;
  livePersistenceImplemented: false;
  runtimeWired: false;
  physicalQualificationAccepted: false;
  clearsCustodyOrHandoffBlocker: false;
  candidateEligible: false;
  activationEligible: false;
  actualHostObservations: 0;
  actualPortSelections: 0;
  actualPortReservations: 0;
  actualNativeBackendConstructions: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualListenerAttempts: 0;
  actualCloseAttempts: 0;
  actualHandoffCapabilitiesIssued: 0;
  actualHandoffCapabilitiesSpent: 0;
  actualDriverAcceptCalls: 0;
  actualPersistenceWrites: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  protectedValuesRead: 0;
  externalEffectOccurred: false;
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

export class ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1 extends Error {
  readonly safeCode: "invalid_implementation" | "invalid_status" | "native_issuer_unavailable" |
    "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_implementation" || code === "invalid_status"
      || code === "native_issuer_unavailable" || code === "integrity_failed"
      ? code
      : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

type PrivateNativeCloseOutcomeV1 = "closed" | "cleanup_failed";
type PrivateNativeIssuerOutcomeV1 = Readonly<{
  outcome: "retained_listening" | "failed_before_create" | "ambiguous_after_create";
  retainedServer?: Server;
  closeRetainedServer?: () => Promise<PrivateNativeCloseOutcomeV1>;
}>;
type PrivateNativeIssuerFactoryV1 = () => Promise<PrivateNativeIssuerOutcomeV1>;

const implementationRecordsV1 = new WeakSet<object>();
const implementationDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();
const quarantinedNativeFactoriesV1 = new WeakMap<object, PrivateNativeIssuerFactoryV1>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1["safeCode"]):
never {
  throw new ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1(code);
}

function settledV1<T>(value: T): Promise<T> {
  return reflectApplyV1(promiseResolveV1, promiseConstructorV1, [value]) as Promise<T>;
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "native retained resource issuer implementation record"); }
  catch { failV1("integrity_failed"); }
}

/*
 * This factory deliberately has no caller input and is held only in a module-private WeakMap. It cannot be reached by
 * an application, test, or exported function. A later block must add durable claim/effect-marker composition before it
 * may retrieve or invoke this factory; doing so is explicitly outside LIVE-220.
 */
function createQuarantinedNativeIssuerV1(): Promise<PrivateNativeIssuerOutcomeV1> {
  let server: Server;
  try {
    server = reflectApplyV1(createServerV1, undefined, []) as Server;
  } catch {
    return settledV1(objectFreezeV1({ outcome: "failed_before_create" as const }));
  }

  let closeConsumed = false;
  const closeRetainedServer = objectFreezeV1((): Promise<PrivateNativeCloseOutcomeV1> => {
    if (closeConsumed) return settledV1("cleanup_failed");
    closeConsumed = true;
    return new promiseConstructorV1<PrivateNativeCloseOutcomeV1>((resolve) => {
      let settled = false;
      const settle = (outcome: PrivateNativeCloseOutcomeV1): void => {
        if (settled) return;
        settled = true;
        try { reflectApplyV1(serverRemoveListenerV1, server, ["error", onCloseError]); } catch { /* sanitized */ }
        resolve(outcome);
      };
      const onCloseError = (): void => settle("cleanup_failed");
      try {
        reflectApplyV1(serverOnceV1, server, ["error", onCloseError]);
        reflectApplyV1(serverCloseV1, server, [() => settle("closed")]);
      } catch {
        settle("cleanup_failed");
      }
    });
  });

  return new promiseConstructorV1<PrivateNativeIssuerOutcomeV1>((resolve) => {
    let settled = false;
    const settle = (outcome: PrivateNativeIssuerOutcomeV1): void => {
      if (settled) return;
      settled = true;
      try { reflectApplyV1(serverRemoveListenerV1, server, ["error", onError]); } catch { /* sanitized */ }
      try { reflectApplyV1(serverRemoveListenerV1, server, ["listening", onListening]); } catch { /* sanitized */ }
      resolve(objectFreezeV1(outcome));
    };
    const onError = (): void => settle(objectFreezeV1({
      outcome: "ambiguous_after_create" as const,
      retainedServer: server,
      closeRetainedServer,
    }));
    const onListening = (): void => settle(objectFreezeV1({
      outcome: "retained_listening" as const,
      retainedServer: server,
      closeRetainedServer,
    }));
    try {
      reflectApplyV1(serverOnceV1, server, ["error", onError]);
      reflectApplyV1(serverOnceV1, server, ["listening", onListening]);
      reflectApplyV1(serverListenV1, server, [{
        host: literalIpv4LoopbackV1,
        port: 0,
        exclusive: true,
      }]);
    } catch {
      onError();
    }
  });
}

const implementationSeedV1 = sha256Digest({
  live210ProductCommit: "c4cac41561214117161c9764604f5dc06ecd63b6",
  acceptedLive210ReviewSha256: "c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7",
  serverModule: "node:net",
  bindHostPolicy: "literal_ipv4_loopback_only",
  capturedPrimitives: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1,
});

const implementationMaterialV1 = {
  implementationVersion:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_IMPLEMENTATION_V1,
  implementationReference: `native-retained-resource-issuer-native:${reflectApplyV1(stringSliceV1,
    implementationSeedV1, [7, 31])}`,
  live210ProductCommit: "c4cac41561214117161c9764604f5dc06ecd63b6" as const,
  acceptedLive210ReviewSha256: "c25e22dfa2c8601b23547a8a6f32b68d78da23458a696cd9461678ce084ec2c7" as const,
  serverModule: "node:net" as const,
  bindHostPolicy: "literal_ipv4_loopback_only" as const,
  portSelectionPolicy: "kernel_assigned_private_unobserved" as const,
  capturedPrimitiveSet:
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1,
  maximumNativeServerConstructions: 1 as const,
  maximumListenerAttempts: 1 as const,
  maximumCloses: 1 as const,
  nativeImplementationPresent: true as const,
  nativeFactoryExported: false as const,
  nativeFactoryReachable: false as const,
  callerNativeInputAccepted: false as const,
  locatorInspectionImplemented: false as const,
  retainedServerTransferImplemented: false as const,
  liveClaimOrSpendImplemented: false as const,
  livePersistenceImplemented: false as const,
  nativeInvocationAllowed: false as const,
  repositoryNonExecutionOnly: true as const,
  runtimeWired: false as const,
  physicalQualificationAccepted: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  actualNativeBackendConstructions: 0 as const,
  actualListenerAttempts: 0 as const,
  actualCloseAttempts: 0 as const,
  actualNetworkIoEvents: 0 as const,
  externalEffectOccurred: false as const,
  requiresIndependentReview: true as const,
  requiresFreshOwnerAuthorizationForPhysicalAttempt: true as const,
  status: "implemented_unwired_unexercised_review_required" as const,
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
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1 =
  objectFreezeV1({ ...implementationMaterialV1, implementationDigest: sha256Digest(implementationMaterialV1) });
reflectApplyV1(weakSetAddV1, implementationRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1]);
reflectApplyV1(weakMapSetV1, implementationDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1.implementationDigest]);
reflectApplyV1(weakMapSetV1, quarantinedNativeFactoriesV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
    objectFreezeV1(createQuarantinedNativeIssuerV1)]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_NATIVE_STATUS_V1,
  implementationReference:
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1.implementationReference,
  implementationDigest:
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1.implementationDigest,
  evidenceClass: "repository_static_non_execution" as const,
  nativeImplementationPresent: true as const,
  nativeFactoryExported: false as const,
  nativeFactoryReachable: false as const,
  nativeInvocationAllowed: false as const,
  nativeAttemptState: "not_attempted" as const,
  locatorState: "not_selected_or_observed" as const,
  retainedResourceState: "not_created" as const,
  handoffState: "not_issued_or_spent" as const,
  cleanupState: "not_required" as const,
  liveClaimOrSpendImplemented: false as const,
  livePersistenceImplemented: false as const,
  runtimeWired: false as const,
  physicalQualificationAccepted: false as const,
  clearsCustodyOrHandoffBlocker: false as const,
  candidateEligible: false as const,
  activationEligible: false as const,
  actualHostObservations: 0 as const,
  actualPortSelections: 0 as const,
  actualPortReservations: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualNativeResourcesCreated: 0 as const,
  actualNativeResourcesRetained: 0 as const,
  actualListenerAttempts: 0 as const,
  actualCloseAttempts: 0 as const,
  actualHandoffCapabilitiesIssued: 0 as const,
  actualHandoffCapabilitiesSpent: 0 as const,
  actualDriverAcceptCalls: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  protectedValuesRead: 0 as const,
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

safePublicRecordV1(statusMaterialV1);
export const connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
    connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, implementationRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_implementation");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1;
  const captured = exactHostDataSnapshotV1(record, [
    "implementationVersion", "implementationReference", "live210ProductCommit", "acceptedLive210ReviewSha256",
    "serverModule", "bindHostPolicy", "portSelectionPolicy", "capturedPrimitiveSet",
    "maximumNativeServerConstructions", "maximumListenerAttempts", "maximumCloses",
    "nativeImplementationPresent", "nativeFactoryExported", "nativeFactoryReachable", "callerNativeInputAccepted",
    "locatorInspectionImplemented", "retainedServerTransferImplemented", "liveClaimOrSpendImplemented",
    "livePersistenceImplemented", "nativeInvocationAllowed", "repositoryNonExecutionOnly", "runtimeWired",
    "physicalQualificationAccepted", "clearsCustodyOrHandoffBlocker", "candidateEligible", "activationEligible",
    "actualNativeBackendConstructions", "actualListenerAttempts", "actualCloseAttempts", "actualNetworkIoEvents",
    "externalEffectOccurred", "requiresIndependentReview", "requiresFreshOwnerAuthorizationForPhysicalAttempt",
    "status", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "implementationDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, implementationDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.implementationDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1
    || record.capturedPrimitiveSet !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_RETAINED_RESOURCE_ISSUER_CAPTURED_PRIMITIVES_V1
    || !record.nativeImplementationPresent || record.nativeFactoryExported || record.nativeFactoryReachable
    || record.callerNativeInputAccepted || record.locatorInspectionImplemented
    || record.retainedServerTransferImplemented || record.liveClaimOrSpendImplemented
    || record.livePersistenceImplemented || record.nativeInvocationAllowed || !record.repositoryNonExecutionOnly
    || record.runtimeWired || record.physicalQualificationAccepted || record.clearsCustodyOrHandoffBlocker
    || record.candidateEligible || record.activationEligible || record.externalEffectOccurred) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "implementationReference", "implementationDigest", "evidenceClass",
    "nativeImplementationPresent", "nativeFactoryExported", "nativeFactoryReachable", "nativeInvocationAllowed",
    "nativeAttemptState", "locatorState", "retainedResourceState", "handoffState", "cleanupState",
    "liveClaimOrSpendImplemented", "livePersistenceImplemented", "runtimeWired", "physicalQualificationAccepted",
    "clearsCustodyOrHandoffBlocker", "candidateEligible", "activationEligible", "actualHostObservations",
    "actualPortSelections", "actualPortReservations", "actualNativeBackendConstructions",
    "actualNativeResourcesCreated", "actualNativeResourcesRetained", "actualListenerAttempts",
    "actualCloseAttempts", "actualHandoffCapabilitiesIssued", "actualHandoffCapabilitiesSpent",
    "actualDriverAcceptCalls", "actualPersistenceWrites", "actualTimerCreations", "actualNetworkIoEvents",
    "protectedValuesRead", "externalEffectOccurred", "grantsApproval", "grantsQualificationAuthority",
    "grantsCandidateAuthority", "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1
    || record.implementationReference !==
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1.implementationReference
    || record.implementationDigest !==
      connectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1.implementationDigest
    || record.evidenceClass !== "repository_static_non_execution" || record.nativeFactoryExported
    || record.nativeFactoryReachable || record.nativeInvocationAllowed || record.nativeAttemptState !== "not_attempted"
    || record.runtimeWired || record.physicalQualificationAccepted || record.clearsCustodyOrHandoffBlocker
    || record.candidateEligible || record.activationEligible || record.externalEffectOccurred) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1(): never {
  failV1("native_issuer_unavailable");
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeImplementationV1,
  parseConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeStatusV1,
  createConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackNativeRetainedResourceIssuerNativeErrorV1.prototype);
