import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { NODE_PROTOCOL_MAX_FRAME_BYTES } from "../../node-protocol/v1";
import {
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
} from "../../security/host-value";
import { assertConnectionEnrollmentNodeIngressRuntimeV1 } from "./node-ingress";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
  parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
  type ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1,
} from "./private-loopback-native-listener-adapter";
import {
  parseConnectionEnrollmentPrivateLoopbackListenerPlanV1,
  type ConnectionEnrollmentPrivateLoopbackListenerPlanV1,
} from "./private-loopback-listener-lifecycle";

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1 =
  "control-room-connection-enrollment-private-loopback-native-driver-contract/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1 =
  "control-room-connection-enrollment-private-loopback-native-driver-rehearsal/v1" as const;
export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1 =
  "control-room-connection-enrollment-private-loopback-native-activation-evidence/v1" as const;

const objectFreezeV1 = Object.freeze;
const objectGetPrototypeOfV1 = Object.getPrototypeOf;
const objectIsFrozenV1 = Object.isFrozen;
const numberIsSafeIntegerV1 = Number.isSafeInteger;
const reflectApplyV1 = Reflect.apply;
const regexpExecV1 = RegExp.prototype.exec;
const stringSliceV1 = String.prototype.slice;
const weakSetAddV1 = WeakSet.prototype.add;
const weakSetHasV1 = WeakSet.prototype.has;
const digestPatternV1 = /^sha256:[a-f0-9]{64}$/;
const driverReferencePatternV1 = /^native-driver-contract:[a-f0-9]{24}$/;
const rehearsalReferencePatternV1 = /^native-driver-rehearsal:[a-f0-9]{24}$/;
const evidenceReferencePatternV1 = /^native-activation-evidence:[a-f0-9]{24}$/;
const listenerReferencePatternV1 = /^native-listener:[a-f0-9]{24}$/;
const nativeDriverContractsV1 = new WeakSet<object>();
const nativeDriverRehearsalsV1 = new WeakSet<object>();
const nativeActivationEvidenceRecordsV1 = new WeakSet<object>();
const repositoryFakeNativeDriversV1 = new WeakSet<object>();

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1 = objectFreezeV1([
  "prepare",
  "start",
  "status",
  "close",
  "recover",
] as const);

export const CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1 = objectFreezeV1([
  "contract_loaded",
  "fake_prepare_simulated",
  "fake_start_simulated",
  "fake_capacity_and_deadlines_simulated",
  "fake_close_simulated",
  "fake_restart_recovery_simulated",
] as const);

const repositoryFakeDriverBehaviorDigestV1 = sha256Digest({
  contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1,
  driverMode: "injected_repository_fake",
  operations: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
  events: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1,
  nativeImplementationPresent: false,
  opensListener: false,
  performsNetworkIo: false,
});

export type ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1;
  driverReference: string;
  driverBehaviorDigest: string;
  listenerReference: string;
  listenerPlanDigest: string;
  disabledReadinessDigest: string;
  driverMode: "injected_repository_fake";
  operationSet: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1;
  bindPolicy: "literal_ipv4_loopback_only";
  portPolicy: "private_and_unpublished";
  maximumFrameBytes: number;
  maximumChunks: number;
  maximumConcurrentConnections: 1;
  maximumQueuedConnections: 0;
  maximumConnectionDurationMs: number;
  idleTimeoutMs: number;
  shutdownGraceMs: number;
  oneFramePerConnection: true;
  automaticRestartAllowed: false;
  requiresExclusivePortEvidence: true;
  requiresAuthenticatedTunnelPeer: true;
  requiresAcceptedHostKeyCustody: true;
  requiresConnectionDeadline: true;
  requiresIdleDeadline: true;
  requiresAdmissionDeadline: true;
  requiresBackpressure: true;
  requiresBoundedShutdownEvidence: true;
  requiresProcessRecoveryEvidence: true;
  nativeImplementationPresent: false;
  nativeDriverAccepted: false;
  activationInputAccepted: false;
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  contractDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1;
  rehearsalReference: string;
  driverReference: string;
  listenerReference: string;
  listenerPlanDigest: string;
  disabledReadinessDigest: string;
  driverContractDigest: string;
  driverBehaviorDigest: string;
  evidenceMode: "repository_fake";
  eventSequence: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1;
  disposition: "passed_repository_fake";
  operationSetMatched: true;
  literalLoopbackPolicySimulated: true;
  privatePortPolicySimulated: true;
  singleConnectionPolicySimulated: true;
  zeroQueuePolicySimulated: true;
  oneFramePolicySimulated: true;
  connectionDeadlineSimulated: true;
  idleDeadlineSimulated: true;
  admissionDeadlineSimulated: true;
  backpressureSimulated: true;
  boundedShutdownSimulated: true;
  processRecoverySimulated: true;
  listenerAttemptsMade: 0;
  networkIoEventsObserved: 0;
  externalEffectOccurred: false;
  nativeImplementationPresent: false;
  nativeDriverAccepted: false;
  activationEvidenceAccepted: false;
  candidateForIndependentContractReview: true;
  automaticallyActivatesListener: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  rehearsalDigest: string;
}>;

export type ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1 = Readonly<{
  contractVersion: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1;
  evidenceReference: string;
  listenerReference: string;
  listenerPlanDigest: string;
  disabledReadinessDigest: string;
  driverContractDigest: string;
  driverRehearsalDigest: string;
  evidenceMode: "repository_fake";
  driverContractRehearsalPassed: true;
  nativeDriverAccepted: false;
  ownerActivationAccepted: false;
  platformQualificationAccepted: false;
  exclusivePortOwnershipProven: false;
  tunnelPeerAuthenticated: false;
  hostKeyCustodyProven: false;
  connectionDeadlineProven: false;
  idleDeadlineProven: false;
  admissionDeadlineProven: false;
  backpressureProven: false;
  shutdownCleanupProven: false;
  processRecoveryProven: false;
  blockerCodes: typeof CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1;
  activationEligible: false;
  status: "blocked_repository_evidence_only";
  nativeAttempted: false;
  listenerOpened: false;
  listenerAttemptsMade: 0;
  networkIoEventsObserved: 0;
  externalEffectOccurred: false;
  automaticRetryAllowed: false;
  requiresIndependentReview: true;
  requiresFreshOwnerAuthorization: true;
  opensListener: false;
  performsNetworkIo: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  evidenceDigest: string;
}>;

export class ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_configuration" | "invalid_contract" | "invalid_driver" |
    "invalid_rehearsal" | "invalid_evidence" | "integrity_failed") {
    super(safeCode);
    this.name = "ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1";
  }
}

function patternMatchesV1(pattern: RegExp, value: string): boolean {
  return reflectApplyV1(regexpExecV1, pattern, [value]) !== null;
}

function weakSetContainsV1(set: WeakSet<object>, value: unknown): value is object {
  return value !== null && typeof value === "object" && reflectApplyV1(weakSetHasV1, set, [value]);
}

function assertRuntimeV1(code: ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1["safeCode"]): void {
  try { assertConnectionEnrollmentNodeIngressRuntimeV1(); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1(code); }
}

function parsePlanV1(value: unknown): ConnectionEnrollmentPrivateLoopbackListenerPlanV1 {
  try { return parseConnectionEnrollmentPrivateLoopbackListenerPlanV1(value); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_configuration"); }
}

function parseReadinessV1(value: unknown): ConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1 {
  try { return parseConnectionEnrollmentPrivateLoopbackNativeListenerReadinessV1(value); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_configuration"); }
}

function driverReferenceV1(planDigest: string, readinessDigest: string): string {
  const digest = sha256Digest({ planDigest, readinessDigest, repositoryFakeDriverBehaviorDigestV1 });
  return `native-driver-contract:${reflectApplyV1(stringSliceV1, digest, [7, 31])}`;
}

function rehearsalReferenceV1(contractDigest: string): string {
  return `native-driver-rehearsal:${reflectApplyV1(stringSliceV1, contractDigest, [7, 31])}`;
}

function evidenceReferenceV1(contractDigest: string, rehearsalDigest: string): string {
  const digest = sha256Digest({ contractDigest, rehearsalDigest });
  return `native-activation-evidence:${reflectApplyV1(stringSliceV1, digest, [7, 31])}`;
}

export function createConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(inputValue: unknown):
ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1 {
  assertRuntimeV1("invalid_configuration");
  const input = exactHostDataSnapshotV1(inputValue, ["plan", "readiness"]);
  if (!input) throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_configuration");
  const plan = parsePlanV1(input.plan);
  const readiness = parseReadinessV1(input.readiness);
  if (readiness.listenerPlanDigest !== plan.planDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_configuration");
  }
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1,
    driverReference: driverReferenceV1(plan.planDigest, readiness.readinessDigest),
    driverBehaviorDigest: repositoryFakeDriverBehaviorDigestV1,
    listenerReference: readiness.listenerReference,
    listenerPlanDigest: plan.planDigest,
    disabledReadinessDigest: readiness.readinessDigest,
    driverMode: "injected_repository_fake" as const,
    operationSet: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1,
    bindPolicy: "literal_ipv4_loopback_only" as const,
    portPolicy: "private_and_unpublished" as const,
    maximumFrameBytes: plan.maximumFrameBytes,
    maximumChunks: plan.maximumChunks,
    maximumConcurrentConnections: 1 as const,
    maximumQueuedConnections: 0 as const,
    maximumConnectionDurationMs: plan.maximumConnectionDurationMs,
    idleTimeoutMs: plan.idleTimeoutMs,
    shutdownGraceMs: plan.shutdownGraceMs,
    oneFramePerConnection: true as const,
    automaticRestartAllowed: false as const,
    requiresExclusivePortEvidence: true as const,
    requiresAuthenticatedTunnelPeer: true as const,
    requiresAcceptedHostKeyCustody: true as const,
    requiresConnectionDeadline: true as const,
    requiresIdleDeadline: true as const,
    requiresAdmissionDeadline: true as const,
    requiresBackpressure: true as const,
    requiresBoundedShutdownEvidence: true as const,
    requiresProcessRecoveryEvidence: true as const,
    nativeImplementationPresent: false as const,
    nativeDriverAccepted: false as const,
    activationInputAccepted: false as const,
    opensListener: false as const,
    performsNetworkIo: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  try { assertNoSecretMaterial(material, "private loopback native driver contract"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_configuration"); }
  const contract = objectFreezeV1({ ...material, contractDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, nativeDriverContractsV1, [contract]);
  return contract;
}

const contractKeysV1 = [
  "contractVersion", "driverReference", "driverBehaviorDigest", "listenerReference", "listenerPlanDigest",
  "disabledReadinessDigest", "driverMode", "operationSet", "bindPolicy", "portPolicy", "maximumFrameBytes",
  "maximumChunks", "maximumConcurrentConnections", "maximumQueuedConnections", "maximumConnectionDurationMs",
  "idleTimeoutMs", "shutdownGraceMs", "oneFramePerConnection", "automaticRestartAllowed",
  "requiresExclusivePortEvidence", "requiresAuthenticatedTunnelPeer", "requiresAcceptedHostKeyCustody",
  "requiresConnectionDeadline", "requiresIdleDeadline", "requiresAdmissionDeadline", "requiresBackpressure",
  "requiresBoundedShutdownEvidence", "requiresProcessRecoveryEvidence", "nativeImplementationPresent",
  "nativeDriverAccepted", "activationInputAccepted", "opensListener", "performsNetworkIo", "grantsApproval",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "contractDigest",
] as const;

export function parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1 {
  assertRuntimeV1("invalid_contract");
  if (!weakSetContainsV1(nativeDriverContractsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
  }
  const captured = exactHostDataSnapshotV1(value, contractKeysV1);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
  const operations = exactHostDataArrayV1(captured.operationSet,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1.length);
  if (!operations || !objectIsFrozenV1(captured.operationSet)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
  }
  for (let index = 0; index < CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1.length;
    index += 1) {
    if (operations[index] !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_OPERATIONS_V1[index]) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
    }
  }
  const contract = captured as unknown as ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  if (contract.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_CONTRACT_V1
    || !patternMatchesV1(driverReferencePatternV1, contract.driverReference)
    || !patternMatchesV1(digestPatternV1, contract.driverBehaviorDigest)
    || contract.driverBehaviorDigest !== repositoryFakeDriverBehaviorDigestV1
    || !patternMatchesV1(listenerReferencePatternV1, contract.listenerReference)
    || !patternMatchesV1(digestPatternV1, contract.listenerPlanDigest)
    || !patternMatchesV1(digestPatternV1, contract.disabledReadinessDigest)
    || contract.driverReference !== driverReferenceV1(contract.listenerPlanDigest, contract.disabledReadinessDigest)
    || contract.driverMode !== "injected_repository_fake"
    || contract.bindPolicy !== "literal_ipv4_loopback_only" || contract.portPolicy !== "private_and_unpublished"
    || !numberIsSafeIntegerV1(contract.maximumFrameBytes) || contract.maximumFrameBytes < 4_096
    || contract.maximumFrameBytes > NODE_PROTOCOL_MAX_FRAME_BYTES
    || !numberIsSafeIntegerV1(contract.maximumChunks) || contract.maximumChunks < 1
    || contract.maximumChunks > 4_096
    || !numberIsSafeIntegerV1(contract.maximumConnectionDurationMs) || contract.maximumConnectionDurationMs < 1_000
    || contract.maximumConnectionDurationMs > 300_000
    || !numberIsSafeIntegerV1(contract.idleTimeoutMs) || contract.idleTimeoutMs < 100
    || contract.idleTimeoutMs > contract.maximumConnectionDurationMs
    || !numberIsSafeIntegerV1(contract.shutdownGraceMs) || contract.shutdownGraceMs < 100
    || contract.shutdownGraceMs > 30_000 || contract.shutdownGraceMs > contract.maximumConnectionDurationMs
    || contract.maximumConcurrentConnections !== 1 || contract.maximumQueuedConnections !== 0
    || contract.oneFramePerConnection !== true || contract.automaticRestartAllowed !== false
    || contract.requiresExclusivePortEvidence !== true || contract.requiresAuthenticatedTunnelPeer !== true
    || contract.requiresAcceptedHostKeyCustody !== true || contract.requiresConnectionDeadline !== true
    || contract.requiresIdleDeadline !== true || contract.requiresAdmissionDeadline !== true
    || contract.requiresBackpressure !== true || contract.requiresBoundedShutdownEvidence !== true
    || contract.requiresProcessRecoveryEvidence !== true || contract.nativeImplementationPresent !== false
    || contract.nativeDriverAccepted !== false || contract.activationInputAccepted !== false
    || contract.opensListener !== false || contract.performsNetworkIo !== false || contract.grantsApproval !== false
    || contract.grantsNetworkAuthority !== false || contract.grantsCommandAuthority !== false
    || contract.grantsLeaseAuthority !== false || contract.grantsExecutionAuthority !== false
    || !patternMatchesV1(digestPatternV1, contract.contractDigest)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
  }
  const material: Record<string, unknown> = { ...captured, operationSet: operations };
  delete material.contractDigest;
  if (sha256Digest(material) !== contract.contractDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract");
  }
  try { assertNoSecretMaterial(material, "private loopback native driver contract"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_contract"); }
  return value as ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
}

function createRepositoryFakeRehearsalV1(contractValue: unknown):
ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1 {
  const contract = parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(contractValue);
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1,
    rehearsalReference: rehearsalReferenceV1(contract.contractDigest),
    driverReference: contract.driverReference,
    listenerReference: contract.listenerReference,
    listenerPlanDigest: contract.listenerPlanDigest,
    disabledReadinessDigest: contract.disabledReadinessDigest,
    driverContractDigest: contract.contractDigest,
    driverBehaviorDigest: contract.driverBehaviorDigest,
    evidenceMode: "repository_fake" as const,
    eventSequence: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1,
    disposition: "passed_repository_fake" as const,
    operationSetMatched: true as const,
    literalLoopbackPolicySimulated: true as const,
    privatePortPolicySimulated: true as const,
    singleConnectionPolicySimulated: true as const,
    zeroQueuePolicySimulated: true as const,
    oneFramePolicySimulated: true as const,
    connectionDeadlineSimulated: true as const,
    idleDeadlineSimulated: true as const,
    admissionDeadlineSimulated: true as const,
    backpressureSimulated: true as const,
    boundedShutdownSimulated: true as const,
    processRecoverySimulated: true as const,
    listenerAttemptsMade: 0 as const,
    networkIoEventsObserved: 0 as const,
    externalEffectOccurred: false as const,
    nativeImplementationPresent: false as const,
    nativeDriverAccepted: false as const,
    activationEvidenceAccepted: false as const,
    candidateForIndependentContractReview: true as const,
    automaticallyActivatesListener: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const rehearsal = objectFreezeV1({ ...material, rehearsalDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, nativeDriverRehearsalsV1, [rehearsal]);
  return rehearsal;
}

const rehearsalKeysV1 = [
  "contractVersion", "rehearsalReference", "driverReference", "listenerReference", "listenerPlanDigest",
  "disabledReadinessDigest", "driverContractDigest", "driverBehaviorDigest", "evidenceMode", "eventSequence",
  "disposition", "operationSetMatched", "literalLoopbackPolicySimulated", "privatePortPolicySimulated",
  "singleConnectionPolicySimulated", "zeroQueuePolicySimulated", "oneFramePolicySimulated",
  "connectionDeadlineSimulated", "idleDeadlineSimulated", "admissionDeadlineSimulated", "backpressureSimulated",
  "boundedShutdownSimulated", "processRecoverySimulated", "listenerAttemptsMade", "networkIoEventsObserved",
  "externalEffectOccurred", "nativeImplementationPresent", "nativeDriverAccepted", "activationEvidenceAccepted",
  "candidateForIndependentContractReview", "automaticallyActivatesListener", "grantsApproval",
  "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority", "grantsExecutionAuthority",
  "rehearsalDigest",
] as const;

export function parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1 {
  assertRuntimeV1("invalid_rehearsal");
  if (!weakSetContainsV1(nativeDriverRehearsalsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
  }
  const captured = exactHostDataSnapshotV1(value, rehearsalKeysV1);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
  const events = exactHostDataArrayV1(captured.eventSequence,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1.length);
  if (!events || !objectIsFrozenV1(captured.eventSequence)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
  }
  for (let index = 0; index < CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1.length;
    index += 1) {
    if (events[index] !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_FAKE_EVENTS_V1[index]) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
    }
  }
  const rehearsal = captured as unknown as ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1;
  if (rehearsal.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_DRIVER_REHEARSAL_V1
    || !patternMatchesV1(rehearsalReferencePatternV1, rehearsal.rehearsalReference)
    || !patternMatchesV1(driverReferencePatternV1, rehearsal.driverReference)
    || !patternMatchesV1(listenerReferencePatternV1, rehearsal.listenerReference)
    || !patternMatchesV1(digestPatternV1, rehearsal.listenerPlanDigest)
    || !patternMatchesV1(digestPatternV1, rehearsal.disabledReadinessDigest)
    || !patternMatchesV1(digestPatternV1, rehearsal.driverContractDigest)
    || !patternMatchesV1(digestPatternV1, rehearsal.driverBehaviorDigest)
    || rehearsal.rehearsalReference !== rehearsalReferenceV1(rehearsal.driverContractDigest)
    || rehearsal.driverBehaviorDigest !== repositoryFakeDriverBehaviorDigestV1
    || rehearsal.evidenceMode !== "repository_fake" || rehearsal.disposition !== "passed_repository_fake"
    || rehearsal.operationSetMatched !== true || rehearsal.literalLoopbackPolicySimulated !== true
    || rehearsal.privatePortPolicySimulated !== true || rehearsal.singleConnectionPolicySimulated !== true
    || rehearsal.zeroQueuePolicySimulated !== true || rehearsal.oneFramePolicySimulated !== true
    || rehearsal.connectionDeadlineSimulated !== true || rehearsal.idleDeadlineSimulated !== true
    || rehearsal.admissionDeadlineSimulated !== true || rehearsal.backpressureSimulated !== true
    || rehearsal.boundedShutdownSimulated !== true || rehearsal.processRecoverySimulated !== true
    || rehearsal.listenerAttemptsMade !== 0 || rehearsal.networkIoEventsObserved !== 0
    || rehearsal.externalEffectOccurred !== false || rehearsal.nativeImplementationPresent !== false
    || rehearsal.nativeDriverAccepted !== false || rehearsal.activationEvidenceAccepted !== false
    || rehearsal.candidateForIndependentContractReview !== true
    || rehearsal.automaticallyActivatesListener !== false || rehearsal.grantsApproval !== false
    || rehearsal.grantsNetworkAuthority !== false || rehearsal.grantsCommandAuthority !== false
    || rehearsal.grantsLeaseAuthority !== false || rehearsal.grantsExecutionAuthority !== false
    || !patternMatchesV1(digestPatternV1, rehearsal.rehearsalDigest)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
  }
  const material: Record<string, unknown> = { ...captured, eventSequence: events };
  delete material.rehearsalDigest;
  if (sha256Digest(material) !== rehearsal.rehearsalDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal");
  }
  try { assertNoSecretMaterial(material, "private loopback native driver rehearsal"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_rehearsal"); }
  return value as ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1;
}

export class RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 {
  readonly mode = "injected_repository_fake" as const;
  readonly #contract: ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  readonly #rehearsal: ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1;

  constructor(contractValue: unknown) {
    if (new.target !== RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_driver");
    }
    this.#contract = parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(contractValue);
    this.#rehearsal = createRepositoryFakeRehearsalV1(this.#contract);
    reflectApplyV1(weakSetAddV1, repositoryFakeNativeDriversV1, [this]);
    objectFreezeV1(this);
  }

  status(): ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1 {
    assertExactRepositoryFakeDriverV1(this);
    return this.#contract;
  }

  rehearse(): ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1 {
    assertExactRepositoryFakeDriverV1(this);
    return this.#rehearsal;
  }

  close(): void { assertExactRepositoryFakeDriverV1(this); }
}

const repositoryFakeDriverPrototypeV1 =
  RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1.prototype;
const repositoryFakeDriverStatusV1 = repositoryFakeDriverPrototypeV1.status;
const repositoryFakeDriverRehearseV1 = repositoryFakeDriverPrototypeV1.rehearse;
const repositoryFakeDriverCloseV1 = repositoryFakeDriverPrototypeV1.close;
objectFreezeV1(repositoryFakeDriverPrototypeV1);

function isExactRepositoryFakeDriverV1(value: unknown):
value is RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 {
  return weakSetContainsV1(repositoryFakeNativeDriversV1, value)
    && objectGetPrototypeOfV1(value) === repositoryFakeDriverPrototypeV1
    && objectIsFrozenV1(value);
}

function assertExactRepositoryFakeDriverV1(value: unknown): asserts value is
RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 {
  if (!isExactRepositoryFakeDriverV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("integrity_failed");
  }
}

export type BoundRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 = Readonly<{
  mode: "injected_repository_fake";
  status: () => ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1;
  rehearse: () => ConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1;
  close: () => void;
}>;

export function bindRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1(value: unknown):
BoundRepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1 {
  assertRuntimeV1("integrity_failed");
  assertExactRepositoryFakeDriverV1(value);
  const status = objectFreezeV1(() => reflectApplyV1(repositoryFakeDriverStatusV1, value, []));
  const rehearse = objectFreezeV1(() => reflectApplyV1(repositoryFakeDriverRehearseV1, value, []));
  const close = objectFreezeV1(() => reflectApplyV1(repositoryFakeDriverCloseV1, value, []));
  return objectFreezeV1({ mode: "injected_repository_fake" as const, status, rehearse, close });
}

export function createConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1(inputValue: unknown):
ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1 {
  assertRuntimeV1("invalid_evidence");
  const input = exactHostDataSnapshotV1(inputValue, ["readiness", "driverContract", "driverRehearsal"]);
  if (!input) throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  const readiness = parseReadinessV1(input.readiness);
  const contract = parseConnectionEnrollmentPrivateLoopbackNativeDriverContractV1(input.driverContract);
  const rehearsal = parseConnectionEnrollmentPrivateLoopbackNativeDriverRehearsalV1(input.driverRehearsal);
  if (contract.listenerReference !== readiness.listenerReference
    || contract.listenerPlanDigest !== readiness.listenerPlanDigest
    || contract.disabledReadinessDigest !== readiness.readinessDigest
    || rehearsal.driverReference !== contract.driverReference
    || rehearsal.listenerReference !== contract.listenerReference
    || rehearsal.listenerPlanDigest !== contract.listenerPlanDigest
    || rehearsal.disabledReadinessDigest !== contract.disabledReadinessDigest
    || rehearsal.driverContractDigest !== contract.contractDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  }
  const material = {
    contractVersion: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1,
    evidenceReference: evidenceReferenceV1(contract.contractDigest, rehearsal.rehearsalDigest),
    listenerReference: readiness.listenerReference,
    listenerPlanDigest: readiness.listenerPlanDigest,
    disabledReadinessDigest: readiness.readinessDigest,
    driverContractDigest: contract.contractDigest,
    driverRehearsalDigest: rehearsal.rehearsalDigest,
    evidenceMode: "repository_fake" as const,
    driverContractRehearsalPassed: true as const,
    nativeDriverAccepted: false as const,
    ownerActivationAccepted: false as const,
    platformQualificationAccepted: false as const,
    exclusivePortOwnershipProven: false as const,
    tunnelPeerAuthenticated: false as const,
    hostKeyCustodyProven: false as const,
    connectionDeadlineProven: false as const,
    idleDeadlineProven: false as const,
    admissionDeadlineProven: false as const,
    backpressureProven: false as const,
    shutdownCleanupProven: false as const,
    processRecoveryProven: false as const,
    blockerCodes: CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1,
    activationEligible: false as const,
    status: "blocked_repository_evidence_only" as const,
    nativeAttempted: false as const,
    listenerOpened: false as const,
    listenerAttemptsMade: 0 as const,
    networkIoEventsObserved: 0 as const,
    externalEffectOccurred: false as const,
    automaticRetryAllowed: false as const,
    requiresIndependentReview: true as const,
    requiresFreshOwnerAuthorization: true as const,
    opensListener: false as const,
    performsNetworkIo: false as const,
    grantsApproval: false as const,
    grantsNetworkAuthority: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  try { assertNoSecretMaterial(material, "private loopback native activation evidence"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence"); }
  const evidence = objectFreezeV1({ ...material, evidenceDigest: sha256Digest(material) });
  reflectApplyV1(weakSetAddV1, nativeActivationEvidenceRecordsV1, [evidence]);
  return evidence;
}

const evidenceKeysV1 = [
  "contractVersion", "evidenceReference", "listenerReference", "listenerPlanDigest", "disabledReadinessDigest",
  "driverContractDigest", "driverRehearsalDigest", "evidenceMode", "driverContractRehearsalPassed",
  "nativeDriverAccepted", "ownerActivationAccepted", "platformQualificationAccepted",
  "exclusivePortOwnershipProven", "tunnelPeerAuthenticated", "hostKeyCustodyProven",
  "connectionDeadlineProven", "idleDeadlineProven", "admissionDeadlineProven", "backpressureProven",
  "shutdownCleanupProven", "processRecoveryProven", "blockerCodes", "activationEligible", "status",
  "nativeAttempted", "listenerOpened", "listenerAttemptsMade", "networkIoEventsObserved", "externalEffectOccurred",
  "automaticRetryAllowed", "requiresIndependentReview", "requiresFreshOwnerAuthorization", "opensListener",
  "performsNetworkIo", "grantsApproval", "grantsNetworkAuthority", "grantsCommandAuthority", "grantsLeaseAuthority",
  "grantsExecutionAuthority", "evidenceDigest",
] as const;

export function parseConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1(value: unknown):
ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1 {
  assertRuntimeV1("invalid_evidence");
  if (!weakSetContainsV1(nativeActivationEvidenceRecordsV1, value) || !objectIsFrozenV1(value)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  }
  const captured = exactHostDataSnapshotV1(value, evidenceKeysV1);
  if (!captured) throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  const blockers = exactHostDataArrayV1(captured.blockerCodes,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1.length);
  if (!blockers || !objectIsFrozenV1(captured.blockerCodes)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  }
  for (let index = 0; index < CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1.length;
    index += 1) {
    if (blockers[index] !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_LISTENER_BLOCKERS_V1[index]) {
      throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
    }
  }
  const evidence = captured as unknown as ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1;
  if (evidence.contractVersion !== CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_NATIVE_ACTIVATION_EVIDENCE_V1
    || !patternMatchesV1(evidenceReferencePatternV1, evidence.evidenceReference)
    || !patternMatchesV1(listenerReferencePatternV1, evidence.listenerReference)
    || !patternMatchesV1(digestPatternV1, evidence.listenerPlanDigest)
    || !patternMatchesV1(digestPatternV1, evidence.disabledReadinessDigest)
    || !patternMatchesV1(digestPatternV1, evidence.driverContractDigest)
    || !patternMatchesV1(digestPatternV1, evidence.driverRehearsalDigest)
    || evidence.evidenceReference !== evidenceReferenceV1(
      evidence.driverContractDigest, evidence.driverRehearsalDigest)
    || evidence.evidenceMode !== "repository_fake" || evidence.driverContractRehearsalPassed !== true
    || evidence.nativeDriverAccepted !== false || evidence.ownerActivationAccepted !== false
    || evidence.platformQualificationAccepted !== false || evidence.exclusivePortOwnershipProven !== false
    || evidence.tunnelPeerAuthenticated !== false || evidence.hostKeyCustodyProven !== false
    || evidence.connectionDeadlineProven !== false || evidence.idleDeadlineProven !== false
    || evidence.admissionDeadlineProven !== false || evidence.backpressureProven !== false
    || evidence.shutdownCleanupProven !== false || evidence.processRecoveryProven !== false
    || evidence.activationEligible !== false || evidence.status !== "blocked_repository_evidence_only"
    || evidence.nativeAttempted !== false || evidence.listenerOpened !== false
    || evidence.listenerAttemptsMade !== 0 || evidence.networkIoEventsObserved !== 0
    || evidence.externalEffectOccurred !== false || evidence.automaticRetryAllowed !== false
    || evidence.requiresIndependentReview !== true || evidence.requiresFreshOwnerAuthorization !== true
    || evidence.opensListener !== false || evidence.performsNetworkIo !== false || evidence.grantsApproval !== false
    || evidence.grantsNetworkAuthority !== false || evidence.grantsCommandAuthority !== false
    || evidence.grantsLeaseAuthority !== false || evidence.grantsExecutionAuthority !== false
    || !patternMatchesV1(digestPatternV1, evidence.evidenceDigest)) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  }
  const material: Record<string, unknown> = { ...captured, blockerCodes: blockers };
  delete material.evidenceDigest;
  if (sha256Digest(material) !== evidence.evidenceDigest) {
    throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence");
  }
  try { assertNoSecretMaterial(material, "private loopback native activation evidence"); }
  catch { throw new ConnectionEnrollmentPrivateLoopbackNativeDriverContractErrorV1("invalid_evidence"); }
  return value as ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1;
}
