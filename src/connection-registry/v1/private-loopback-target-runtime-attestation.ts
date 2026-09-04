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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-target-runtime-attestation-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1 =
  "control-room-connection-enrollment-private-loopback-target-runtime-attestation-result/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1 = objectFreezeV1([
  "arm64",
  "x64",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1 = objectFreezeV1([
  "platform_family",
  "architecture_class",
  "runtime_semantic_version",
  "runtime_executable_content_identity",
  "operating_system_boot_epoch",
  "attestor_process_session_epoch",
  "qualification_harness_identity",
  "accepted_physical_driver_build_identity",
  "qualification_candidate_identity",
  "qualification_attempt_identity",
  "fresh_request_nonce",
  "trusted_observed_and_expiry_time",
  "platform_signer_key_identity_and_signature",
  "monotonic_acceptance_checkpoint_identity",
] as const);

export type ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1;
  policyReference: string;
  live130ProductCommit: "339c2e8a61e7c2ac0a40fc6f51711a512badbf6c";
  live130ProductTree: "06b57cdcec6f139a407d1475e3171ce3798ad64d";
  acceptedPhysicalDriverCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6";
  intendedPlatformFamily: "macos";
  supportedArchitectureClasses: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1;
  runtimeFamily: "node";
  minimumRuntimeVersion: "22.13.0";
  networkRole: "private_loopback_qualification_host";
  bindingScope: "single_boot_single_process_single_candidate_single_attempt";
  maximumFutureAttestationLifetimeSeconds: 60;
  requiredPrivateClaims: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1;
  publicPrivacyMode: "fixed_enums_booleans_zero_counts_public_repository_digests_only";
  requiresFreshNonce: true;
  requiresTrustedClock: true;
  requiresPlatformSigner: true;
  requiresIndependentCheckpoint: true;
  forbidsRawOrGuessableHostIdentity: true;
  repositoryFakeHostObservationAllowed: false;
  realProviderImplemented: false;
  realVerifierImplemented: false;
  clearsTargetRuntimeAttestationBlocker: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1 = Readonly<{
  resultVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1;
  resultReference: string;
  policyReference: string;
  contractDigest: string;
  evidenceClass: "repository_fake";
  intendedPlatformFamily: "macos";
  supportedArchitectureClasses: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1;
  runtimeFamily: "node";
  minimumRuntimeVersion: "22.13.0";
  bindingScope: "single_boot_single_process_single_candidate_single_attempt";
  requiredPrivateClaims: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1;
  hostObservationPerformed: false;
  rawHostIdentityPresent: false;
  stableHostTransformPresent: false;
  platformFamilyObserved: false;
  architectureObserved: false;
  runtimeVersionObserved: false;
  runtimeExecutableBound: false;
  bootEpochBound: false;
  processSessionEpochBound: false;
  qualificationHarnessBound: false;
  acceptedPhysicalDriverBound: false;
  qualificationCandidateBound: false;
  qualificationAttemptBound: false;
  freshNonceConsumed: false;
  trustedClockPresent: false;
  platformSignerPresent: false;
  independentCheckpointPresent: false;
  realAttestationEnvelopePresent: false;
  realAttestationVerified: false;
  durableAcceptanceRecorded: false;
  targetRuntimeAttestationAccepted: false;
  targetRuntimeAttestationMissing: true;
  clearsTargetRuntimeAttestationBlocker: false;
  activationEligible: false;
  hostObservationAttempts: 0;
  platformSignerCalls: 0;
  nativeBackendConstructions: 0;
  listenerAttemptsMade: 0;
  ipcListenerAttemptsMade: 0;
  socketAttemptsMade: 0;
  portSelectionsMade: 0;
  networkIoEventsObserved: 0;
  protectedValuesRead: 0;
  externalEffectOccurred: false;
  runtimeWired: false;
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

export class ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_result" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_result" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const resultRecordsV1 = new WeakSet<object>();
const resultDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_contract" | "invalid_result" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "target runtime attestation record"); }
  catch { failV1("integrity_failed"); }
}

const policySeedV1 = sha256Digest({
  live130ProductCommit: "339c2e8a61e7c2ac0a40fc6f51711a512badbf6c",
  acceptedPhysicalDriverCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6",
  intendedPlatformFamily: "macos",
  supportedArchitectureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1,
  runtimeFamily: "node",
  minimumRuntimeVersion: "22.13.0",
  requiredPrivateClaims: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_CONTRACT_V1,
  policyReference: `target-runtime-policy:${reflectApplyV1(stringSliceV1, policySeedV1, [7, 31])}`,
  live130ProductCommit: "339c2e8a61e7c2ac0a40fc6f51711a512badbf6c" as const,
  live130ProductTree: "06b57cdcec6f139a407d1475e3171ce3798ad64d" as const,
  acceptedPhysicalDriverCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6" as const,
  intendedPlatformFamily: "macos" as const,
  supportedArchitectureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1,
  runtimeFamily: "node" as const,
  minimumRuntimeVersion: "22.13.0" as const,
  networkRole: "private_loopback_qualification_host" as const,
  bindingScope: "single_boot_single_process_single_candidate_single_attempt" as const,
  maximumFutureAttestationLifetimeSeconds: 60 as const,
  requiredPrivateClaims: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1,
  publicPrivacyMode: "fixed_enums_booleans_zero_counts_public_repository_digests_only" as const,
  requiresFreshNonce: true as const,
  requiresTrustedClock: true as const,
  requiresPlatformSigner: true as const,
  requiresIndependentCheckpoint: true as const,
  forbidsRawOrGuessableHostIdentity: true as const,
  repositoryFakeHostObservationAllowed: false as const,
  realProviderImplemented: false as const,
  realVerifierImplemented: false as const,
  clearsTargetRuntimeAttestationBlocker: false as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1;
reflectApplyV1(weakSetAddV1, contractRecordsV1, [connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1, [
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.contractDigest,
]);

const resultMaterialV1 = {
  resultVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ATTESTATION_RESULT_V1,
  resultReference: `target-runtime-fake:${reflectApplyV1(stringSliceV1,
    connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.contractDigest, [7, 31])}`,
  policyReference: connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.policyReference,
  contractDigest: connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.contractDigest,
  evidenceClass: "repository_fake" as const,
  intendedPlatformFamily: "macos" as const,
  supportedArchitectureClasses: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1,
  runtimeFamily: "node" as const,
  minimumRuntimeVersion: "22.13.0" as const,
  bindingScope: "single_boot_single_process_single_candidate_single_attempt" as const,
  requiredPrivateClaims: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1,
  hostObservationPerformed: false as const,
  rawHostIdentityPresent: false as const,
  stableHostTransformPresent: false as const,
  platformFamilyObserved: false as const,
  architectureObserved: false as const,
  runtimeVersionObserved: false as const,
  runtimeExecutableBound: false as const,
  bootEpochBound: false as const,
  processSessionEpochBound: false as const,
  qualificationHarnessBound: false as const,
  acceptedPhysicalDriverBound: false as const,
  qualificationCandidateBound: false as const,
  qualificationAttemptBound: false as const,
  freshNonceConsumed: false as const,
  trustedClockPresent: false as const,
  platformSignerPresent: false as const,
  independentCheckpointPresent: false as const,
  realAttestationEnvelopePresent: false as const,
  realAttestationVerified: false as const,
  durableAcceptanceRecorded: false as const,
  targetRuntimeAttestationAccepted: false as const,
  targetRuntimeAttestationMissing: true as const,
  clearsTargetRuntimeAttestationBlocker: false as const,
  activationEligible: false as const,
  hostObservationAttempts: 0 as const,
  platformSignerCalls: 0 as const,
  nativeBackendConstructions: 0 as const,
  listenerAttemptsMade: 0 as const,
  ipcListenerAttemptsMade: 0 as const,
  socketAttemptsMade: 0 as const,
  portSelectionsMade: 0 as const,
  networkIoEventsObserved: 0 as const,
  protectedValuesRead: 0 as const,
  externalEffectOccurred: false as const,
  runtimeWired: false as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(resultMaterialV1);
export const connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1 = objectFreezeV1({
  ...resultMaterialV1,
  resultDigest: sha256Digest(resultMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1;
reflectApplyV1(weakSetAddV1, resultRecordsV1, [
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1,
]);
reflectApplyV1(weakMapSetV1, resultDigestsV1, [
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1,
  connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1.resultDigest,
]);

export function parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "policyReference", "live130ProductCommit", "live130ProductTree",
    "acceptedPhysicalDriverCommit", "intendedPlatformFamily", "supportedArchitectureClasses", "runtimeFamily",
    "minimumRuntimeVersion", "networkRole", "bindingScope", "maximumFutureAttestationLifetimeSeconds",
    "requiredPrivateClaims", "publicPrivacyMode", "requiresFreshNonce", "requiresTrustedClock",
    "requiresPlatformSigner", "requiresIndependentCheckpoint", "forbidsRawOrGuessableHostIdentity",
    "repositoryFakeHostObservationAllowed", "realProviderImplemented", "realVerifierImplemented",
    "clearsTargetRuntimeAttestationBlocker", "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "contractDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1
    || record.supportedArchitectureClasses !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1
    || record.requiredPrivateClaims !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1
    || record.repositoryFakeHostObservationAllowed || record.realProviderImplemented || record.realVerifierImplemented
    || record.clearsTargetRuntimeAttestationBlocker || record.grantsApproval || record.grantsNetworkAuthority
    || record.grantsCommandAuthority || record.grantsLeaseAuthority || record.grantsExecutionAuthority) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, resultRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_result");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1;
  const captured = exactHostDataSnapshotV1(record, [
    "resultVersion", "resultReference", "policyReference", "contractDigest", "evidenceClass",
    "intendedPlatformFamily", "supportedArchitectureClasses", "runtimeFamily", "minimumRuntimeVersion",
    "bindingScope", "requiredPrivateClaims", "hostObservationPerformed", "rawHostIdentityPresent",
    "stableHostTransformPresent", "platformFamilyObserved", "architectureObserved", "runtimeVersionObserved",
    "runtimeExecutableBound", "bootEpochBound", "processSessionEpochBound", "qualificationHarnessBound",
    "acceptedPhysicalDriverBound", "qualificationCandidateBound", "qualificationAttemptBound",
    "freshNonceConsumed", "trustedClockPresent", "platformSignerPresent", "independentCheckpointPresent",
    "realAttestationEnvelopePresent", "realAttestationVerified", "durableAcceptanceRecorded",
    "targetRuntimeAttestationAccepted", "targetRuntimeAttestationMissing", "clearsTargetRuntimeAttestationBlocker",
    "activationEligible", "hostObservationAttempts", "platformSignerCalls", "nativeBackendConstructions",
    "listenerAttemptsMade", "ipcListenerAttemptsMade", "socketAttemptsMade", "portSelectionsMade",
    "networkIoEventsObserved", "protectedValuesRead", "externalEffectOccurred", "runtimeWired", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "resultDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, resultDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.resultDigest
    || record !== connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationRepositoryFakeV1
    || record.contractDigest !== connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.contractDigest
    || record.policyReference !== connectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1.policyReference
    || record.supportedArchitectureClasses !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_ARCHITECTURES_V1
    || record.requiredPrivateClaims !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_TARGET_RUNTIME_PRIVATE_CLAIMS_V1
    || record.evidenceClass !== "repository_fake" || record.hostObservationPerformed
    || record.targetRuntimeAttestationAccepted || !record.targetRuntimeAttestationMissing
    || record.clearsTargetRuntimeAttestationBlocker || record.externalEffectOccurred || record.runtimeWired
    || record.nativeBackendConstructions !== 0 || record.listenerAttemptsMade !== 0
    || record.ipcListenerAttemptsMade !== 0 || record.socketAttemptsMade !== 0
    || record.networkIoEventsObserved !== 0 || record.protectedValuesRead !== 0) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationContractV1,
  parseConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationResultV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackTargetRuntimeAttestationErrorV1.prototype);
