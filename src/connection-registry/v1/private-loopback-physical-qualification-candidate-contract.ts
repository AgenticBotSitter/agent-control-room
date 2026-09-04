import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";

const objectFreezeV1 = Object.freeze;
const objectIsFrozenV1 = Object.isFrozen;
const objectEntriesV1 = Object.entries;
const reflectApplyV1 = Reflect.apply;
const stringSliceV1 = String.prototype.slice;
const weakMapGetV1 = WeakMap.prototype.get;
const weakMapSetV1 = WeakMap.prototype.set;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-physical-qualification-candidate-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STATUS_V1 =
  "control-room-connection-enrollment-private-loopback-physical-qualification-candidate-status/v1" as const;

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1 = objectFreezeV1([
  "accepted_physical_native_driver_and_native_issuer",
  "accepted_live270_private_composition_shell",
  "real_target_runtime_attestation",
  "private_literal_loopback_locator_broker",
  "exclusive_operating_system_port_reservation_and_custody",
  "one_use_retained_resource_handoff_capability",
  "exact_private_native_retained_resource_adapter",
  "platform_evidence_signer_and_trusted_clock",
  "durable_attempt_claim_spend_uncertainty_result_and_tombstone_ledger",
  "independently_held_high_water_checkpoint",
  "independent_native_resource_and_cleanup_observer",
  "authenticated_tunnel_peer_proof_and_accepted_host_key_custody",
  "exact_candidate_attempt_connection_tenant_node_route_server_and_provider_epochs",
  "fixed_ceilings_deadlines_cleanup_no_reopen_and_sanitation_policy",
  "separate_fresh_owner_authorization_reference",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1 = objectFreezeV1([
  "accepted_repository_source_and_reviews",
  "effect_free_candidate_contract",
  "accepted_real_private_providers_and_durable_stores",
  "private_candidate_assembler",
  "inert_assembled_candidate",
  "fresh_one_use_owner_authorization",
  "single_owner_attended_physical_attempt",
  "sanitized_result_and_independent_absence_observation",
  "different_independent_evidence_review",
  "separate_runtime_activation_decision",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1 = objectFreezeV1([
  "real_target_runtime_attestation_missing",
  "private_locator_broker_missing",
  "exclusive_port_custody_missing",
  "platform_evidence_signer_missing",
  "durable_attempt_ledger_missing",
  "independent_high_water_checkpoint_missing",
  "native_resource_observer_missing",
  "tunnel_peer_proof_missing",
  "accepted_host_key_custody_missing",
  "private_candidate_assembler_missing",
  "fresh_owner_authorization_missing",
  "physical_qualification_missing",
  "independent_qualification_review_missing",
  "runtime_activation_approval_missing",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1 = objectFreezeV1([
  "owner_authorization_spends",
  "candidate_assembler_entries",
  "private_shell_retrievals",
  "private_shell_entries",
  "private_bridge_consumptions",
  "private_factory_lookups",
  "private_factory_receipts",
  "private_factory_invocations",
  "native_backend_constructions",
  "listener_attempts",
  "locator_capability_spends",
  "locator_observations",
  "authenticated_connection_admissions",
  "protected_frames",
  "adapter_acceptances",
  "ownership_transfers",
  "close_drain_sequences",
  "independent_absence_observations",
  "terminal_results",
  "tombstones",
  "high_water_checkpoints",
] as const);

export type ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CONTRACT_V1;
  contractReference: string;
  live270ProductCommit: "5e5384b1c7b3806a62672018843aa318b0e75728";
  acceptedLive270ReviewSha256: "96edcc2c9c65ea38b3da1adec7c092fdf056e544f02856705e93ce0f19d79609";
  components: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1;
  stages: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1;
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1;
  oneAttemptCeilings: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1;
  maximumPerCeiling: 1;
  automaticRetryAllowed: false;
  retryAfterUncertaintyAllowed: false;
  replacementResourceAllowed: false;
  reopenAllowed: false;
  publicCandidateAssemblyAllowed: false;
  repositoryFakeSatisfiesRealComponent: false;
  callerReadinessAssertionAllowed: false;
  repositorySourceAccepted: true;
  candidateContractImplementationPresent: true;
  candidateContractSelfAccepted: false;
  realPrerequisitesAccepted: false;
  privateCandidateAssemblerImplemented: false;
  candidateAssembled: false;
  ownerAuthorizationPresent: false;
  physicalAttemptPerformed: false;
  physicalQualificationAccepted: false;
  runtimeWired: false;
  activationEligible: false;
  repositoryContractOnly: true;
  grantsApproval: false;
  grantsQualificationAuthority: false;
  grantsCandidateAuthority: false;
  grantsActivationAuthority: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1 = Readonly<{
  statusVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STATUS_V1;
  contractReference: string;
  contractDigest: string;
  evidenceClass: "repository_contract_non_execution";
  blockers: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1;
  sourceState: "accepted_repository_source";
  prerequisiteState: "real_prerequisites_missing";
  candidateState: "not_assembled";
  ownerAuthorizationState: "not_present";
  physicalAttemptState: "not_attempted";
  qualificationState: "not_accepted";
  runtimeState: "not_wired";
  actualHostObservations: 0;
  actualProviderCalls: 0;
  actualSignerCalls: 0;
  actualLedgerWrites: 0;
  actualCheckpointWrites: 0;
  actualCandidateAssemblerEntries: 0;
  actualOwnerAuthorizationSpends: 0;
  actualPrivateShellRetrievals: 0;
  actualPrivateShellEntries: 0;
  actualPrivateBridgeConsumptions: 0;
  actualPrivateFactoryLookups: 0;
  actualPrivateFactoryReceipts: 0;
  actualPrivateFactoryInvocations: 0;
  actualNativeBackendConstructions: 0;
  actualNativeResourcesCreated: 0;
  actualNativeResourcesRetained: 0;
  actualListenerAttempts: 0;
  actualLocatorCapabilitySpends: 0;
  actualLocatorObservations: 0;
  actualAuthenticatedConnectionAdmissions: 0;
  actualProtectedFrames: 0;
  actualAdapterAcceptances: 0;
  actualOwnershipTransfers: 0;
  actualCloseDrainSequences: 0;
  actualIndependentAbsenceObservations: 0;
  actualTerminalResults: 0;
  actualTombstones: 0;
  actualPersistenceWrites: 0;
  actualTimerCreations: 0;
  actualNetworkIoEvents: 0;
  actualProtectedValuesRead: 0;
  externalEffectOccurred: false;
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

export class ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1 extends Error {
  readonly safeCode: "invalid_contract" | "invalid_status" | "candidate_unavailable" | "integrity_failed";

  constructor(code: unknown) {
    const safeCode = code === "invalid_contract" || code === "invalid_status" || code === "candidate_unavailable"
      || code === "integrity_failed" ? code : "integrity_failed";
    super(safeCode);
    this.safeCode = safeCode;
    this.name = "ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1";
    this.stack = undefined;
    objectFreezeV1(this);
  }
}

const contractRecordsV1 = new WeakSet<object>();
const contractDigestsV1 = new WeakMap<object, string>();
const statusRecordsV1 = new WeakSet<object>();
const statusDigestsV1 = new WeakMap<object, string>();

function failV1(code: ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1["safeCode"]): never {
  throw new ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1(code);
}

function safePublicRecordV1(value: unknown): void {
  try { assertNoSecretMaterial(value, "physical qualification candidate record"); }
  catch { failV1("integrity_failed"); }
}

const contractSeedV1 = sha256Digest({
  live270ProductCommit: "5e5384b1c7b3806a62672018843aa318b0e75728",
  acceptedLive270ReviewSha256: "96edcc2c9c65ea38b3da1adec7c092fdf056e544f02856705e93ce0f19d79609",
  components: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1,
  oneAttemptCeilings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1,
});

const contractMaterialV1 = {
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CONTRACT_V1,
  contractReference: `physical-qualification-candidate:${reflectApplyV1(stringSliceV1, contractSeedV1, [7, 31])}`,
  live270ProductCommit: "5e5384b1c7b3806a62672018843aa318b0e75728" as const,
  acceptedLive270ReviewSha256: "96edcc2c9c65ea38b3da1adec7c092fdf056e544f02856705e93ce0f19d79609" as const,
  components: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1,
  stages: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1,
  oneAttemptCeilings: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1,
  maximumPerCeiling: 1 as const,
  automaticRetryAllowed: false as const,
  retryAfterUncertaintyAllowed: false as const,
  replacementResourceAllowed: false as const,
  reopenAllowed: false as const,
  publicCandidateAssemblyAllowed: false as const,
  repositoryFakeSatisfiesRealComponent: false as const,
  callerReadinessAssertionAllowed: false as const,
  repositorySourceAccepted: true as const,
  candidateContractImplementationPresent: true as const,
  candidateContractSelfAccepted: false as const,
  realPrerequisitesAccepted: false as const,
  privateCandidateAssemblerImplemented: false as const,
  candidateAssembled: false as const,
  ownerAuthorizationPresent: false as const,
  physicalAttemptPerformed: false as const,
  physicalQualificationAccepted: false as const,
  runtimeWired: false as const,
  activationEligible: false as const,
  repositoryContractOnly: true as const,
  grantsApproval: false as const,
  grantsQualificationAuthority: false as const,
  grantsCandidateAuthority: false as const,
  grantsActivationAuthority: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
};

safePublicRecordV1(contractMaterialV1);
export const connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1 = objectFreezeV1({
  ...contractMaterialV1,
  contractDigest: sha256Digest(contractMaterialV1),
});
reflectApplyV1(weakSetAddV1, contractRecordsV1,
  [connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1]);
reflectApplyV1(weakMapSetV1, contractDigestsV1,
  [connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1,
    connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1.contractDigest]);

const statusMaterialV1 = {
  statusVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STATUS_V1,
  contractReference: connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1.contractReference,
  contractDigest: connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1.contractDigest,
  evidenceClass: "repository_contract_non_execution" as const,
  blockers: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1,
  sourceState: "accepted_repository_source" as const,
  prerequisiteState: "real_prerequisites_missing" as const,
  candidateState: "not_assembled" as const,
  ownerAuthorizationState: "not_present" as const,
  physicalAttemptState: "not_attempted" as const,
  qualificationState: "not_accepted" as const,
  runtimeState: "not_wired" as const,
  actualHostObservations: 0 as const,
  actualProviderCalls: 0 as const,
  actualSignerCalls: 0 as const,
  actualLedgerWrites: 0 as const,
  actualCheckpointWrites: 0 as const,
  actualCandidateAssemblerEntries: 0 as const,
  actualOwnerAuthorizationSpends: 0 as const,
  actualPrivateShellRetrievals: 0 as const,
  actualPrivateShellEntries: 0 as const,
  actualPrivateBridgeConsumptions: 0 as const,
  actualPrivateFactoryLookups: 0 as const,
  actualPrivateFactoryReceipts: 0 as const,
  actualPrivateFactoryInvocations: 0 as const,
  actualNativeBackendConstructions: 0 as const,
  actualNativeResourcesCreated: 0 as const,
  actualNativeResourcesRetained: 0 as const,
  actualListenerAttempts: 0 as const,
  actualLocatorCapabilitySpends: 0 as const,
  actualLocatorObservations: 0 as const,
  actualAuthenticatedConnectionAdmissions: 0 as const,
  actualProtectedFrames: 0 as const,
  actualAdapterAcceptances: 0 as const,
  actualOwnershipTransfers: 0 as const,
  actualCloseDrainSequences: 0 as const,
  actualIndependentAbsenceObservations: 0 as const,
  actualTerminalResults: 0 as const,
  actualTombstones: 0 as const,
  actualPersistenceWrites: 0 as const,
  actualTimerCreations: 0 as const,
  actualNetworkIoEvents: 0 as const,
  actualProtectedValuesRead: 0 as const,
  externalEffectOccurred: false as const,
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
export const connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1 = objectFreezeV1({
  ...statusMaterialV1,
  statusDigest: sha256Digest(statusMaterialV1),
});
reflectApplyV1(weakSetAddV1, statusRecordsV1,
  [connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1]);
reflectApplyV1(weakMapSetV1, statusDigestsV1,
  [connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
    connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1.statusDigest]);

export function parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, contractRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_contract");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1;
  const captured = exactHostDataSnapshotV1(record, [
    "contractVersion", "contractReference", "live270ProductCommit", "acceptedLive270ReviewSha256", "components",
    "stages", "blockers", "oneAttemptCeilings", "maximumPerCeiling", "automaticRetryAllowed",
    "retryAfterUncertaintyAllowed", "replacementResourceAllowed", "reopenAllowed", "publicCandidateAssemblyAllowed",
    "repositoryFakeSatisfiesRealComponent", "callerReadinessAssertionAllowed", "repositorySourceAccepted",
    "candidateContractImplementationPresent", "candidateContractSelfAccepted", "realPrerequisitesAccepted",
    "privateCandidateAssemblerImplemented", "candidateAssembled", "ownerAuthorizationPresent",
    "physicalAttemptPerformed", "physicalQualificationAccepted", "runtimeWired", "activationEligible",
    "repositoryContractOnly", "grantsApproval", "grantsQualificationAuthority", "grantsCandidateAuthority",
    "grantsActivationAuthority", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
    "grantsExecutionAuthority", "contractDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, contractDigestsV1, [record]) as string | undefined;
  if (!captured || digest !== record.contractDigest
    || record !== connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1
    || record.components !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_COMPONENTS_V1
    || record.stages !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_STAGES_V1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1
    || record.oneAttemptCeilings !==
      CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_CEILINGS_V1
    || record.maximumPerCeiling !== 1 || record.automaticRetryAllowed || record.retryAfterUncertaintyAllowed
    || record.replacementResourceAllowed || record.reopenAllowed || record.publicCandidateAssemblyAllowed
    || record.repositoryFakeSatisfiesRealComponent || record.callerReadinessAssertionAllowed
    || !record.repositorySourceAccepted || !record.candidateContractImplementationPresent
    || record.candidateContractSelfAccepted || record.realPrerequisitesAccepted
    || record.privateCandidateAssemblerImplemented || record.candidateAssembled || record.ownerAuthorizationPresent
    || record.physicalAttemptPerformed || record.physicalQualificationAccepted || record.runtimeWired
    || record.activationEligible || !record.repositoryContractOnly) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1(
  value: unknown,
): ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1 {
  if (value === null || typeof value !== "object" || isHostProxyV1(value)
    || reflectApplyV1(weakSetHasV1, statusRecordsV1, [value]) !== true || !objectIsFrozenV1(value)) {
    failV1("invalid_status");
  }
  const record = value as ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1;
  const captured = exactHostDataSnapshotV1(record, [
    "statusVersion", "contractReference", "contractDigest", "evidenceClass", "blockers", "sourceState",
    "prerequisiteState", "candidateState", "ownerAuthorizationState", "physicalAttemptState",
    "qualificationState", "runtimeState", "actualHostObservations", "actualProviderCalls", "actualSignerCalls",
    "actualLedgerWrites", "actualCheckpointWrites", "actualCandidateAssemblerEntries",
    "actualOwnerAuthorizationSpends", "actualPrivateShellRetrievals", "actualPrivateShellEntries",
    "actualPrivateBridgeConsumptions", "actualPrivateFactoryLookups", "actualPrivateFactoryReceipts",
    "actualPrivateFactoryInvocations", "actualNativeBackendConstructions", "actualNativeResourcesCreated",
    "actualNativeResourcesRetained", "actualListenerAttempts", "actualLocatorCapabilitySpends",
    "actualLocatorObservations", "actualAuthenticatedConnectionAdmissions", "actualProtectedFrames",
    "actualAdapterAcceptances", "actualOwnershipTransfers", "actualCloseDrainSequences",
    "actualIndependentAbsenceObservations", "actualTerminalResults", "actualTombstones",
    "actualPersistenceWrites", "actualTimerCreations", "actualNetworkIoEvents", "actualProtectedValuesRead",
    "externalEffectOccurred", "candidateEligible", "activationEligible", "grantsApproval",
    "grantsQualificationAuthority", "grantsCandidateAuthority", "grantsActivationAuthority",
    "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
    "statusDigest",
  ]);
  const digest = reflectApplyV1(weakMapGetV1, statusDigestsV1, [record]) as string | undefined;
  const entries = captured
    ? reflectApplyV1(objectEntriesV1, undefined, [captured]) as Array<[string, unknown]> : [];
  const actualValues = entries.filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grantValues = entries.filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  if (!captured || digest !== record.statusDigest
    || record !== connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1
    || record.blockers !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_PHYSICAL_QUALIFICATION_CANDIDATE_BLOCKERS_V1
    || actualValues.length !== 31 || actualValues.some((value) => value !== 0)
    || grantValues.length !== 8 || grantValues.some((value) => value !== false)
    || record.externalEffectOccurred || record.candidateEligible || record.activationEligible) failV1("integrity_failed");
  safePublicRecordV1(record);
  return record;
}

export function assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1():
ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1 {
  return parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1(
    connectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1,
  );
}

objectFreezeV1(ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1.prototype);
objectFreezeV1(ConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateErrorV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateContractV1);
objectFreezeV1(parseConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateStatusV1);
objectFreezeV1(assessConnectionEnrollmentPrivateLoopbackPhysicalQualificationCandidateV1);
