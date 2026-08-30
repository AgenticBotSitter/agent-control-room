import type { CompletionAcceptanceProfileV1 } from "../../../completion-gate/v1";
import type { KnowledgePackageV1, PackageReviewV1, ProcedurePackageV1 } from "../../../package-registry/v1";
import type { ProjectWorkspaceSnapshotV1 } from "../../../project-workspace/v1";

export const WAYFARER_PROJECT_PACK_CONTRACT_V1 = "control-room-wayfarer-project-pack/v1" as const;
export const WAYFARER_PROJECT_ID_V1 = "project:lofi-wayfarer" as const;
export const WAYFARER_WORKSPACE_ID_V1 = "workspace:lofi-wayfarer" as const;
export const WAYFARER_ADAPTER_ID_V1 = "adapter:lofi-wayfarer:v1" as const;

export const WAYFARER_STAGE_IDS_V1 = [
  "model_render_segment",
  "audio_candidate",
  "qc_media_probe",
  "review_cut",
  "assemble_episode",
  "prepare_publication",
] as const;
export type WayfarerStageIdV1 = (typeof WAYFARER_STAGE_IDS_V1)[number];

export type WayfarerArtifactRoleV1 =
  | "source_scene_manifest"
  | "source_audio_brief"
  | "render_segment"
  | "audio_candidate"
  | "qc_report"
  | "review_proxy"
  | "review_manifest"
  | "episode_master"
  | "assembly_manifest"
  | "publication_package";

export interface WayfarerRouteCeilingV1 {
  routeProfileId: string;
  allowedPlatforms: Array<"linux" | "macos" | "windows">;
  gpu: "required" | "optional" | "forbidden";
  minimumMemoryBytes: number;
  minimumScratchBytes: number;
  requiresMeasuredBenchmark: boolean;
  benchmarkEvidenceDigest?: string;
  maximumCostUsd: 0;
  allowsNativeExecution: false;
  allowsProviderCalls: false;
  allowsNetwork: false;
  grantsExecutionAuthority: false;
}

export interface WayfarerStageDefinitionV1 {
  stageId: WayfarerStageIdV1;
  label: string;
  inputArtifactRoles: WayfarerArtifactRoleV1[];
  outputArtifactRoles: WayfarerArtifactRoleV1[];
  completionProfileId: string;
  completionProfileDigest: string;
  requiresAcceptedReviewOfStageIds: WayfarerStageIdV1[];
  route: WayfarerRouteCeilingV1;
  syntheticImplementationAllowed: true;
  liveImplementationAllowed: false;
  createsEffectIntent: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface WayfarerGraphEdgeV1 {
  fromStageId: WayfarerStageIdV1;
  toStageId: WayfarerStageIdV1;
}

export interface WayfarerArtifactDefinitionV1 {
  role: WayfarerArtifactRoleV1;
  origin: "source_input" | "generated";
  kind: "media" | "document" | "manifest";
  allowedContentTypes: string[];
  maximumBytes: number;
  retentionClassId: string;
  immutable: true;
  digestRequired: true;
  bytesEmbeddedInControlPlane: false;
  locatorStoredInPack: false;
  quarantineOnFailedVerification: boolean;
  grantsAuthority: false;
}

export interface WayfarerRetentionClassV1 {
  retentionClassId: string;
  retainForDays: number;
  clockStartsOn: "artifact_created" | "completion_accepted" | "project_closed";
  deletionMode: "owner_reviewed_proposal_only";
  quarantineForDays: number;
  legalHoldWins: true;
  automaticDeletionEnabled: false;
  grantsDeletionAuthority: false;
}

export interface WayfarerQcRuleV1 {
  ruleId: string;
  scenarioId: string;
  appliesToArtifactRoles: WayfarerArtifactRoleV1[];
  severity: "medium" | "high";
  failureDisposition: "block_completion_and_quarantine";
  requiresIndependentEvidence: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface WayfarerAcceptanceProfileBindingV1 {
  profile: CompletionAcceptanceProfileV1;
  profileDigest: string;
}

export interface WayfarerProjectPackV1 {
  contractVersion: typeof WAYFARER_PROJECT_PACK_CONTRACT_V1;
  packId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  workspace: ProjectWorkspaceSnapshotV1;
  workspaceDigest: string;
  stages: WayfarerStageDefinitionV1[];
  edges: WayfarerGraphEdgeV1[];
  artifacts: WayfarerArtifactDefinitionV1[];
  retentionClasses: WayfarerRetentionClassV1[];
  qcRules: WayfarerQcRuleV1[];
  acceptanceProfiles: WayfarerAcceptanceProfileBindingV1[];
  procedure: ProcedurePackageV1;
  procedureDigest: string;
  procedureReview: PackageReviewV1;
  knowledge: KnowledgePackageV1;
  knowledgeDigest: string;
  knowledgeReview: PackageReviewV1;
  maximumPreStartRetries: 1;
  automaticPostMarkerRetryAllowed: false;
  ambiguousOutcomeRequiresReconciliation: true;
  syntheticOnly: true;
  unrealEligible: false;
  requiresMeasuredUnrealBenchmark: true;
  credentialsReferenceDigests: [];
  allowsNativeExecution: false;
  allowsProviderCalls: false;
  allowsNetwork: false;
  allowsObjectStorage: false;
  allowsUpload: false;
  allowsPublication: false;
  grantsApproval: false;
  grantsDeletionAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  packDigest: string;
}

export interface WayfarerProjectPackInputV1 {
  tenantId: string;
  workspaceId: typeof WAYFARER_WORKSPACE_ID_V1;
  projectId: typeof WAYFARER_PROJECT_ID_V1;
  adapterId: typeof WAYFARER_ADAPTER_ID_V1;
  producerId: string;
  reviewerId: string;
  sourceDigest: string;
  reviewEvidenceDigest: string;
  createdAt: string;
  reviewedAt: string;
}

export const WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1 = "control-room-wayfarer-synthetic-workflow/v1" as const;

export interface WayfarerSyntheticArtifactV1 {
  contractVersion: typeof WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1;
  artifactId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packDigest: string;
  episodeId: string;
  role: WayfarerArtifactRoleV1;
  contentType: string;
  contentDigest: string;
  inputArtifactDigests: string[];
  producedByStageId?: WayfarerStageIdV1;
  observedByteCount: 0;
  mediaMaterialPresent: false;
  synthetic: true;
  externalEffectOccurred: false;
  grantsAuthority: false;
  createdAt: string;
  artifactDigest: string;
}

export interface WayfarerSyntheticStagePlanV1 {
  stageId: WayfarerStageIdV1;
  stageDigest: string;
  proposedJobId: string;
  prerequisiteStageIds: WayfarerStageIdV1[];
  requiredInputRoles: WayfarerArtifactRoleV1[];
  expectedOutputRoles: WayfarerArtifactRoleV1[];
  requiresAcceptedReviewOfStageIds: WayfarerStageIdV1[];
  createsCanonicalJob: false;
  canDispatch: false;
  canExecute: false;
}

export interface WayfarerSyntheticWorkflowPlanV1 {
  contractVersion: typeof WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1;
  planId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packId: string;
  packDigest: string;
  episodeId: string;
  sourceArtifactDigests: string[];
  stages: WayfarerSyntheticStagePlanV1[];
  compiledAt: string;
  syntheticOnly: true;
  createsCanonicalJobs: false;
  createsLeases: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  planDigest: string;
}

export interface WayfarerSyntheticQcResultV1 {
  ruleId: string;
  scenarioId: string;
  outcome: "synthetic_pass";
  evidenceDigest: string;
  independentEvidenceRequiredForCompletion: true;
  qualifiesCompletion: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface WayfarerSyntheticStageReceiptV1 {
  contractVersion: typeof WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  packDigest: string;
  planId: string;
  planDigest: string;
  episodeId: string;
  stageId: WayfarerStageIdV1;
  stageDigest: string;
  inputArtifactDigests: string[];
  outputArtifacts: WayfarerSyntheticArtifactV1[];
  prerequisiteEvidenceDigests: string[];
  qcResults: WayfarerSyntheticQcResultV1[];
  executedAt: string;
  synthetic: true;
  mediaToolInvoked: false;
  providerInvoked: false;
  networkUsed: false;
  objectStorageUsed: false;
  bytesMaterialized: false;
  createsCompletionRecord: false;
  completionCandidateOnly: true;
  externalEffectOccurred: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface WayfarerSyntheticPrerequisiteEvidenceV1 {
  contractVersion: typeof WAYFARER_SYNTHETIC_WORKFLOW_CONTRACT_V1;
  evidenceId: string;
  tenantId: string;
  projectId: string;
  packDigest: string;
  planDigest: string;
  stageId: WayfarerStageIdV1;
  stageReceiptDigest: string;
  acceptedForSimulation: true;
  authoritativeCompletionResolution: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  recordedAt: string;
  evidenceDigest: string;
}
