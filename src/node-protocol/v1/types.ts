import type { ArtifactManifestRecord, AuthorityEnvelope } from "../../domain/v1";
import type { FleetSignalEnvelope } from "../../node-fleet/v1/schemas";
import type { NativeTaskSnapshotBody } from "../../harness/v1/native-observation";
import type { NativeTaskDispatchBody, NativeTaskDispatchReceiptBody } from "../../harness/v1/native-delivery";
import type { CodexTaskDispatchBodyV1, CodexTaskDispatchReceiptBodyV1 } from "../../harness/codex-v1/delivery-contract";
import type { CodexTaskActivationBodyV1 } from "../../harness/codex-v1/activation-contract";

export const NODE_PROTOCOL_V1 = "control-room-node/v1" as const;
export const NODE_PROTOCOL_SUPPORTED_VERSIONS = [NODE_PROTOCOL_V1] as const;
export const NODE_PROTOCOL_MAX_FRAME_BYTES = 1_048_576;
export const NODE_PROTOCOL_MAX_LIFETIME_SECONDS = 300;
export const NODE_PROTOCOL_MAX_CLOCK_SKEW_SECONDS = 30;
export const CONNECTION_ENROLLMENT_DELIVERY_ID_MIN_LENGTH = 3;
export const CONNECTION_ENROLLMENT_DELIVERY_ID_MAX_LENGTH = 160;

const connectionEnrollmentDeliveryIdPatternV1 = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const connectionEnrollmentDeliveryIdRegExpExecV1 = RegExp.prototype.exec;
const connectionEnrollmentDeliveryIdReflectApplyV1 = Reflect.apply;

export function isConnectionEnrollmentDeliveryIdV1(value: unknown): value is string {
  return typeof value === "string" && value.length >= CONNECTION_ENROLLMENT_DELIVERY_ID_MIN_LENGTH
    && value.length <= CONNECTION_ENROLLMENT_DELIVERY_ID_MAX_LENGTH
    && connectionEnrollmentDeliveryIdReflectApplyV1(connectionEnrollmentDeliveryIdRegExpExecV1,
      connectionEnrollmentDeliveryIdPatternV1, [value]) !== null;
}

export type NodeProtocolVersion = (typeof NODE_PROTOCOL_SUPPORTED_VERSIONS)[number];
export type ProtocolDirection = "node_to_server" | "server_to_node";
export type ProtocolSenderKind = "node" | "control_room";

export interface PlatformFacts {
  platform: "windows" | "macos" | "linux" | "cloud";
  architecture: string;
  hardwareFingerprint: string;
  softwareFingerprint: string;
  bridgeVersion: string;
  attestation: Record<string, string>;
}

export interface EnrollmentChallengeRequest {
  tokenId: string;
  token: string;
  nodeClass: string;
  supportedProtocols: string[];
}

export interface EnrollmentChallenge {
  challengeId: string;
  challengeNonce: string;
  issuedAt: string;
  expiresAt: string;
  supportedProtocols: string[];
  serverTrustKeys: ServerTrustKey[];
}

export interface ServerTrustKey {
  keyId: string;
  algorithm: "ed25519";
  spki: string;
}

export interface EnrollmentProof {
  challengeId: string;
  challengeNonce: string;
  nodeId: string;
  displayName: string;
  nodeClass: string;
  publicKey: {
    keyId: string;
    algorithm: "ed25519";
    spki: string;
  };
  platformFacts: PlatformFacts;
  supportedProtocols: string[];
  signature: string;
}

export type EnrollmentResult = {
  accepted: true;
  nodeId: string;
  keyId: string;
  selectedProtocol: NodeProtocolVersion;
  initialGrant: Record<string, unknown>;
  initialGrantDigest: string;
  serverTrustKeys: ServerTrustKey[];
  enrolledAt: string;
} | {
  accepted: false;
  safeReasonCode: "invalid_enrollment" | "expired_enrollment" | "unsupported_protocol" | "identity_conflict";
};

export interface ConnectionHelloBody {
  supportedProtocols: string[];
  features: string[];
  requestedMaxFrameBytes: number;
  lastAcknowledgedServerSequence: number;
  unresolvedAttemptIds: string[];
}

export interface ConnectionAcceptedBody {
  selectedProtocol: NodeProtocolVersion;
  enabledFeatures: string[];
  maxFrameBytes: number;
  heartbeatIntervalSeconds: number;
  serverTime: string;
}

/**
 * Carries one separately signed enrollment envelope through the authenticated
 * node channel. The node protocol binds the opaque envelope bytes and delivery
 * identity; the owning enrollment adapter remains responsible for parsing and
 * independently authorizing the inner contract.
 */
export interface ConnectionEnrollmentDeliveryBody {
  deliveryId: string;
  enrollmentContract: string;
  envelopeDigest: string;
  envelope: unknown;
}

export interface HeartbeatBody {
  observedAt: string;
  health: "healthy" | "degraded" | "draining";
  policyVersion: string;
  activeAttemptIds: string[];
  resources: {
    freeMemoryMb: number;
    freeScratchMb: number;
    cpuUtilizationPercent: number;
    gpuUtilizationPercent?: number;
  };
}

export interface JobOfferBody {
  offerId: string;
  nodeId: string;
  jobId: string;
  attemptId: string;
  proposedLeaseEpoch: number;
  offerExpiresAt: string;
  jobType: string;
  specVersion: string;
  inputDigest: string;
  artifactManifestIds: string[];
  authority: AuthorityEnvelope;
}

export interface OfferDecisionBody {
  offerId: string;
  jobId: string;
  attemptId: string;
  decision: "accepted" | "rejected";
  safeReasonCode?: "capacity" | "policy" | "version" | "storage" | "credential_unresolvable" | "maintenance" | "benchmark_expired";
}

export interface LeaseGrantBody {
  offerId: string;
  nodeId: string;
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  acquiredAt: string;
  expiresAt: string;
  authorityDigest: string;
  authority: AuthorityEnvelope;
}

export interface LeaseRenewedBody {
  nodeId: string;
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  renewedAt: string;
  expiresAt: string;
  authorityDigest: string;
  authority: AuthorityEnvelope;
}

export interface JobEventBody {
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  event: "started" | "progress" | "checkpointed" | "waiting" | "completed" | "failed" | "cancelled";
  sequence: number;
  occurredAt: string;
  progressPercent?: number;
  checkpointId?: string;
  artifactManifestIds: string[];
  artifactLineage?: ArtifactLineageBody;
  safeReasonCode?: string;
}

export interface ArtifactLineageBody {
  schema: "control-room.artifact-lineage/v1";
  artifactId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  manifest: ArtifactManifestRecord;
  producerClaim: {
    schema: "control-room.artifact-verification-claim/v1";
    claimId: string;
    artifactId: string;
    tenantId: string;
    projectId: string;
    jobId: string;
    attemptId: string;
    producerId: string;
    claim: "content_hash_matches_exact_bytes";
    contentHash: string;
    manifestDigest: string;
    createdAt: string;
    claimDigest: string;
  };
  independentVerification: { status: "not_run" };
  recordedAt: string;
  lineageDigest: string;
}

export interface CancelRequestBody {
  jobId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  reasonCode: "owner_requested" | "policy_changed" | "lease_revoked" | "shutdown";
}

export interface CancelAcknowledgementBody extends CancelRequestBody {
  disposition: "accepted" | "already_terminal" | "not_found" | "epoch_mismatch";
}

export interface ReconciliationRequestBody {
  lastAcknowledgedNodeSequence: number;
  requestedAttemptIds: string[];
}

export interface ReconciliationReportBody {
  lastAcknowledgedServerSequence: number;
  attempts: Array<{
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
    state: "leased" | "running" | "waiting" | "completed" | "failed" | "cancelled";
    lastEventSequence: number;
    checkpointIds: string[];
  }>;
}

export interface ProtocolErrorBody {
  code: "unsupported_version" | "malformed_frame" | "unauthenticated" | "replayed" | "expired" | "forbidden" | "rate_limited";
  relatedMessageId?: string;
}

export interface ProtocolAcknowledgementBody {
  acknowledgedMessageIds: string[];
  highestContiguousSequence: number;
  disposition: "accepted" | "duplicate";
}

export interface NodeOperationRequestBody {
  requestId: string;
  nodeId: string;
  operation: "request_drain" | "request_resume" | "request_quarantine";
  desiredState: "active" | "draining" | "quarantined";
  expectedNodeVersion: number;
  requestDigest: string;
  safeReasonCode?: string;
}

export interface NodeOperationAcknowledgementBody {
  requestId: string;
  nodeId: string;
  operation: NodeOperationRequestBody["operation"];
  expectedNodeVersion: number;
  disposition: "applied" | "rejected";
  acknowledgementId: string;
  safeResultCode?: string;
  resultingNodeVersion?: number;
}

export interface NodeMessageBodyMap {
  "connection.hello": ConnectionHelloBody;
  "connection.accepted": ConnectionAcceptedBody;
  "connection.enrollment.deliver": ConnectionEnrollmentDeliveryBody;
  "node.heartbeat": HeartbeatBody;
  "node.fleet.signal": FleetSignalEnvelope;
  "job.offer": JobOfferBody;
  "job.offer.decision": OfferDecisionBody;
  "job.lease.grant": LeaseGrantBody;
  "job.lease.renewed": LeaseRenewedBody;
  "job.event": JobEventBody;
  "harness.native.snapshot": NativeTaskSnapshotBody;
  "harness.native.dispatch": NativeTaskDispatchBody;
  "harness.native.dispatch.receipt": NativeTaskDispatchReceiptBody;
  "harness.codex.dispatch": CodexTaskDispatchBodyV1;
  "harness.codex.dispatch.receipt": CodexTaskDispatchReceiptBodyV1;
  "harness.codex.dispatch.activation": CodexTaskActivationBodyV1;
  "job.cancel": CancelRequestBody;
  "job.cancel.ack": CancelAcknowledgementBody;
  "node.reconciliation.request": ReconciliationRequestBody;
  "node.reconciliation.report": ReconciliationReportBody;
  "node.operation.request": NodeOperationRequestBody;
  "node.operation.ack": NodeOperationAcknowledgementBody;
  "protocol.ack": ProtocolAcknowledgementBody;
  "protocol.error": ProtocolErrorBody;
}

export type NodeMessageType = keyof NodeMessageBodyMap;

export type UnsignedNodeFrame<TType extends NodeMessageType = NodeMessageType> = TType extends NodeMessageType ? {
  protocol: NodeProtocolVersion;
  direction: ProtocolDirection;
  messageId: string;
  correlationId: string;
  causationId?: string;
  tenantId: string;
  actorId: string;
  senderKind: ProtocolSenderKind;
  keyId: string;
  connectionId: string;
  sequence: number;
  sentAt: string;
  expiresAt: string;
  nonce: string;
  type: TType;
  body: NodeMessageBodyMap[TType];
} : never;

export type SignedNodeFrame<TType extends NodeMessageType = NodeMessageType> = UnsignedNodeFrame<TType> & {
  bodyDigest: string;
  signature: string;
};

export interface TrustedProtocolKey {
  tenantId: string;
  actorId: string;
  senderKind: ProtocolSenderKind;
  keyId: string;
  algorithm: "ed25519";
  publicKeySpki: string;
  state: "active" | "retired" | "revoked";
  principalState: "active" | "draining" | "offline" | "pending_enrollment" | "quarantined" | "revoked";
  validFrom: string;
  validUntil?: string;
}

export interface TrustedKeyResolver {
  resolve(input: { tenantId: string; actorId: string; senderKind: ProtocolSenderKind; keyId: string }): Promise<TrustedProtocolKey | undefined>;
}

export interface ReplayGuard {
  consume(frame: SignedNodeFrame, receivedAt: string): Promise<"accepted" | "duplicate">;
}

export interface ProtocolRateLimitGuard {
  consume(input: {
    transportIdentity: string;
    tenantId: string;
    actorId: string;
    direction: ProtocolDirection;
    receivedAt: string;
  }): Promise<void>;
}
