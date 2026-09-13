import { z } from "zod";
import { artifactManifestRecordSchema, authorityEnvelopeSchema } from "../../domain/v1";
import { fleetSignalEnvelopeSchema } from "../../node-fleet/v1/schemas";
import { nativeTaskSnapshotBodySchema } from "../../harness/v1/native-observation";
import { nativeTaskDispatchBodySchema, nativeTaskDispatchReceiptBodySchema } from "../../harness/v1/native-delivery";
import { codexTaskDispatchBodySchemaV1, codexTaskDispatchReceiptBodySchemaV1 } from "../../harness/codex-v1/delivery-contract";
import { codexTaskActivationBodySchemaV1 } from "../../harness/codex-v1/activation-contract";
import { canonicalFilesystemPathSchema, canonicalNetworkDestinationSchema } from "../../node-policy/v1/schemas";
import { computeAuthorityDigest, sha256Digest } from "../../security";
import { CONNECTION_ENROLLMENT_DELIVERY_ID_MAX_LENGTH, CONNECTION_ENROLLMENT_DELIVERY_ID_MIN_LENGTH,
  NODE_PROTOCOL_MAX_FRAME_BYTES, NODE_PROTOCOL_V1 } from "./types";

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const deliveryId = z.string().min(CONNECTION_ENROLLMENT_DELIVERY_ID_MIN_LENGTH)
  .max(CONNECTION_ENROLLMENT_DELIVERY_ID_MAX_LENGTH).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
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
const connectionEnrollmentEnvelope = z.object({
  body: z.object({
    contractVersion: label,
    tenantId: id,
    nodeId: id,
    connectionId: id,
  }).catchall(z.unknown()),
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    keyId: id,
    publicKeySpki: base64url,
    signature: base64url,
  }).strict(),
}).strict();
const connectionEnrollmentDelivery = z.object({
  deliveryId,
  enrollmentContract: label,
  envelopeDigest: digest,
  envelope: connectionEnrollmentEnvelope,
}).strict().superRefine((value, context) => {
  if (sha256Digest(value.envelope) !== value.envelopeDigest) {
    context.addIssue({ code: "custom", path: ["envelopeDigest"], message: "enrollment envelope digest mismatch" });
  }
});
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
export const leaseGrantSchema = z.object({
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
const artifactLineage = z.object({
  schema: z.literal("control-room.artifact-lineage/v1"),
  artifactId: id,
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  producerId: id,
  manifest: artifactManifestRecordSchema,
  producerClaim: z.object({
    schema: z.literal("control-room.artifact-verification-claim/v1"),
    claimId: id,
    artifactId: id,
    tenantId: id,
    projectId: id,
    jobId: id,
    attemptId: id,
    producerId: id,
    claim: z.literal("content_hash_matches_exact_bytes"),
    contentHash: digest,
    manifestDigest: digest,
    createdAt: isoDate,
    claimDigest: digest,
  }).strict(),
  independentVerification: z.object({ status: z.literal("not_run") }).strict(),
  recordedAt: isoDate,
  lineageDigest: digest,
}).strict().superRefine((lineage, context) => {
  const { lineageDigest, ...unsigned } = lineage;
  if (sha256Digest(unsigned) !== lineageDigest) context.addIssue({ code: "custom", path: ["lineageDigest"], message: "artifact lineage digest mismatch" });
  if (lineage.manifest.id !== lineage.artifactId || lineage.producerClaim.artifactId !== lineage.artifactId
    || lineage.manifest.tenantId !== lineage.tenantId || lineage.producerClaim.tenantId !== lineage.tenantId
    || lineage.manifest.projectId !== lineage.projectId || lineage.producerClaim.projectId !== lineage.projectId
    || lineage.manifest.jobId !== lineage.jobId || lineage.producerClaim.jobId !== lineage.jobId
    || lineage.manifest.attemptId !== lineage.attemptId || lineage.producerClaim.attemptId !== lineage.attemptId
    || lineage.manifest.producerId !== lineage.producerId || lineage.producerClaim.producerId !== lineage.producerId
    || lineage.manifest.contentHash !== lineage.producerClaim.contentHash
    || sha256Digest(lineage.manifest) !== lineage.producerClaim.manifestDigest) {
    context.addIssue({ code: "custom", message: "artifact lineage identity or producer claim mismatch" });
  }
  const { claimDigest, ...claimUnsigned } = lineage.producerClaim;
  if (sha256Digest(claimUnsigned) !== claimDigest) context.addIssue({ code: "custom", path: ["producerClaim", "claimDigest"], message: "producer claim digest mismatch" });
});
const jobEvent = z.object({
  ...leaseIdentity,
  event: z.enum(["started", "progress", "checkpointed", "waiting", "completed", "failed", "cancelled"]),
  sequence: z.number().int().positive(),
  occurredAt: isoDate,
  progressPercent: z.number().min(0).max(100).optional(),
  checkpointId: id.optional(),
  artifactManifestIds: z.array(id).max(1_000),
  artifactLineage: artifactLineage.optional(),
  safeReasonCode: id.optional(),
}).strict().superRefine((event, context) => {
  if ((event.event === "progress") !== (event.progressPercent !== undefined)) context.addIssue({ code: "custom", path: ["progressPercent"], message: "only progress events require progressPercent" });
  if ((event.event === "checkpointed") !== (event.checkpointId !== undefined)) context.addIssue({ code: "custom", path: ["checkpointId"], message: "only checkpointed events require checkpointId" });
  if ((event.event === "failed" || event.event === "cancelled") !== (event.safeReasonCode !== undefined)) context.addIssue({ code: "custom", path: ["safeReasonCode"], message: "failed and cancelled events require a safe reason code" });
  if (event.event !== "completed" && event.artifactManifestIds.length) context.addIssue({ code: "custom", path: ["artifactManifestIds"], message: "only completed events may identify artifacts" });
  if (event.event !== "completed" && event.artifactLineage) context.addIssue({ code: "custom", path: ["artifactLineage"], message: "only completed events may carry artifact lineage" });
  if (event.artifactLineage && (event.artifactManifestIds.length !== 1 || event.artifactManifestIds[0] !== event.artifactLineage.artifactId
    || event.jobId !== event.artifactLineage.jobId || event.attemptId !== event.artifactLineage.attemptId)) {
    context.addIssue({ code: "custom", path: ["artifactLineage"], message: "artifact lineage must match the completed event" });
  }
});
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
export const reconciliationAttemptSchema = z.object({
    attemptId: id,
    leaseId: id,
    leaseEpoch: z.number().int().positive(),
    state: z.enum(["leased", "running", "waiting", "completed", "failed", "cancelled"]),
    lastEventSequence: z.number().int().nonnegative(),
    checkpointIds: z.array(id).max(1_000),
  }).strict();
const reconciliationReport = z.object({
  lastAcknowledgedServerSequence: z.number().int().nonnegative(),
  attempts: z.array(reconciliationAttemptSchema).max(1_000),
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

function frame<TType extends string, TSchema extends z.ZodType>(type: TType, body: TSchema,
  authority?: { direction: "node_to_server" | "server_to_node"; senderKind: "node" | "control_room" }) {
  const authorityFields = authority ? {
    direction: z.literal(authority.direction),
    senderKind: z.literal(authority.senderKind),
  } : {};
  return z.object({ ...baseFrame, ...authorityFields, type: z.literal(type), body }).strict();
}

export const signedNodeFrameSchema = z.discriminatedUnion("type", [
  frame("connection.hello", connectionHello),
  frame("connection.accepted", connectionAccepted),
  frame("connection.enrollment.deliver", connectionEnrollmentDelivery,
    { direction: "node_to_server", senderKind: "node" }),
  frame("node.heartbeat", heartbeat),
  frame("node.fleet.signal", fleetSignalEnvelopeSchema),
  frame("job.offer", jobOffer),
  frame("job.offer.decision", offerDecision),
  frame("job.lease.grant", leaseGrantSchema),
  frame("job.lease.renewed", leaseRenewed),
  frame("job.event", jobEvent),
  frame("harness.native.snapshot", nativeTaskSnapshotBodySchema, { direction: "node_to_server", senderKind: "node" }),
  frame("harness.native.dispatch", nativeTaskDispatchBodySchema, { direction: "server_to_node", senderKind: "control_room" }),
  frame("harness.native.dispatch.receipt", nativeTaskDispatchReceiptBodySchema, { direction: "node_to_server", senderKind: "node" }),
  frame("harness.codex.dispatch", codexTaskDispatchBodySchemaV1, { direction: "server_to_node", senderKind: "control_room" }),
  frame("harness.codex.dispatch.receipt", codexTaskDispatchReceiptBodySchemaV1, { direction: "node_to_server", senderKind: "node" }),
  frame("harness.codex.dispatch.activation", codexTaskActivationBodySchemaV1, { direction: "server_to_node", senderKind: "control_room" }),
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
  if (value.type === "harness.native.dispatch") {
    const r = value.body.request;
    if (value.tenantId !== r.tenantId || Date.parse(value.expiresAt) > value.body.start.deadline
      || Date.parse(value.sentAt) < Date.parse(value.body.packet.approval.body.issuedAt))
      context.addIssue({ code: "custom", message: "native dispatch frame scope or deadline mismatch" });
  }
  if (value.type === "harness.native.dispatch.receipt") {
    if (value.body.tenantId !== value.tenantId || value.body.nodeId !== value.actorId
      || value.causationId !== value.body.dispatchMessageId || Date.parse(value.body.recordedAt) > Date.parse(value.sentAt))
      context.addIssue({ code: "custom", message: "native receipt frame identity mismatch" });
  }
  if (value.type === "harness.codex.dispatch") {
    const start = value.body.start;
    if (value.tenantId !== start.tenantId || Date.parse(value.expiresAt) > start.deadline
      || Date.parse(value.sentAt) < Date.parse(value.body.permit.body.issuedAt)) {
      context.addIssue({ code: "custom", message: "codex dispatch frame scope or deadline mismatch" });
    }
  }
  if (value.type === "harness.codex.dispatch.receipt") {
    if (value.body.tenantId !== value.tenantId || value.body.nodeId !== value.actorId
      || value.causationId !== value.body.dispatchMessageId || Date.parse(value.body.recordedAt) > Date.parse(value.sentAt)) {
      context.addIssue({ code: "custom", message: "codex receipt frame identity mismatch" });
    }
  }
  if (value.type === "harness.codex.dispatch.activation") {
    const activation = value.body;
    if (value.tenantId !== activation.tenantId || value.connectionId !== activation.connectionId
      || value.causationId !== activation.receiptMessageId || value.sentAt !== activation.activatedAt
      || Date.parse(value.expiresAt) > Date.parse(activation.activationExpiresAt)) {
      context.addIssue({ code: "custom", message: "codex activation frame identity or timing mismatch" });
    }
  }
  if (value.type === "connection.enrollment.deliver") {
    const envelope = value.body.envelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      context.addIssue({ code: "custom", path: ["body", "envelope"], message: "enrollment envelope must be an object" });
      return;
    }
    const body = Object.getOwnPropertyDescriptor(envelope, "body")?.value;
    const attestation = Object.getOwnPropertyDescriptor(envelope, "attestation")?.value;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
      context.addIssue({ code: "custom", path: ["body", "envelope"], message: "enrollment envelope shape is invalid" });
      return;
    }
    const contractVersion = Object.getOwnPropertyDescriptor(body, "contractVersion")?.value;
    const tenantId = Object.getOwnPropertyDescriptor(body, "tenantId")?.value;
    const nodeId = Object.getOwnPropertyDescriptor(body, "nodeId")?.value;
    const connectionId = Object.getOwnPropertyDescriptor(body, "connectionId")?.value;
    const keyId = Object.getOwnPropertyDescriptor(attestation, "keyId")?.value;
    if (contractVersion !== value.body.enrollmentContract || tenantId !== value.tenantId
      || nodeId !== value.actorId || connectionId !== value.connectionId || keyId !== value.keyId) {
      context.addIssue({ code: "custom", path: ["body", "envelope"], message: "enrollment envelope scope does not match frame identity" });
    }
  }
});

export const nodeToServerTypes = new Set(["connection.hello", "connection.enrollment.deliver", "node.heartbeat", "node.fleet.signal", "job.offer.decision", "job.event", "harness.native.snapshot", "harness.native.dispatch.receipt", "harness.codex.dispatch.receipt", "job.cancel.ack", "node.reconciliation.report", "node.operation.ack", "protocol.ack", "protocol.error"]);
export const serverToNodeTypes = new Set(["connection.accepted", "job.offer", "job.lease.grant", "job.lease.renewed", "job.cancel", "harness.native.dispatch", "harness.codex.dispatch", "harness.codex.dispatch.activation", "node.reconciliation.request", "node.operation.request", "protocol.ack", "protocol.error"]);
