import { z } from "zod";
import { authorityEnvelopeSchema } from "../../domain/v1";
import { canonicalFilesystemPathSchema, canonicalNetworkDestinationSchema } from "../../node-policy/v1/schemas";
import { computeAuthorityDigest } from "../../security";
import { NODE_PROTOCOL_MAX_FRAME_BYTES, NODE_PROTOCOL_V1 } from "./types";

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label = z.string().min(1).max(200).refine(
  (value) => ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  }),
  "control characters are not permitted",
);
const isoDate = z.string().datetime({ offset: true });
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const base64url = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const protocolList = z.array(label).min(1).max(16).refine((items) => new Set(items).size === items.length, "protocols must be unique");
function isSortedUnique(values: string[]): boolean {
  return new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1] < value);
}

export const completeAuthorityEnvelopeSchema = authorityEnvelopeSchema.superRefine((authority, context) => {
  if (computeAuthorityDigest(authority) !== authority.digest) context.addIssue({ code: "custom", path: ["digest"], message: "authority digest mismatch" });
  for (const [field, values] of [
    ["allowedOperations", authority.allowedOperations],
    ["credentialRefs", authority.credentialRefs],
    ["filesystemRoots", authority.filesystemRoots],
    ["allowedNetworkDestinations", authority.allowedNetworkDestinations],
  ] as const) {
    if (!isSortedUnique(values)) context.addIssue({ code: "custom", path: [field], message: `${field} must be sorted and unique` });
  }
  authority.filesystemRoots.forEach((root, index) => {
    if (!canonicalFilesystemPathSchema.safeParse(root).success) context.addIssue({ code: "custom", path: ["filesystemRoots", index], message: "filesystem root must be canonical" });
  });
  authority.allowedNetworkDestinations.forEach((destination, index) => {
    if (!canonicalNetworkDestinationSchema.safeParse(destination).success) context.addIssue({ code: "custom", path: ["allowedNetworkDestinations", index], message: "network destination must be canonical" });
  });
});

export const platformFactsSchema = z.object({
  platform: z.enum(["windows", "macos", "linux", "cloud"]),
  architecture: label,
  hardwareFingerprint: digest,
  softwareFingerprint: digest,
  bridgeVersion: label,
  attestation: z.record(id, label).refine((value) => Object.keys(value).length <= 32, "too many attestation fields"),
}).strict();

export const enrollmentChallengeRequestSchema = z.object({
  tokenId: id,
  token: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
  nodeClass: id,
  supportedProtocols: protocolList,
}).strict();

export const issueEnrollmentTokenSchema = z.object({
  tenantId: id,
  nodeClass: id,
  createdBy: id,
  createdAt: isoDate,
  expiresAt: isoDate.optional(),
  tokenId: id.optional(),
}).strict();

export const enrollmentChallengeSchema = z.object({
  challengeId: id,
  challengeNonce: base64url,
  issuedAt: isoDate,
  expiresAt: isoDate,
  supportedProtocols: protocolList,
  serverTrustKeys: z.array(z.object({ keyId: id, algorithm: z.literal("ed25519"), spki: base64url }).strict()).min(1).max(8),
}).strict().refine((value) => Date.parse(value.expiresAt) > Date.parse(value.issuedAt), { message: "challenge must expire after issue", path: ["expiresAt"] });

export const enrollmentProofSchema = z.object({
  challengeId: id,
  challengeNonce: base64url,
  nodeId: id,
  displayName: label,
  nodeClass: id,
  publicKey: z.object({ keyId: id, algorithm: z.literal("ed25519"), spki: base64url }).strict(),
  platformFacts: platformFactsSchema,
  supportedProtocols: protocolList,
  signature: base64url,
}).strict();

const connectionHello = z.object({
  supportedProtocols: protocolList,
  features: z.array(id).max(64),
  requestedMaxFrameBytes: z.number().int().min(4_096).max(NODE_PROTOCOL_MAX_FRAME_BYTES),
  lastAcknowledgedServerSequence: z.number().int().nonnegative(),
  unresolvedAttemptIds: z.array(id).max(1_000),
}).strict();
const connectionAccepted = z.object({
  selectedProtocol: z.literal(NODE_PROTOCOL_V1),
  enabledFeatures: z.array(id).max(64),
  maxFrameBytes: z.number().int().min(4_096).max(NODE_PROTOCOL_MAX_FRAME_BYTES),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300),
  serverTime: isoDate,
}).strict();
const heartbeat = z.object({
  observedAt: isoDate,
  health: z.enum(["healthy", "degraded", "draining"]),
  policyVersion: label,
  activeAttemptIds: z.array(id).max(1_000),
  resources: z.object({
    freeMemoryMb: z.number().int().nonnegative(),
    freeScratchMb: z.number().int().nonnegative(),
    cpuUtilizationPercent: z.number().min(0).max(100),
    gpuUtilizationPercent: z.number().min(0).max(100).optional(),
  }).strict(),
}).strict();
const leaseIdentity = {
  jobId: id,
  attemptId: id,
  leaseId: id,
  leaseEpoch: z.number().int().positive(),
};
const jobOffer = z.object({
  offerId: id,
  nodeId: id,
  jobId: id,
  attemptId: id,
  proposedLeaseEpoch: z.number().int().positive(),
  offerExpiresAt: isoDate,
  jobType: id,
  specVersion: label,
  inputDigest: digest,
  artifactManifestIds: z.array(id).max(1_000),
  authority: completeAuthorityEnvelopeSchema,
}).strict();
const offerDecision = z.object({
  offerId: id,
  jobId: id,
  attemptId: id,
  decision: z.enum(["accepted", "rejected"]),
  safeReasonCode: z.enum(["capacity", "policy", "version", "storage", "credential_unresolvable", "maintenance", "benchmark_expired"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "rejected" && !value.safeReasonCode) context.addIssue({ code: "custom", path: ["safeReasonCode"], message: "rejections require a safe reason" });
  if (value.decision === "accepted" && value.safeReasonCode) context.addIssue({ code: "custom", path: ["safeReasonCode"], message: "accepted leases cannot carry a rejection reason" });
});
const leaseGrant = z.object({
  offerId: id,
  nodeId: id,
  ...leaseIdentity,
  acquiredAt: isoDate,
  expiresAt: isoDate,
  authorityDigest: digest,
  authority: completeAuthorityEnvelopeSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "lease must expire after acquisition" });
  if (value.authorityDigest !== value.authority.digest) context.addIssue({ code: "custom", path: ["authorityDigest"], message: "lease authority digest must match the complete authority" });
});
const leaseRenewed = z.object({
  nodeId: id,
  ...leaseIdentity,
  renewedAt: isoDate,
  expiresAt: isoDate,
  authorityDigest: digest,
  authority: completeAuthorityEnvelopeSchema,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.renewedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "renewed lease must expire after renewal" });
  if (value.authorityDigest !== value.authority.digest) context.addIssue({ code: "custom", path: ["authorityDigest"], message: "renewed authority digest must match the complete authority" });
});
const jobEvent = z.object({
  ...leaseIdentity,
  event: z.enum(["started", "progress", "checkpointed", "waiting", "completed", "failed", "cancelled"]),
  sequence: z.number().int().nonnegative(),
  occurredAt: isoDate,
  progressPercent: z.number().min(0).max(100).optional(),
  checkpointId: id.optional(),
  artifactManifestIds: z.array(id).max(1_000),
  safeReasonCode: id.optional(),
}).strict();
const cancelRequest = z.object({ ...leaseIdentity, reasonCode: z.enum(["owner_requested", "policy_changed", "lease_revoked", "shutdown"]) }).strict();
const cancelAck = z.object({
  ...leaseIdentity,
  reasonCode: z.enum(["owner_requested", "policy_changed", "lease_revoked", "shutdown"]),
  disposition: z.enum(["accepted", "already_terminal", "not_found", "epoch_mismatch"]),
}).strict();
const reconciliationRequest = z.object({
  lastAcknowledgedNodeSequence: z.number().int().nonnegative(),
  requestedAttemptIds: z.array(id).max(1_000),
}).strict();
const reconciliationReport = z.object({
  lastAcknowledgedServerSequence: z.number().int().nonnegative(),
  attempts: z.array(z.object({
    attemptId: id,
    leaseId: id,
    leaseEpoch: z.number().int().positive(),
    state: z.enum(["leased", "running", "waiting", "completed", "failed", "cancelled"]),
    lastEventSequence: z.number().int().nonnegative(),
    checkpointIds: z.array(id).max(1_000),
  }).strict()).max(1_000),
}).strict();
const protocolError = z.object({
  code: z.enum(["unsupported_version", "malformed_frame", "unauthenticated", "replayed", "expired", "forbidden", "rate_limited"]),
  relatedMessageId: id.optional(),
}).strict();
const protocolAcknowledgement = z.object({
  acknowledgedMessageIds: z.array(id).min(1).max(100),
  highestContiguousSequence: z.number().int().positive(),
  disposition: z.enum(["accepted", "duplicate"]),
}).strict();
const nodeOperationRequest = z.object({
  requestId: id,
  nodeId: id,
  operation: z.enum(["request_drain", "request_resume", "request_quarantine"]),
  desiredState: z.enum(["active", "draining", "quarantined"]),
  expectedNodeVersion: z.number().int().nonnegative(),
  requestDigest: digest,
  safeReasonCode: id.optional(),
}).strict().superRefine((value, context) => {
  const expectedState = value.operation === "request_drain" ? "draining" : value.operation === "request_resume" ? "active" : "quarantined";
  if (value.desiredState !== expectedState) context.addIssue({ code: "custom", path: ["desiredState"], message: "operation and desired state must match" });
  if (value.operation === "request_quarantine" ? !value.safeReasonCode : value.safeReasonCode !== undefined) {
    context.addIssue({ code: "custom", path: ["safeReasonCode"], message: "only quarantine requires a safe reason code" });
  }
});
const nodeOperationAcknowledgement = z.object({
  requestId: id,
  nodeId: id,
  operation: z.enum(["request_drain", "request_resume", "request_quarantine"]),
  expectedNodeVersion: z.number().int().nonnegative(),
  disposition: z.enum(["applied", "rejected"]),
  acknowledgementId: id,
  safeResultCode: id.optional(),
  resultingNodeVersion: z.number().int().nonnegative().optional(),
}).strict().superRefine((value, context) => {
  if (value.disposition === "applied" ? value.resultingNodeVersion === undefined || value.safeResultCode !== undefined : !value.safeResultCode || value.resultingNodeVersion !== undefined) {
    context.addIssue({ code: "custom", path: ["disposition"], message: "operation acknowledgement fields do not match disposition" });
  }
});

const baseFrame = {
  protocol: z.literal(NODE_PROTOCOL_V1),
  direction: z.enum(["node_to_server", "server_to_node"]),
  messageId: id,
  correlationId: id,
  causationId: id.optional(),
  tenantId: id,
  actorId: id,
  senderKind: z.enum(["node", "control_room"]),
  keyId: id,
  connectionId: id,
  sequence: z.number().int().positive(),
  sentAt: isoDate,
  expiresAt: isoDate,
  nonce: base64url,
  bodyDigest: digest,
  signature: base64url,
};

function frame<TType extends string, TSchema extends z.ZodType>(type: TType, body: TSchema) {
  return z.object({ ...baseFrame, type: z.literal(type), body }).strict();
}

export const signedNodeFrameSchema = z.discriminatedUnion("type", [
  frame("connection.hello", connectionHello),
  frame("connection.accepted", connectionAccepted),
  frame("node.heartbeat", heartbeat),
  frame("job.offer", jobOffer),
  frame("job.offer.decision", offerDecision),
  frame("job.lease.grant", leaseGrant),
  frame("job.lease.renewed", leaseRenewed),
  frame("job.event", jobEvent),
  frame("job.cancel", cancelRequest),
  frame("job.cancel.ack", cancelAck),
  frame("node.reconciliation.request", reconciliationRequest),
  frame("node.reconciliation.report", reconciliationReport),
  frame("node.operation.request", nodeOperationRequest),
  frame("node.operation.ack", nodeOperationAcknowledgement),
  frame("protocol.ack", protocolAcknowledgement),
  frame("protocol.error", protocolError),
]).superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.sentAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "frame must expire after sending" });
  if (value.direction === "node_to_server" && value.senderKind !== "node") context.addIssue({ code: "custom", path: ["senderKind"], message: "node-to-server frames must be node signed" });
  if (value.direction === "server_to_node" && value.senderKind !== "control_room") context.addIssue({ code: "custom", path: ["senderKind"], message: "server-to-node frames must be Control Room signed" });
});

export const nodeToServerTypes = new Set(["connection.hello", "node.heartbeat", "job.offer.decision", "job.event", "job.cancel.ack", "node.reconciliation.report", "node.operation.ack", "protocol.ack", "protocol.error"]);
export const serverToNodeTypes = new Set(["connection.accepted", "job.offer", "job.lease.grant", "job.lease.renewed", "job.cancel", "node.reconciliation.request", "node.operation.request", "protocol.ack", "protocol.error"]);
