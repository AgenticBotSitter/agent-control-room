import type { ProjectWorkspaceSnapshotV1 } from "../../../project-workspace/v1";
import type { JobRecord, RequestRecord, ScheduleRecord, WorkflowRecord } from "../../../domain/v1";
import type { ActionInboxItemV1, ScheduleProjectionV1 } from "../../../operator-surfaces/v1";

export const ABS_NEWS_CONTRACT_V1 = "control-room-abs-news/v1" as const;
export const ABS_NEWS_PROJECT_ID_V1 = "project.abs.ai-tech-news" as const;
export const ABS_NEWS_WORKSPACE_ID_V1 = "workspace.abs.news" as const;
export const ABS_NEWS_ADAPTER_ID_V1 = "adapter.abs-news.v1" as const;

export const ABS_NEWS_ACTION_IDS_V1 = [
  "research_brief",
  "setup_guide",
  "product_comparison",
  "tool_evaluation",
  "abs_article_draft",
  "newsletter_draft",
  "social_draft",
  "monitor_updates",
] as const;

export type AbsNewsActionIdV1 = (typeof ABS_NEWS_ACTION_IDS_V1)[number];
export type AbsNewsSourceKindV1 = "rss" | "atom" | "sitemap" | "news_search" | "newsletter" | "manual";
export type AbsNewsQueueV1 = "important_now" | "earlier" | "archive";
export type AbsNewsPlatformV1 = "any" | "macos" | "windows" | "linux" | "cloud";
export type AbsNewsDeliverableKindV1 = "report" | "setup_guide" | "comparison" | "evaluation" | "article_draft" | "newsletter_draft" | "social_draft" | "monitor_plan";
export type AbsNewsReasoningProfileV1 = "research_deep" | "implementation_balanced" | "editorial_balanced" | "monitoring_bounded";

export interface AbsNewsSourceEvidenceV1 {
  evidenceId: string;
  sourceId: string;
  sourceKind: AbsNewsSourceKindV1;
  sourceLabel: string;
  canonicalUrl: string;
  observedAt: string;
  evidenceDigest: string;
  containsRawNewsletterBody: false;
  grantsNetworkAuthority: false;
}

export interface AbsNewsStoryV1 {
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  storyId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  clusterId: string;
  queue: AbsNewsQueueV1;
  title: string;
  summary: string;
  canonicalUrl: string;
  canonicalHost: string;
  sourceLabel: string;
  publishedAt?: string;
  discoveredAt: string;
  lastVerifiedAt: string;
  verificationState: "verified" | "review_only";
  priorityScore: number;
  coverageCount: number;
  sourceEvidence: AbsNewsSourceEvidenceV1[];
  contentDigest: string;
  containsRawNewsletterBody: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  storyDigest: string;
}

export interface AbsNewsActionTemplateV1 {
  actionId: AbsNewsActionIdV1;
  label: string;
  deliverableKind: AbsNewsDeliverableKindV1;
  routeProfileId: string;
  requiredCapability: string;
  allowedPlatforms: AbsNewsPlatformV1[];
  risk: "low" | "medium";
  reasoningProfile: AbsNewsReasoningProfileV1;
  effortHint: "medium" | "high";
  requiresOwnerReview: true;
  createsProposalOnly: true;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface AbsNewsWorkOrderProposalV1 {
  verificationFirst?: true;
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  proposalId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  storyId: string;
  storyDigest: string;
  actionId: AbsNewsActionIdV1;
  actionCatalogDigest: string;
  requestedTitle: string;
  goal: string;
  deliverableKind: AbsNewsDeliverableKindV1;
  routeProfileId: string;
  requiredCapability: string;
  requestedPlatform: AbsNewsPlatformV1;
  risk: "low" | "medium";
  reasoningProfile: AbsNewsReasoningProfileV1;
  effortHint: "medium" | "high";
  sourceEvidenceDigests: string[];
  sourceUrls: string[];
  requestedByActorDigest: string;
  requestedAt: string;
  proposalIdempotencyKey: string;
  status: "draft";
  requiresOwnerReview: true;
  createsWorkItem: false;
  dispatchState: "not_requested";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  proposalDigest: string;
}

export interface AbsNewsSyntheticWorkspaceV1 {
  workspace: ProjectWorkspaceSnapshotV1;
  stories: AbsNewsStoryV1[];
  actionCatalog: AbsNewsActionTemplateV1[];
  actionCatalogDigest: string;
}

export interface AbsNewsCollectedItemV1 {
  collectionItemId: string;
  sourceId: string;
  sourceKind: "rss" | "sitemap" | "newsletter";
  sourceLabel: string;
  title: string;
  summary: string;
  discoveredUrl: string;
  publishedAt?: string;
  observedAt: string;
  directlyVerified: boolean;
  contentDigest: string;
  containsRawNewsletterBody: false;
  grantsNetworkAuthority: false;
}

export interface AbsNewsFakeCollectionBatchV1 {
  batchId: string;
  sourceId: string;
  sourceKind: "rss" | "sitemap" | "newsletter";
  sourceLabel: string;
  collectedAt: string;
  items: AbsNewsCollectedItemV1[];
  synthetic: true;
  networkUsed: false;
  grantsNetworkAuthority: false;
}

export interface AbsNewsCollectionResultV1 {
  stories: AbsNewsStoryV1[];
  batchDigests: string[];
  inputItemCount: number;
  clusterCount: number;
  duplicateCount: number;
  verifiedCount: number;
  reviewOnlyCount: number;
  collectedAt: string;
  synthetic: true;
  networkUsed: false;
  grantsNetworkAuthority: false;
  resultDigest: string;
}

export interface AbsNewsQueueHistoryV1 {
  eventId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  storyId: string;
  priorStoryDigest: string;
  nextStoryDigest: string;
  fromQueue: AbsNewsQueueV1;
  toQueue: AbsNewsQueueV1;
  changedByActorDigest: string;
  changedAt: string;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  eventDigest: string;
}

export interface AbsNewsFakeIngestionReceiptV1 {
  resultDigest: string;
  batchDigests: string[];
  insertedStoryCount: number;
  replayedStoryCount: number;
  sourceStatusCount: number;
  collectedAt: string;
  synthetic: true;
  networkUsed: false;
  createsWorkItem: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface AbsNewsProposalReviewV1 {
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  reviewId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  proposalId: string;
  proposalDigest: string;
  storyId: string;
  storyDigest: string;
  actionCatalogDigest: string;
  decision: "accepted" | "rejected";
  safeReasonCode: string;
  reviewerActorDigest: string;
  reviewedAt: string;
  grantsApproval: false;
  grantsDispatchAuthority: false;
  grantsExecutionAuthority: false;
  reviewDigest: string;
}

export interface AbsNewsMaterializationReceiptV1 {
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  receiptId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  proposalId: string;
  proposalDigest: string;
  acceptedReviewId: string;
  acceptedReviewDigest: string;
  request: RequestRecord;
  workflow: WorkflowRecord;
  job: JobRecord;
  materializedAt: string;
  state: "materialized_proposed";
  createsAttempt: false;
  createsLease: false;
  dispatchState: "not_requested";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface AbsNewsMaterializationProjectionV1 {
  actionInbox: ActionInboxItemV1;
  materializedWork?: { requestId: string; workflowId: string; jobId: string; state: "proposed" };
}

export type AbsNewsAutomationKindV1 = "collector" | "monitor";
export type AbsNewsAutomationSourceModeV1 = "synthetic" | "configured_live";

export interface AbsNewsAutomationDeclarationV1 {
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  automationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  automationKind: AbsNewsAutomationKindV1;
  sourceMode: AbsNewsAutomationSourceModeV1;
  sourceId: string;
  sourceKind: AbsNewsSourceKindV1;
  schedule: ScheduleRecord;
  maxItemsPerRun: number;
  maxRuntimeSeconds: number;
  maxAttempts: number;
  retryableFailureCodes: string[];
  networkPolicy: "none";
  allowedNetworkDestinations: [];
  credentialRefs: [];
  state: "disabled";
  activationState: "owner_authority_required";
  createsBackgroundProcess: false;
  grantsNetworkAuthority: false;
  grantsExecutionAuthority: false;
  declarationDigest: string;
}

export interface AbsNewsAutomationRunV1 {
  contractVersion: typeof ABS_NEWS_CONTRACT_V1;
  runId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  automationId: string;
  declarationDigest: string;
  occurrenceKey: string;
  scheduledFor: string;
  attemptNumber: number;
  state: "pending" | "running" | "succeeded" | "failed" | "ambiguous";
  createdAt: string;
  updatedAt: string;
  safeFailureCode?: string;
  resultDigest?: string;
  retryPermitted: boolean;
  simulationOnly: true;
  scheduleActivationObserved: false;
  networkUsed: false;
  grantsNetworkAuthority: false;
  grantsExecutionAuthority: false;
  runDigest: string;
}

export interface AbsNewsAutomationProjectionV1 {
  schedule: ScheduleProjectionV1;
  attention?: ActionInboxItemV1;
}
