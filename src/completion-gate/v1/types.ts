export const COMPLETION_GATE_SCHEMA_VERSION_V1 = "control-room-completion-gate/v1" as const;

export type CompletionRiskV1 = "low" | "medium" | "high" | "critical";
export type CompletionTargetKindV1 = "code" | "media" | "document" | "operation";

export interface CompletionPrincipalV1 {
  actorId: string;
  actorType: "human" | "agent" | "service";
  workerId?: string;
  agentProfileId?: string;
  harness?: string;
  modelFamily?: string;
}

export interface CompletionAcceptanceProfileV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  targetKind: CompletionTargetKindV1;
  requiredVerificationScenarioIds: string[];
  minimumIndependentReviews: number;
  reviewerSeparation: {
    actor: boolean;
    worker: boolean;
    agentProfile: boolean;
    harness: boolean;
    modelFamily: boolean;
  };
  verificationRequiresProducerSeparation: boolean;
  minimumRisk: CompletionRiskV1;
  maximumRevisionRounds: number;
  automaticLowRiskDisposition: boolean;
  createdBy: CompletionPrincipalV1;
  createdAt: string;
}

export interface CompletionReviewTargetV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  kind: CompletionTargetKindV1;
  subjectId: string;
  subjectDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
  producer: CompletionPrincipalV1;
  rootTargetId: string;
  revisionNumber: number;
  supersedesTargetId?: string;
  submittedAt: string;
}

export interface CompletionReviewV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  targetId: string;
  targetDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
  reviewer: CompletionPrincipalV1;
  authority: "advisory" | "completion_gate";
  decision: "commented" | "accepted" | "changes_requested" | "rejected";
  assessedRisk: CompletionRiskV1;
  effectiveRisk: CompletionRiskV1;
  evidenceDigests: string[];
  findingIds: string[];
  reviewedAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface CompletionVerificationV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  targetId: string;
  targetDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
  scenarioId: string;
  outcome: "passed" | "failed" | "blocked" | "inconclusive";
  verifier: CompletionPrincipalV1;
  evidenceDigests: string[];
  verifiedAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface CompletionFindingV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  targetId: string;
  targetDigest: string;
  reviewId: string;
  code: string;
  severity: CompletionRiskV1;
  statementDigest: string;
  evidenceDigests: string[];
  raisedAt: string;
}

export interface CompletionRevisionV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  rootTargetId: string;
  fromTargetId: string;
  fromTargetDigest: string;
  toTargetId: string;
  toTargetDigest: string;
  revisionNumber: number;
  resolvedFindingIds: string[];
  revisedBy: CompletionPrincipalV1;
  revisedAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface CompletionPreferenceV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  subjectId: string;
  subjectDigest: string;
  optionDigests: string[];
  selectedOptionDigest: string;
  selectedBy: CompletionPrincipalV1;
  selectedAt: string;
  expiresAt?: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface ConsequentialApprovalRequestV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  operationDigest: string;
  risk: CompletionRiskV1;
  requestedBy: CompletionPrincipalV1;
  requiredFactor: "strong";
  requestedAt: string;
  expiresAt: string;
  grantsExecutionAuthority: false;
}

export interface ConsequentialApprovalDecisionV1 {
  schemaVersion: typeof COMPLETION_GATE_SCHEMA_VERSION_V1;
  id: string;
  tenantId: string;
  projectId: string;
  requestId: string;
  requestDigest: string;
  operationDigest: string;
  policyDecisionId: string;
  decision: "approved" | "denied";
  decidedBy: CompletionPrincipalV1 & { actorType: "human" };
  factor: "strong";
  authenticationEventDigest: string;
  decidedAt: string;
  expiresAt: string;
  safeReasonCode: string;
  grantsExecutionAuthority: false;
  requiresSeparateNodeAttestation: true;
}

export type CompletionGateRecordV1 =
  | CompletionAcceptanceProfileV1
  | CompletionReviewTargetV1
  | CompletionReviewV1
  | CompletionVerificationV1
  | CompletionFindingV1
  | CompletionRevisionV1
  | CompletionPreferenceV1
  | ConsequentialApprovalRequestV1
  | ConsequentialApprovalDecisionV1;

export interface CompletionGateSnapshotV1 {
  target: CompletionReviewTargetV1;
  targetDigest: string;
  status: "pending" | "changes_requested" | "verification_blocked" | "revision_limit_reached" | "ready" | "superseded";
  acceptedReviewIds: string[];
  missingVerificationScenarioIds: string[];
  openFindingIds: string[];
  revisionNumber: number;
  requiresSeparateApproval: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}
