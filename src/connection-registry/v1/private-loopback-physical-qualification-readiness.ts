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

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_READINESS_V1 =
  "control-room-connection-enrollment-private-loopback-physical-qualification-readiness/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1 = objectFreezeV1([
  "target_runtime_attestation_missing",
  "private_locator_broker_missing",
  "exclusive_port_custody_missing",
  "platform_evidence_signer_missing",
  "durable_attempt_ledger_missing",
  "independent_high_water_checkpoint_missing",
  "native_resource_observer_missing",
  "tunnel_peer_proof_missing",
  "accepted_host_key_custody_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1 = objectFreezeV1([
  "source_implementation_accepted",
  "prerequisite_contract_accepted",
  "private_providers_accepted",
  "qualification_candidate_assembled",
  "fresh_owner_authorization_consumed",
  "physical_qualification_observed",
  "independent_evidence_accepted",
  "runtime_activation_approved",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1 = objectFreezeV1({
  maximumNativeBackendConstructions: 1 as const,
  maximumListenerAttempts: 1 as const,
  maximumPrivateLocatorCapabilitySpends: 1 as const,
  maximumAdmittedConnections: 1 as const,
  maximumProtectedFrames: 1 as const,
  maximumCloseDrainSequences: 1 as const,
  maximumRecoveryObservations: 1 as const,
  maximumAutomaticRetries: 0 as const,
});

export type ConnectionEnrollmentPrivateLoopbackPhysicalQualificationBlockerV1 =
  typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1[number];

export type ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_READINESS_V1;
  readinessReference: string;
  integrationCommit: "19a87163c9210730140ec0d769c2effa6bbb5e1b";
  remediationCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6";
  remediationTree: "720682ab8ee8d4fe14f63601e72ac5776fa8183a";
  rejectedTarget: "959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38";
  negativeReviewSha256: "sha256:baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66";
  acceptedReviewSha256: "sha256:420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c";
  sourceImplementationAccepted: true;
  independentSourceReviewAccepted: true;
  prerequisiteContractAccepted: true;
  stageOrder: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1;
  blockerCodes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1;
  targetRuntimeAttested: false;
  privateLocatorBrokerAccepted: false;
  exclusivePortCustodyProven: false;
  platformEvidenceSignerAccepted: false;
  durableAttemptLedgerAccepted: false;
  independentHighWaterCheckpointAccepted: false;
  nativeResourceObserverAccepted: false;
  tunnelPeerProofAccepted: false;
  hostKeyCustodyProofAccepted: false;
  freshOwnerAuthorizationPresent: false;
  qualificationCandidateAssembled: false;
  physicalQualificationAccepted: false;
  independentPhysicalEvidenceAccepted: false;
  runtimeActivationApproved: false;
  activationEligible: false;
  futureCallCeilings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1;
  nativeBackendConstructions: 0;
  bindCapabilitiesIssued: 0;
  connectionAdmissionsIssued: 0;
  listenerAttemptsMade: 0;
  socketAttemptsMade: 0;
  networkIoEventsObserved: 0;
  externalEffectOccurred: false;
  automaticRetryAllowed: false;
  runtimeWired: false;
  status: "blocked_missing_private_qualification_prerequisites";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  readinessDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1 extends Error {
  readonly safeCode: "invalid_readiness" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_readiness" ? "invalid_readiness" : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const readinessRecordsV1 = new WeakSet<object>();
const readinessDigestsV1 = new WeakMap<object, string>();

function failV1(code: "invalid_readiness" | "integrity_failed"): never {
  throw new ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "physical qualification readiness"); }
  catch { failV1("integrity_failed"); }
}

const referenceSeedV1 = sha256Digest({
  integrationCommit: "19a87163c9210730140ec0d769c2effa6bbb5e1b",
  remediationCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6",
  acceptedReviewSha256: "sha256:420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c",
  blockerCodes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1,
});

const readinessMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_READINESS_V1,
  readinessReference: `physical-qualification-readiness:${reflectApplyV1(stringSliceV1, referenceSeedV1, [7, 31])}`,
  integrationCommit: "19a87163c9210730140ec0d769c2effa6bbb5e1b" as const,
  remediationCommit: "5a579342b7a03bb013de21663c69a3a6118e11c6" as const,
  remediationTree: "720682ab8ee8d4fe14f63601e72ac5776fa8183a" as const,
  rejectedTarget: "959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38" as const,
  negativeReviewSha256:
    "sha256:baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66" as const,
  acceptedReviewSha256:
    "sha256:420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c" as const,
  sourceImplementationAccepted: true as const,
  independentSourceReviewAccepted: true as const,
  prerequisiteContractAccepted: true as const,
  stageOrder: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1,
  blockerCodes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1,
  targetRuntimeAttested: false as const,
  privateLocatorBrokerAccepted: false as const,
  exclusivePortCustodyProven: false as const,
  platformEvidenceSignerAccepted: false as const,
  durableAttemptLedgerAccepted: false as const,
  independentHighWaterCheckpointAccepted: false as const,
  nativeResourceObserverAccepted: false as const,
  tunnelPeerProofAccepted: false as const,
  hostKeyCustodyProofAccepted: false as const,
  freshOwnerAuthorizationPresent: false as const,
  qualificationCandidateAssembled: false as const,
  physicalQualificationAccepted: false as const,
  independentPhysicalEvidenceAccepted: false as const,
  runtimeActivationApproved: false as const,
  activationEligible: false as const,
  futureCallCeilings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1,
  nativeBackendConstructions: 0 as const,
  bindCapabilitiesIssued: 0 as const,
  connectionAdmissionsIssued: 0 as const,
  listenerAttemptsMade: 0 as const,
  socketAttemptsMade: 0 as const,
  networkIoEventsObserved: 0 as const,
  externalEffectOccurred: false as const,
  automaticRetryAllowed: false as const,
  runtimeWired: false as const,
  status: "blocked_missing_private_qualification_prerequisites" as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(readinessMaterialV1);
export const connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1 = objectFreezeV1({
  ...readinessMaterialV1,
  readinessDigest: sha256Digest(readinessMaterialV1),
}) as ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
reflectApplyV1(weakSetAddV1, readinessRecordsV1, [
  connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
]);
reflectApplyV1(weakMapSetV1, readinessDigestsV1, [
  connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
  connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1.readinessDigest,
]);

export function parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, readinessRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_readiness");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "readinessReference", "integrationCommit", "remediationCommit", "remediationTree",
    "rejectedTarget", "negativeReviewSha256", "acceptedReviewSha256", "sourceImplementationAccepted",
    "independentSourceReviewAccepted", "prerequisiteContractAccepted", "stageOrder", "blockerCodes",
    "targetRuntimeAttested", "privateLocatorBrokerAccepted", "exclusivePortCustodyProven",
    "platformEvidenceSignerAccepted", "durableAttemptLedgerAccepted", "independentHighWaterCheckpointAccepted",
    "nativeResourceObserverAccepted", "tunnelPeerProofAccepted", "hostKeyCustodyProofAccepted",
    "freshOwnerAuthorizationPresent", "qualificationCandidateAssembled", "physicalQualificationAccepted",
    "independentPhysicalEvidenceAccepted", "runtimeActivationApproved", "activationEligible", "futureCallCeilings",
    "nativeBackendConstructions", "bindCapabilitiesIssued", "connectionAdmissionsIssued", "listenerAttemptsMade",
    "socketAttemptsMade", "networkIoEventsObserved", "externalEffectOccurred", "automaticRetryAllowed",
    "runtimeWired", "status", "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority",
    "grantsLeaseAuthority", "grantsExecutionAuthority", "readinessDigest",
  ]);
  const privateDigest = reflectApplyV1(weakMapGetV1, readinessDigestsV1, [record]) as string | undefined;
  if (!captured || privateDigest !== record.readinessDigest
    || record !== connectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1
    || record.stageOrder !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_STAGES_V1
    || record.blockerCodes !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_BLOCKERS_V1
    || record.futureCallCeilings !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_FUTURE_CEILINGS_V1
    || record.activationEligible || record.runtimeWired || record.externalEffectOccurred
    || record.nativeBackendConstructions !== 0 || record.listenerAttemptsMade !== 0
    || record.socketAttemptsMade !== 0 || record.networkIoEventsObserved !== 0) {
    failV1("integrity_failed");
  }
  safePublicRecordV1(record);
  return record;
}

for (const exportedCallableV1 of [
  ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1,
  parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessV1,
]) objectFreezeV1(exportedCallableV1);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackPhysicalQualificationReadinessErrorV1.prototype);
