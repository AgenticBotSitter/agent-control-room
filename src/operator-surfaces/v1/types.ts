export const OPERATOR_SURFACES_CONTRACT_V1 = "control-room-operator-surfaces/v1" as const;

export const attentionKinds = [
  "approval",
  "question",
  "review",
  "failure",
  "ambiguity",
  "incident",
  "authority_expiry",
  "native_session",
] as const;
export type AttentionKindV1 = (typeof attentionKinds)[number];

export const attentionStates = ["open", "resolved", "expired"] as const;
export type AttentionStateV1 = (typeof attentionStates)[number];

export const attentionDeliveryStates = ["not_requested", "pending", "delivered", "failed"] as const;
export type AttentionDeliveryStateV1 = (typeof attentionDeliveryStates)[number];

export const legalResponseKinds = [
  "record_decision",
  "request_review",
  "request_retry",
  "approve_exact_operation",
  "decline",
  "open_source",
] as const;
export type LegalResponseKindV1 = (typeof legalResponseKinds)[number];

export interface AttentionEvidenceReferenceV1 {
  id: string;
  kind: "artifact" | "verification" | "audit" | "incident" | "service_observation";
  digest?: string;
  observedAt?: string;
}

/** A listed response is a constrained option, never proof that an operation was performed. */
export interface LegalResponseV1 {
  id: string;
  kind: LegalResponseKindV1;
  label: string;
  requiresConfirmation: boolean;
  available: boolean;
  unavailableReasonCode?: string;
}

/** The canonical cross-harness unit of owner attention. */
export interface ActionInboxItemV1 {
  id: string;
  tenantId: string;
  projectId?: string;
  workItemId?: string;
  kind: AttentionKindV1;
  state: AttentionStateV1;
  requestedAction: string;
  reasonCode: string;
  blockedWorkItemIds: string[];
  legalResponses: LegalResponseV1[];
  evidence: AttentionEvidenceReferenceV1[];
  createdAt: string;
  expiresAt?: string;
  deliveryState: AttentionDeliveryStateV1;
}

export interface FleetWorkerSummaryV1 {
  workerId: string;
  platform: "macos" | "windows" | "linux" | "cloud";
  state: "online" | "idle" | "busy" | "draining" | "degraded" | "offline" | "maintenance";
  stateReasonCode?: string;
  lastObservedAt: string;
  capacityState: "reported" | "unavailable";
  availableSlots?: number;
  totalSlots?: number;
  capabilityState: "verified" | "provisional" | "expired" | "unavailable";
  telemetryState: "fresh" | "stale" | "missing";
}

export interface BottleneckProjectionV1 {
  resourceKey: string;
  utilizationPercent: number;
  blockedWorkItemIds: string[];
  explanation: string;
}

/** Redacted durable incident facts. A remedy code is guidance, never a repair request. */
export interface ServiceIncidentProjectionV1 {
  id: string;
  serviceId: string;
  severity: "warning" | "critical";
  state: "open" | "resolved";
  reasonCode: string;
  remedyCode: string;
  openedAt: string;
  lastObservedAt: string;
  resolvedAt?: string;
}

/** Redacted active job facts. This is state observation, not a claim that a job will complete. */
export interface ActiveWorkProjectionV1 {
  jobId: string;
  projectId: string;
  state: "leased" | "running" | "waiting_approval";
  jobType: string;
  priority: number;
  requiredCapability: string;
  updatedAt: string;
}

/** Read-only service health facts. Desired-state hashes and service control are deliberately excluded. */
export interface ServiceProjectionV1 {
  serviceId: string;
  projectId: string;
  serviceType: string;
  state: "active" | "degraded" | "paused" | "failed" | "retired";
  statusCode?: string;
  lastObservedAt?: string;
  lastHealthyAt?: string;
}

/** Read-only schedule status. The schedule expression and any dispatch authority stay server-side. */
export interface ScheduleProjectionV1 {
  scheduleId: string;
  projectId: string;
  state: "active" | "paused" | "disabled";
  scheduleType: "cron" | "interval" | "once";
  targetType: "workflow" | "job" | "service_check";
  targetId: string;
  timezone: string;
  nextRunAt?: string;
  idempotencyWindowSeconds: number;
}

/** Redacted portfolio health derived from canonical workflows and jobs, never from a demo-progress estimate. */
export interface PortfolioProjectProjectionV1 {
  projectId: string;
  workflowCount: number;
  activeJobCount: number;
  waitingApprovalJobCount: number;
  failedJobCount: number;
  lastActivityAt: string;
}

/** A human priority projection. It is intentionally separate from scheduling policy and authority. */
export interface OwnerFocusPinV1 {
  id: string;
  tenantId: string;
  projectId: string;
  level: "p0" | "today";
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

/** Command shape only. It records owner intent and cannot authorize, reserve, or dispatch work. */
export interface OwnerFocusCommandV1 {
  contractVersion: typeof OPERATOR_SURFACES_CONTRACT_V1;
  commandId: string;
  tenantId: string;
  operation: "set_owner_focus" | "clear_owner_focus";
  projectId: string;
  idempotencyKey: string;
  requestedAt: string;
  level?: "p0" | "today";
  reason?: string;
}

/** Scheduler-visible metadata only; it cannot alter feasibility, authority, capacity, or fair-share policy. */
export interface OwnerFocusSchedulerProjectionV1 {
  projectId: string;
  level: "p0" | "today";
  reasonCode: "owner_focus";
  canOverrideFairness: false;
  canOverrideAuthority: false;
  canReserveCapacity: false;
}

export interface ActionInboxFilterV1 {
  projectId?: string;
  kinds?: AttentionKindV1[];
  states?: AttentionStateV1[];
  includeExpired?: boolean;
  now: string;
  limit: number;
}

export interface OperatorSurfaceSnapshotV1 {
  contractVersion: typeof OPERATOR_SURFACES_CONTRACT_V1;
  tenantId: string;
  generatedAt: string;
  fleet: FleetWorkerSummaryV1[];
  bottlenecks: BottleneckProjectionV1[];
  activeWork: ActiveWorkProjectionV1[];
  portfolio: PortfolioProjectProjectionV1[];
  services: ServiceProjectionV1[];
  schedules: ScheduleProjectionV1[];
  serviceIncidents: ServiceIncidentProjectionV1[];
  actionInbox: ActionInboxItemV1[];
  ownerFocus: OwnerFocusPinV1[];
}
