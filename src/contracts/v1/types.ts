export const CONTRACT_VERSION = "control-room-project-adapter/v1" as const;

export const normalizedStates = [
  "planned",
  "ready",
  "running",
  "waiting",
  "blocked",
  "needs_attention",
  "review",
  "complete",
  "failed",
  "cancelled",
] as const;

export type NormalizedState = (typeof normalizedStates)[number];

export const authorityModes = [
  "control_room_native",
  "source_scheduled",
  "advisory",
] as const;

export type AuthorityMode = (typeof authorityModes)[number];

export const allocationModes = [
  "exclusive",
  "preferred",
  "shared",
  "opportunistic",
  "manual",
] as const;

export type AllocationMode = (typeof allocationModes)[number];

export const workerStates = [
  "online",
  "idle",
  "busy",
  "draining",
  "degraded",
  "offline",
  "maintenance",
] as const;

export type WorkerState = (typeof workerStates)[number];

export interface SourceReference {
  sourceSystem: string;
  adapterId: string;
  adapterVersion: typeof CONTRACT_VERSION;
  workspaceId: string;
  projectId: string;
  recordType: string;
  recordId: string;
  sourceVersion: string;
  sourceChecksum?: string;
  observedAt: string;
}

export interface ProjectManifest {
  contractVersion: typeof CONTRACT_VERSION;
  adapterId: string;
  sourceSystem: string;
  authorityMode: AuthorityMode;
  projectTypes: string[];
  supportedReadOperations: ReadOperation[];
  supportedCommands: CommandName[];
  changeFeed: {
    cursorType: "opaque";
    retentionDays: number;
  };
  redactionPolicyVersion: string;
}

export type ReadOperation =
  | "getProjectSummary"
  | "listWorkItems"
  | "listExecutions"
  | "listBlockers"
  | "listWorkers"
  | "listAttentionItems"
  | "readChanges";

export type CommandName =
  | "requestRetry"
  | "setPriority"
  | "setWorkerPreference"
  | "pauseProjectOrWork"
  | "resumeProjectOrWork"
  | "recordDecision";

export interface ProjectSummaryProjection {
  id: string;
  source: SourceReference;
  workspaceName: string;
  title: string;
  description?: string;
  deepLink?: string;
  normalizedState: NormalizedState;
  domainState: string;
  health: "healthy" | "watch" | "at_risk" | "blocked";
  progressPercent?: number;
  forecastAt?: string;
  attentionCount: number;
  blockerCount: number;
  priority: number;
  authorityMode: AuthorityMode;
}

export interface PlacementPolicy {
  mode: AllocationMode;
  preferredWorkerIds?: string[];
  avoidedWorkerIds?: string[];
  allowedRouteIds?: string[];
  pinnedWorkerId?: string;
  maxCostUsd?: number;
  deadlineAt?: string;
  allowPaidProvider?: boolean;
  allowQualityFallback?: boolean;
}

export interface WorkItemProjection {
  id: string;
  source: SourceReference;
  title: string;
  deepLink?: string;
  normalizedState: NormalizedState;
  domainState: string;
  priority: number;
  progressPercent?: number;
  requiredCapability?: string;
  currentWorkerId?: string;
  currentAgentId?: string;
  placementPolicy?: PlacementPolicy;
  blockedByIds?: string[];
  downstreamUnlockCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionProjection {
  id: string;
  source: SourceReference;
  workItemId: string;
  attempt: number;
  state: "queued" | "leased" | "running" | "paused" | "succeeded" | "failed";
  workerId?: string;
  agentId?: string;
  routeId?: string;
  progressPercent?: number;
  leaseObservedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  safeFailureCode?: string;
}

export interface BlockerProjection {
  id: string;
  source: SourceReference;
  workItemId?: string;
  type: string;
  title: string;
  severity: "info" | "warning" | "critical";
  responsibleRole: "system" | "operator" | "customer" | "project" | "provider";
  safeRemedy?: string;
  deepLink?: string;
  openedAt: string;
}

export interface AttentionProjection {
  id: string;
  source: SourceReference;
  workItemId?: string;
  type: "approval" | "question" | "review" | "decision";
  title: string;
  summary: string;
  deepLink?: string;
  dueAt?: string;
  createdAt: string;
}

export interface CapabilityRoute {
  id: string;
  capability: string;
  runtime: string;
  workerId: string;
  verification: "verified" | "provisional" | "expired" | "unavailable";
  estimatedDurationMinutes?: number;
  estimatedCostUsd?: number;
  qualityClass?: string;
  privacyClass?: "local" | "approved_provider" | "restricted";
  benchmarkVersion?: string;
  benchmarkObservedAt?: string;
}

export interface WorkerProjection {
  id: string;
  source?: SourceReference;
  displayName: string;
  machineId: string;
  runtimeId: string;
  nodeId: string;
  nodeVersion: number;
  nodeState: "active" | "draining" | "offline" | "quarantined" | "revoked";
  os: "windows" | "macos" | "linux" | "cloud";
  state: WorkerState;
  stateReason?: string;
  lastHeartbeatAt: string;
  availableSlots: number;
  totalSlots: number;
  scratchClass: "healthy" | "caution" | "low" | "critical";
  allocationMode: AllocationMode;
  preferredProjectIds?: string[];
  capabilities: CapabilityRoute[];
  currentWorkItemIds?: string[];
}

export interface AgentProjection {
  id: string;
  displayName: string;
  agentType: "hermes" | "manager" | "human" | "service";
  state: "available" | "working" | "waiting" | "offline";
  projectIds: string[];
  allowedActions: string[];
  currentWorkItemId?: string;
  lastSeenAt: string;
}

export interface ChangeEnvelope {
  cursor: string;
  sequence: number;
  occurredAt: string;
  operation: "upsert" | "remove";
  recordKind:
    | "project"
    | "work_item"
    | "execution"
    | "blocker"
    | "attention"
    | "worker"
    | "agent";
  recordId: string;
  sourceVersion: string;
  payload?: unknown;
}

export interface ChangePage {
  contractVersion: typeof CONTRACT_VERSION;
  adapterId: string;
  afterCursor?: string;
  nextCursor: string;
  hasMore: boolean;
  changes: ChangeEnvelope[];
}

export interface CommandRequest<TPayload = Record<string, unknown>> {
  contractVersion: typeof CONTRACT_VERSION;
  command: CommandName;
  adapterId: string;
  workspaceId: string;
  projectId: string;
  targetId: string;
  expectedVersion?: string;
  idempotencyKey: string;
  reason: string;
  requestedBy: {
    actorId: string;
    actorType: "human" | "agent" | "service";
  };
  payload: TPayload;
}

export interface CommandReceipt {
  contractVersion: typeof CONTRACT_VERSION;
  receiptId: string;
  idempotencyKey: string;
  sourceCommandId?: string;
  status: "accepted" | "rejected" | "already_applied" | "scheduled";
  appliedVersion?: string;
  safeReasonCode?: string;
  message: string;
  receivedAt: string;
  completedAt?: string;
}

export interface ProjectionFixturePack {
  manifest: ProjectManifest;
  projects: ProjectSummaryProjection[];
  workItems: WorkItemProjection[];
  executions: ExecutionProjection[];
  blockers: BlockerProjection[];
  attentionItems: AttentionProjection[];
  workers: WorkerProjection[];
  agents: AgentProjection[];
  changes: ChangeEnvelope[];
}
