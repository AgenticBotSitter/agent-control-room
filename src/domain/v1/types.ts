import type { AuthorityMode } from "../../contracts/v1/types";

export const DOMAIN_CONTRACT_VERSION = "control-room-domain/v1" as const;

export const requestStates = ["draft", "submitted", "accepted", "fulfilled", "rejected", "cancelled"] as const;
export const workflowStates = ["proposed", "active", "paused", "succeeded", "failed", "cancelled"] as const;
export const jobStates = ["proposed", "ready", "leased", "running", "waiting_approval", "succeeded", "failed", "cancelled", "orphaned", "rejected"] as const;
export const attemptStates = ["offered", "leased", "running", "waiting", "succeeded", "failed", "cancelled", "orphaned"] as const;
export const leaseStates = ["active", "expired", "released", "revoked"] as const;
export const checkpointStates = ["declared", "stored", "verified", "rejected"] as const;
export const effectIntentStates = ["proposed", "authorized", "executing", "confirmed", "failed", "ambiguous", "cancelled"] as const;
export const approvalStates = ["pending", "approved", "denied", "expired", "revoked"] as const;
export const serviceStates = ["active", "degraded", "paused", "failed", "retired"] as const;
export const scheduleStates = ["active", "paused", "disabled"] as const;
export const incidentStates = ["open", "acknowledged", "mitigating", "resolved", "closed"] as const;
export const artifactStates = ["declared", "uploaded", "verified", "quarantined", "rejected", "deleted"] as const;
export const nodeStates = ["pending_enrollment", "active", "draining", "offline", "quarantined", "revoked"] as const;

export type RequestState = (typeof requestStates)[number];
export type WorkflowState = (typeof workflowStates)[number];
export type JobState = (typeof jobStates)[number];
export type AttemptState = (typeof attemptStates)[number];
export type LeaseState = (typeof leaseStates)[number];
export type CheckpointState = (typeof checkpointStates)[number];
export type EffectIntentState = (typeof effectIntentStates)[number];
export type ApprovalState = (typeof approvalStates)[number];
export type ServiceState = (typeof serviceStates)[number];
export type ScheduleState = (typeof scheduleStates)[number];
export type IncidentState = (typeof incidentStates)[number];
export type ArtifactState = (typeof artifactStates)[number];
export type NodeState = (typeof nodeStates)[number];

export interface ActorRef {
  actorId: string;
  actorType: "human" | "agent" | "service" | "node";
}

export interface DomainRecord {
  contractVersion: typeof DOMAIN_CONTRACT_VERSION;
  id: string;
  tenantId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AuthorityEnvelope {
  projectId: string;
  allowedExecutor: string;
  allowedOperations: string[];
  credentialRefs: string[];
  filesystemRoots: string[];
  networkPolicy: "none" | "allowlist";
  allowedNetworkDestinations: string[];
  effectPolicy: "none" | "preauthorized" | "approval_required";
  maxRisk: "low" | "medium" | "high" | "critical";
  maxDurationSeconds: number;
  maxConcurrentEffects: number;
  maxCostUsd?: number;
  expiresAt: string;
  parentDigest?: string;
  digest: string;
}

export interface RequestRecord extends DomainRecord {
  kind: "request";
  projectId?: string;
  title: string;
  objective: string;
  state: RequestState;
  priority: number;
  requestedBy: ActorRef;
  idempotencyKey: string;
}

export interface WorkflowRecord extends DomainRecord {
  kind: "workflow";
  requestId: string;
  projectId: string;
  definitionVersion: string;
  definitionDigest: string;
  authorityMode: AuthorityMode;
  state: WorkflowState;
  jobIds: string[];
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffSeconds: number;
  retryableFailureCodes: string[];
  retryAfterOrphan: boolean;
  ambiguousEffectPolicy: "attention" | "reconcile";
}

export interface JobRecord extends DomainRecord {
  kind: "job";
  workflowId: string;
  projectId: string;
  jobType: string;
  specVersion: string;
  inputDigest: string;
  state: JobState;
  priority: number;
  requiredCapability: string;
  dependsOnJobIds: string[];
  authority: AuthorityEnvelope;
  retryPolicy: RetryPolicy;
}

export interface AttemptRecord extends DomainRecord {
  kind: "attempt";
  jobId: string;
  attemptNumber: number;
  state: AttemptState;
  workerId?: string;
  nodeId?: string;
  leaseEpoch?: number;
  offeredAt: string;
  startedAt?: string;
  finishedAt?: string;
  safeFailureCode?: string;
}

export interface LeaseRecord extends DomainRecord {
  kind: "lease";
  jobId: string;
  attemptId: string;
  nodeId: string;
  epoch: number;
  state: LeaseState;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
}

export interface CheckpointRecord extends DomainRecord {
  kind: "checkpoint";
  attemptId: string;
  sequence: number;
  state: CheckpointState;
  payloadDigest: string;
  artifactIds: string[];
  verifiedAt?: string;
}

export interface EffectIntentRecord extends DomainRecord {
  kind: "effect_intent";
  jobId: string;
  attemptId: string;
  operation: string;
  operationDigest: string;
  destination: string;
  idempotencyKey: string;
  risk: "low" | "medium" | "high" | "critical";
  state: EffectIntentState;
  approvalId?: string;
  destinationReceipt?: string;
  safeFailureCode?: string;
}

export interface ApprovalRecord extends DomainRecord {
  kind: "approval";
  operationDigest: string;
  scope: string;
  risk: "low" | "medium" | "high" | "critical";
  state: ApprovalState;
  requestedBy: ActorRef;
  requiredActorType: "owner" | "operator" | "policy";
  expiresAt: string;
  decidedBy?: ActorRef;
  decidedAt?: string;
  safeReasonCode?: string;
}

export interface ServiceRecord extends DomainRecord {
  kind: "service";
  projectId: string;
  serviceType: string;
  desiredStateDigest: string;
  state: ServiceState;
  lastObservedAt?: string;
  lastHealthyAt?: string;
  safeStatusCode?: string;
}

export interface ScheduleRecord extends DomainRecord {
  kind: "schedule";
  projectId: string;
  state: ScheduleState;
  scheduleType: "cron" | "interval" | "once";
  expression: string;
  timezone: string;
  targetType: "workflow" | "job" | "service_check";
  targetId: string;
  nextRunAt?: string;
  idempotencyWindowSeconds: number;
}

export interface IncidentRecord extends DomainRecord {
  kind: "incident";
  projectId?: string;
  nodeId?: string;
  severity: "info" | "warning" | "critical";
  state: IncidentState;
  sourceType: string;
  sourceId: string;
  summary: string;
  openedAt: string;
  resolvedAt?: string;
}

export interface ArtifactManifestRecord extends DomainRecord {
  kind: "artifact_manifest";
  projectId: string;
  workflowId?: string;
  jobId: string;
  attemptId: string;
  state: ArtifactState;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  logicalRole: string;
  schemaVersion: string;
  producerId: string;
  storageClass: "local" | "r2" | "repository" | "external";
  opaqueLocator?: string;
  retentionClass: string;
}

export interface NodeRecord extends DomainRecord {
  kind: "node";
  displayName: string;
  state: NodeState;
  platform: "windows" | "macos" | "linux" | "cloud";
  architecture: string;
  identityKeyId: string;
  hardwareFingerprint: string;
  softwareFingerprint: string;
  policyVersion: string;
  minimumProtocolVersion: string;
  enrolledAt?: string;
  lastSeenAt?: string;
  quarantineReasonCode?: string;
}

export interface MessageEnvelope<TBody = unknown> {
  protocol: string;
  messageId: string;
  correlationId: string;
  causationId?: string;
  actorId: string;
  tenantId: string;
  sentAt: string;
  expiresAt: string;
  nonce: string;
  type: string;
  bodyDigest: string;
  body: TBody;
  signature: string;
}

export type DomainEntity =
  | RequestRecord
  | WorkflowRecord
  | JobRecord
  | AttemptRecord
  | LeaseRecord
  | CheckpointRecord
  | EffectIntentRecord
  | ApprovalRecord
  | ServiceRecord
  | ScheduleRecord
  | IncidentRecord
  | ArtifactManifestRecord
  | NodeRecord;
