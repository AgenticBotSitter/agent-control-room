export const COMPLETION_FLOW_CONTRACT_V1 = "control-room-completion-flow/v1" as const;

export type CompletionFlowExecutionPhaseV1 = "initial" | "revision";

/**
 * Digest-only observation of one synthetic execution. The observation is
 * evidence about an effect-free run; it is never an admission or authority.
 */
export interface EffectFreeExecutionObservationV1 {
  contractVersion: typeof COMPLETION_FLOW_CONTRACT_V1;
  phase: CompletionFlowExecutionPhaseV1;
  executionId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  localPolicyRequestId: string;
  localPolicyRequestDigest: string;
  operationDigest: string;
  authorityDigest: string;
  artifactId: string;
  artifactContentHash: string;
  artifactManifestDigest: string;
  producerClaimDigest: string;
  artifactLineageDigest: string;
  secretReceiptDigest?: string;
  completedAt: string;
  executionKind: "synthetic";
  externalEffect: false;
  networkUsed: false;
  nativeProcessUsed: false;
  liveProviderUsed: false;
  approvalDecisionConsumed: false;
  nodeApprovalAttestationPresent: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  observationDigest: string;
}

/**
 * Safe, digest-only receipt for the complete question-to-revision flow.
 * Component ledgers remain the systems of record; this receipt proves their
 * exact lineage without combining their separate authorities.
 */
export interface CompletionFlowReceiptV1 {
  contractVersion: typeof COMPLETION_FLOW_CONTRACT_V1;
  workflowId: string;
  tenantId: string;
  projectId: string;
  questionAttentionId: string;
  questionAttentionDigest: string;
  resolvedAttentionDigest: string;
  messagePlanId: string;
  messagePlanDigest: string;
  presentationId: string;
  presentationDigest: string;
  callbackId: string;
  callbackRecordDigest: string;
  responseProposalId: string;
  responseProposalDigest: string;
  selectedOptionDigest: string;
  preferenceId: string;
  preferenceDigest: string;
  approvalRequestId: string;
  approvalRequestDigest: string;
  approvalDecisionId: string;
  approvalDecisionDigest: string;
  approvedOperationDigest: string;
  approvedOperationDisposition: "approved_not_executed";
  credentialCatalogEntryDigest: string;
  secretGrantDigest: string;
  secretReceiptDigest: string;
  initialExecutionObservationDigest: string;
  revisionExecutionObservationDigest: string;
  acceptanceProfileId: string;
  acceptanceProfileDigest: string;
  initialTargetId: string;
  initialTargetDigest: string;
  initialReviewId: string;
  initialReviewDigest: string;
  initialFindingIds: string[];
  revisionId: string;
  revisionDigest: string;
  revisedTargetId: string;
  revisedTargetDigest: string;
  revisedVerificationIds: string[];
  finalReviewId: string;
  finalReviewDigest: string;
  finalSnapshotDigest: string;
  finalStatus: "ready";
  completedAt: string;
  liveEffectsPerformed: false;
  approvedOperationExecuted: false;
  productionCredentialMaterialPersisted: false;
  nodeApprovalAttestationPresent: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}
