import type {
  ReadyFrontierCanonicalWorkTruthV1,
  ReadyFrontierCandidateV1,
  ReadyFrontierDependencyTruthV1,
  ReadyFrontierDispositionOutcomeV1,
  ReadyFrontierPlatformV1,
  ReadyFrontierPolicyV1,
  ReadyFrontierProjectSourceV1,
  ReadyFrontierReasonCodeV1,
  ReadyFrontierRiskClassV1,
  ReadyFrontierRouteSourceV1,
} from "./types";

export const READY_FRONTIER_CANONICAL_READ_V1 = "control-room-ready-frontier-canonical-read/v1" as const;
export const READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1 = "control-room-ready-frontier-manual-cycle-request/v1" as const;
export const READY_FRONTIER_MANUAL_CYCLE_RESULT_V1 = "control-room-ready-frontier-manual-cycle-result/v1" as const;
export const READY_FRONTIER_CYCLE_PROJECTION_V1 = "control-room-ready-frontier-cycle-projection/v1" as const;

export type ReadyFrontierCanonicalReadChannelV1 = "projects" | "work" | "attention" | "capacity";

export type ReadyFrontierCandidateReadV1 = Omit<ReadyFrontierCandidateV1, "reviewTruth" | "blockerCodes">;

export interface ReadyFrontierAttentionReadV1 {
  candidateId: string;
  projectId: string;
  reviewTruth: ReadyFrontierCandidateV1["reviewTruth"];
  blockerCodes: string[];
  observedAt: string;
  evidenceDigest: string;
}

interface ReadyFrontierCanonicalReadBaseV1 {
  schema: typeof READY_FRONTIER_CANONICAL_READ_V1;
  channel: ReadyFrontierCanonicalReadChannelV1;
  readGroupId: string;
  tenantId: string;
  revision: number;
  observedAt: string;
  projectIds: string[];
  retainsRawInputContent: false;
  retainsUsableAccessData: false;
  retainsPrivateLocators: false;
  payloadDigest: string;
  readDigest: string;
  readAuthTag: string;
}

export interface ReadyFrontierProjectCanonicalReadV1 extends ReadyFrontierCanonicalReadBaseV1 {
  channel: "projects";
  payload: { projects: ReadyFrontierProjectSourceV1[] };
}

export interface ReadyFrontierWorkCanonicalReadV1 extends ReadyFrontierCanonicalReadBaseV1 {
  channel: "work";
  payload: {
    candidates: ReadyFrontierCandidateReadV1[];
    canonicalWork: ReadyFrontierCanonicalWorkTruthV1[];
    dependencyTruth: ReadyFrontierDependencyTruthV1[];
  };
}

export interface ReadyFrontierAttentionCanonicalReadV1 extends ReadyFrontierCanonicalReadBaseV1 {
  channel: "attention";
  payload: { attention: ReadyFrontierAttentionReadV1[] };
}

export interface ReadyFrontierCapacityCanonicalReadV1 extends ReadyFrontierCanonicalReadBaseV1 {
  channel: "capacity";
  payload: { routes: ReadyFrontierRouteSourceV1[] };
}

export type ReadyFrontierCanonicalReadV1 =
  | ReadyFrontierProjectCanonicalReadV1
  | ReadyFrontierWorkCanonicalReadV1
  | ReadyFrontierAttentionCanonicalReadV1
  | ReadyFrontierCapacityCanonicalReadV1;

export type ReadyFrontierUnsignedCanonicalReadV1 =
  | Omit<ReadyFrontierProjectCanonicalReadV1, "payloadDigest" | "readDigest" | "readAuthTag">
  | Omit<ReadyFrontierWorkCanonicalReadV1, "payloadDigest" | "readDigest" | "readAuthTag">
  | Omit<ReadyFrontierAttentionCanonicalReadV1, "payloadDigest" | "readDigest" | "readAuthTag">
  | Omit<ReadyFrontierCapacityCanonicalReadV1, "payloadDigest" | "readDigest" | "readAuthTag">;

export interface ReadyFrontierReadRequestV1 {
  readGroupId: string;
  tenantId: string;
  revision: number;
  observedAt: string;
  projectIds: string[];
  readOnly: true;
  permitsMutation: false;
  permitsNetworkDiscovery: false;
}

export interface ReadyFrontierCanonicalReadPortsV1 {
  readProjects(input: ReadyFrontierReadRequestV1): Promise<unknown> | unknown;
  readWork(input: ReadyFrontierReadRequestV1): Promise<unknown> | unknown;
  readAttention(input: ReadyFrontierReadRequestV1): Promise<unknown> | unknown;
  readCapacity(input: ReadyFrontierReadRequestV1): Promise<unknown> | unknown;
}

export interface ReadyFrontierManualCycleRequestV1 {
  schema: typeof READY_FRONTIER_MANUAL_CYCLE_REQUEST_V1;
  requestId: string;
  cycleId: string;
  readGroupId: string;
  tenantId: string;
  sourceRevision: number;
  historyRevision: number;
  sourceObservedAt: string;
  evaluatedAt: string;
  projectIds: string[];
  manualTrigger: true;
  scheduleId: null;
  permitsAutomaticRun: false;
  permitsCanonicalWorkCreation: false;
  permitsApproval: false;
  permitsReadyTransition: false;
  permitsClaimOrLease: false;
  permitsDispatchOrExecution: false;
  permitsProviderContact: false;
  permitsExternalEffects: false;
}

export interface ReadyFrontierManualCycleResultV1 {
  schema: typeof READY_FRONTIER_MANUAL_CYCLE_RESULT_V1;
  requestId: string;
  cycleId: string;
  tenantId: string;
  sourceDigest: string;
  evaluationDigest: string;
  projectionDigest: string;
  replayed: boolean;
  proposalCount: number;
  evaluatedAt: string;
  manualTrigger: true;
  scheduled: false;
  createdCanonicalWork: false;
  grantedApproval: false;
  grantedReadyTransition: false;
  createdClaimOrLease: false;
  dispatchedOrExecuted: false;
  contactedProvider: false;
  performedExternalEffect: false;
  resultDigest: string;
}

export interface ReadyFrontierCycleProposalViewV1 {
  itemId: string;
  proposalId: string;
  title: string;
  routeId: string;
  platform: ReadyFrontierPlatformV1;
  risk: ReadyFrontierRiskClassV1;
  estimatedCostMicrousd: number;
  priority: number;
  rank: number;
  ownerReviewState: "required_not_requested";
  reasonCodes: ReadyFrontierReasonCodeV1[];
}

export interface ReadyFrontierCycleGateViewV1 {
  itemId: string;
  outcome: Exclude<ReadyFrontierDispositionOutcomeV1, "proposed">;
  label: string;
  reasonCodes: ReadyFrontierReasonCodeV1[];
}

export interface ReadyFrontierCycleProjectViewV1 {
  projectId: string;
  proposed: ReadyFrontierCycleProposalViewV1[];
  blocked: ReadyFrontierCycleGateViewV1[];
  needsReview: ReadyFrontierCycleGateViewV1[];
  deferred: ReadyFrontierCycleGateViewV1[];
  suppressedCount: number;
}

export interface ReadyFrontierCycleProjectionV1 {
  schema: typeof READY_FRONTIER_CYCLE_PROJECTION_V1;
  cycleId: string;
  tenantId: string;
  sourceSnapshotId: string;
  evaluatedAt: string;
  projects: ReadyFrontierCycleProjectViewV1[];
  proposalCount: number;
  blockedCount: number;
  needsReviewCount: number;
  deferredCount: number;
  suppressedCount: number;
  proposalOnly: true;
  ownerReviewRequired: true;
  canMaterializeCanonicalWork: false;
  canApprove: false;
  canReady: false;
  canClaimOrLease: false;
  canDispatchOrExecute: false;
  canContactProvider: false;
  canPerformExternalEffect: false;
  projectionDigest: string;
}

export interface ReadyFrontierIntegrationFixtureV1 {
  request: ReadyFrontierManualCycleRequestV1;
  policy: ReadyFrontierPolicyV1;
  ports: ReadyFrontierCanonicalReadPortsV1;
}
