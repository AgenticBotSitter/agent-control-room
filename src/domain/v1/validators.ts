import { z } from "zod";
import { canonicalNetworkDestinationSchema } from "../../security/canonical-network-destination";
import { authorityModes } from "../../contracts/v1/types";
import {
  DOMAIN_CONTRACT_VERSION,
  approvalStates,
  artifactStates,
  attemptStates,
  checkpointStates,
  effectIntentStates,
  incidentStates,
  jobStates,
  leaseStates,
  nodeStates,
  requestStates,
  scheduleStates,
  serviceStates,
  workflowStates,
} from "./types";

const isoDate = z.string().datetime({ offset: true });
const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const safeLabel = z.string().min(1).max(180);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonNegativeMoney = z.number().finite().min(0);

const actorSchema = z.object({
  actorId: safeId,
  actorType: z.enum(["human", "agent", "service", "node"]),
}).strict();

const baseRecordShape = {
  contractVersion: z.literal(DOMAIN_CONTRACT_VERSION),
  id: safeId,
  tenantId: safeId,
  version: z.number().int().nonnegative(),
  createdAt: isoDate,
  updatedAt: isoDate,
};

function orderedRecord<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...baseRecordShape, ...shape }).strict().refine(
    (record) => {
      const dated = record as { createdAt: string; updatedAt: string };
      return Date.parse(dated.updatedAt) >= Date.parse(dated.createdAt);
    },
    { message: "updatedAt must not precede createdAt", path: ["updatedAt"] },
  );
}

export const authorityEnvelopeSchema = z.object({
  projectId: safeId,
  allowedExecutor: safeId,
  allowedOperations: z.array(safeId).min(1).max(100),
  credentialRefs: z.array(safeId).max(50),
  filesystemRoots: z.array(z.string().min(1).max(1_024)).max(100),
  networkPolicy: z.enum(["none", "allowlist"]),
  allowedNetworkDestinations: z.array(z.string().min(1).max(300)).max(100),
  effectPolicy: z.enum(["none", "preauthorized", "approval_required"]),
  maxRisk: z.enum(["low", "medium", "high", "critical"]),
  maxDurationSeconds: z.number().int().positive().max(31_536_000),
  maxConcurrentEffects: z.number().int().nonnegative().max(10_000),
  maxCostUsd: nonNegativeMoney.optional(),
  expiresAt: isoDate,
  parentDigest: digest.optional(),
  digest,
}).strict().superRefine((authority, context) => {
  if (authority.networkPolicy === "none" && authority.allowedNetworkDestinations.length > 0) {
    context.addIssue({ code: "custom", message: "network policy none forbids destinations", path: ["allowedNetworkDestinations"] });
  }
  if (authority.networkPolicy === "allowlist" && authority.allowedNetworkDestinations.length === 0) {
    context.addIssue({ code: "custom", message: "allowlist network policy requires a destination", path: ["allowedNetworkDestinations"] });
  }
  if (authority.effectPolicy === "none" && authority.maxConcurrentEffects !== 0) {
    context.addIssue({ code: "custom", message: "effect policy none requires zero concurrent effects", path: ["maxConcurrentEffects"] });
  }
  if (authority.effectPolicy !== "none" && authority.maxConcurrentEffects === 0) {
    context.addIssue({ code: "custom", message: "enabled effects require positive concurrency", path: ["maxConcurrentEffects"] });
  }
});

export const requestRecordSchema = orderedRecord({
  kind: z.literal("request"),
  projectId: safeId.optional(),
  title: safeLabel,
  objective: z.string().min(1).max(4_000),
  state: z.enum(requestStates),
  priority: z.number().int().min(0).max(100),
  requestedBy: actorSchema,
  idempotencyKey: z.string().min(12).max(180),
});

export const workflowRecordSchema = orderedRecord({
  kind: z.literal("workflow"),
  requestId: safeId,
  projectId: safeId,
  definitionVersion: safeLabel,
  definitionDigest: digest,
  authorityMode: z.enum(authorityModes),
  state: z.enum(workflowStates),
  jobIds: z.array(safeId).max(10_000),
});

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(100),
  backoffSeconds: z.number().int().min(0).max(604_800),
  retryableFailureCodes: z.array(safeId).max(100),
  retryAfterOrphan: z.boolean(),
  ambiguousEffectPolicy: z.enum(["attention", "reconcile"]),
}).strict();

export const jobRecordSchema = orderedRecord({
  kind: z.literal("job"),
  workflowId: safeId,
  projectId: safeId,
  jobType: safeId,
  specVersion: safeLabel,
  inputDigest: digest,
  state: z.enum(jobStates),
  priority: z.number().int().min(0).max(100),
  requiredCapability: safeId,
  dependsOnJobIds: z.array(safeId).max(10_000),
  authority: authorityEnvelopeSchema,
  retryPolicy: retryPolicySchema,
}).refine((job) => job.authority.projectId === job.projectId, {
  message: "authority projectId must match job projectId",
  path: ["authority", "projectId"],
});

const terminalAttemptStates = new Set(["succeeded", "failed", "cancelled", "orphaned"]);
export const attemptRecordSchema = orderedRecord({
  kind: z.literal("attempt"),
  jobId: safeId,
  attemptNumber: z.number().int().positive(),
  state: z.enum(attemptStates),
  workerId: safeId.optional(),
  nodeId: safeId.optional(),
  leaseEpoch: z.number().int().positive().optional(),
  offeredAt: isoDate,
  startedAt: isoDate.optional(),
  finishedAt: isoDate.optional(),
  safeFailureCode: safeId.optional(),
}).superRefine((attempt, context) => {
  if (terminalAttemptStates.has(attempt.state) !== Boolean(attempt.finishedAt)) {
    context.addIssue({ code: "custom", message: "terminal attempts require finishedAt and nonterminal attempts forbid it", path: ["finishedAt"] });
  }
  if (["running", "waiting", "succeeded", "failed"].includes(attempt.state) && !attempt.startedAt) {
    context.addIssue({ code: "custom", message: "started execution requires startedAt", path: ["startedAt"] });
  }
});

export const leaseRecordSchema = orderedRecord({
  kind: z.literal("lease"),
  jobId: safeId,
  attemptId: safeId,
  nodeId: safeId,
  epoch: z.number().int().positive(),
  state: z.enum(leaseStates),
  acquiredAt: isoDate,
  expiresAt: isoDate,
  renewedAt: isoDate.optional(),
}).refine((lease) => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt), {
  message: "expiresAt must follow acquiredAt",
  path: ["expiresAt"],
});

export const checkpointRecordSchema = orderedRecord({
  kind: z.literal("checkpoint"),
  attemptId: safeId,
  sequence: z.number().int().nonnegative(),
  state: z.enum(checkpointStates),
  payloadDigest: digest,
  artifactIds: z.array(safeId).max(1_000),
  verifiedAt: isoDate.optional(),
}).superRefine((checkpoint, context) => {
  if ((checkpoint.state === "verified") !== Boolean(checkpoint.verifiedAt)) {
    context.addIssue({ code: "custom", message: "only verified checkpoints require verifiedAt", path: ["verifiedAt"] });
  }
});

export const effectIntentRecordSchema = orderedRecord({
  kind: z.literal("effect_intent"),
  jobId: safeId,
  attemptId: safeId,
  operation: safeId,
  operationDigest: digest,
  destination: z.union([safeId, canonicalNetworkDestinationSchema]),
  idempotencyKey: z.string().min(12).max(180),
  risk: z.enum(["low", "medium", "high", "critical"]),
  state: z.enum(effectIntentStates),
  approvalId: safeId.optional(),
  destinationReceipt: z.string().min(1).max(500).optional(),
  safeFailureCode: safeId.optional(),
}).superRefine((effect, context) => {
  if ((effect.risk === "high" || effect.risk === "critical") && !effect.approvalId) {
    context.addIssue({ code: "custom", message: "high and critical effects require approvalId", path: ["approvalId"] });
  }
  if (effect.state === "confirmed" && !effect.destinationReceipt) {
    context.addIssue({ code: "custom", message: "confirmed effects require a destination receipt", path: ["destinationReceipt"] });
  }
});

export const approvalRecordSchema = orderedRecord({
  kind: z.literal("approval"),
  operationDigest: digest,
  scope: safeId,
  risk: z.enum(["low", "medium", "high", "critical"]),
  state: z.enum(approvalStates),
  requestedBy: actorSchema,
  requiredActorType: z.enum(["owner", "operator", "policy"]),
  expiresAt: isoDate,
  decidedBy: actorSchema.optional(),
  decidedAt: isoDate.optional(),
  safeReasonCode: safeId.optional(),
}).superRefine((approval, context) => {
  const decided = approval.state === "approved" || approval.state === "denied" || approval.state === "revoked";
  if (decided && (!approval.decidedBy || !approval.decidedAt)) {
    context.addIssue({ code: "custom", message: "decided approvals require actor and timestamp", path: ["decidedAt"] });
  }
  if (!decided && (approval.decidedBy || approval.decidedAt)) {
    context.addIssue({ code: "custom", message: "undecided approvals forbid decision metadata", path: ["decidedAt"] });
  }
});

export const serviceRecordSchema = orderedRecord({
  kind: z.literal("service"),
  projectId: safeId,
  serviceType: safeId,
  desiredStateDigest: digest,
  state: z.enum(serviceStates),
  lastObservedAt: isoDate.optional(),
  lastHealthyAt: isoDate.optional(),
  safeStatusCode: safeId.optional(),
});

export const scheduleRecordSchema = orderedRecord({
  kind: z.literal("schedule"),
  projectId: safeId,
  state: z.enum(scheduleStates),
  scheduleType: z.enum(["cron", "interval", "once"]),
  expression: z.string().min(1).max(300),
  timezone: z.string().min(1).max(100),
  targetType: z.enum(["workflow", "job", "service_check"]),
  targetId: safeId,
  nextRunAt: isoDate.optional(),
  idempotencyWindowSeconds: z.number().int().positive().max(31_536_000),
});

export const incidentRecordSchema = orderedRecord({
  kind: z.literal("incident"),
  projectId: safeId.optional(),
  nodeId: safeId.optional(),
  severity: z.enum(["info", "warning", "critical"]),
  state: z.enum(incidentStates),
  sourceType: safeId,
  sourceId: safeId,
  summary: z.string().min(1).max(1_000),
  openedAt: isoDate,
  resolvedAt: isoDate.optional(),
}).superRefine((incident, context) => {
  const resolved = incident.state === "resolved" || incident.state === "closed";
  if (resolved !== Boolean(incident.resolvedAt)) {
    context.addIssue({ code: "custom", message: "resolved and closed incidents require resolvedAt", path: ["resolvedAt"] });
  }
});

export const artifactManifestRecordSchema = orderedRecord({
  kind: z.literal("artifact_manifest"),
  projectId: safeId,
  workflowId: safeId.optional(),
  jobId: safeId,
  attemptId: safeId,
  state: z.enum(artifactStates),
  contentHash: digest,
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(200),
  logicalRole: safeId,
  schemaVersion: safeLabel,
  producerId: safeId,
  storageClass: z.enum(["local", "r2", "repository", "external"]),
  opaqueLocator: z.string().min(1).max(1_000).optional(),
  retentionClass: safeId,
}).superRefine((artifact, context) => {
  if (["uploaded", "verified", "quarantined"].includes(artifact.state) && !artifact.opaqueLocator) {
    context.addIssue({ code: "custom", message: "stored artifacts require an opaque locator", path: ["opaqueLocator"] });
  }
  if (artifact.opaqueLocator && /(?:X-Amz-|token=|signature=)/i.test(artifact.opaqueLocator)) {
    context.addIssue({ code: "custom", message: "opaque locator must not contain signed credentials", path: ["opaqueLocator"] });
  }
});

export const nodeRecordSchema = orderedRecord({
  kind: z.literal("node"),
  displayName: safeLabel,
  state: z.enum(nodeStates),
  platform: z.enum(["windows", "macos", "linux", "cloud"]),
  architecture: safeLabel,
  identityKeyId: safeId,
  hardwareFingerprint: digest,
  softwareFingerprint: digest,
  policyVersion: safeLabel,
  minimumProtocolVersion: safeLabel,
  enrolledAt: isoDate.optional(),
  lastSeenAt: isoDate.optional(),
  quarantineReasonCode: safeId.optional(),
}).superRefine((node, context) => {
  if (node.state !== "pending_enrollment" && !node.enrolledAt) {
    context.addIssue({ code: "custom", message: "enrolled nodes require enrolledAt", path: ["enrolledAt"] });
  }
  if (node.state === "quarantined" && !node.quarantineReasonCode) {
    context.addIssue({ code: "custom", message: "quarantined nodes require a reason code", path: ["quarantineReasonCode"] });
  }
});

export const messageEnvelopeSchema = z.object({
  protocol: safeLabel,
  messageId: safeId,
  correlationId: safeId,
  causationId: safeId.optional(),
  actorId: safeId,
  tenantId: safeId,
  sentAt: isoDate,
  expiresAt: isoDate,
  nonce: z.string().min(16).max(300),
  type: safeId,
  bodyDigest: digest,
  body: z.unknown(),
  signature: z.string().min(16).max(10_000),
}).strict().refine((message) => Date.parse(message.expiresAt) > Date.parse(message.sentAt), {
  message: "expiresAt must follow sentAt",
  path: ["expiresAt"],
});

export const domainEntitySchema = z.union([
  requestRecordSchema,
  workflowRecordSchema,
  jobRecordSchema,
  attemptRecordSchema,
  leaseRecordSchema,
  checkpointRecordSchema,
  effectIntentRecordSchema,
  approvalRecordSchema,
  serviceRecordSchema,
  scheduleRecordSchema,
  incidentRecordSchema,
  artifactManifestRecordSchema,
  nodeRecordSchema,
]);
