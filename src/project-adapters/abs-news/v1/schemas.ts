import { z } from "zod";
import { jobRecordSchema, requestRecordSchema, scheduleRecordSchema, workflowRecordSchema } from "../../../domain/v1";
import {
  projectWorkspaceDigestSchemaV1,
  projectWorkspaceLabelSchemaV1,
  projectWorkspaceSafeIdSchemaV1,
  projectWorkspaceSummarySchemaV1,
  projectWorkspaceTimeSchemaV1,
} from "../../../project-workspace/v1";
import { ABS_NEWS_ACTION_IDS_V1, ABS_NEWS_CONTRACT_V1 } from "./types";

function isCanonicalPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return false;
    if (url.href !== value) return false;
    const host = url.hostname;
    if (host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".")) return false;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
    if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

export const absNewsCanonicalUrlSchemaV1 = z.string().min(12).max(2_000).refine(isCanonicalPublicHttpsUrl, "URL must be canonical public HTTPS without credentials, port, query, or fragment");

/** Feed endpoints may use query selectors. Keep their exact query in provenance;
 * do not relax the separate canonical article-identity schema. Not network authority. */
export const absNewsDiscoveryEndpointSchemaV1 = z.string().min(12).max(2_000).refine(value => {
  try {
    const url = new URL(value);
    if (url.href !== value) return false;
    url.search = "";
    return isCanonicalPublicHttpsUrl(url.toString());
  } catch { return false; }
}, "Feed endpoint must be canonical public HTTPS without credentials, custom port or fragment");

export const absNewsSourceEvidenceSchemaV1 = z.object({
  evidenceId: projectWorkspaceSafeIdSchemaV1,
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: z.enum(["rss", "atom", "sitemap", "news_search", "newsletter", "manual"]),
  sourceLabel: projectWorkspaceLabelSchemaV1,
  canonicalUrl: absNewsCanonicalUrlSchemaV1,
  observedAt: projectWorkspaceTimeSchemaV1,
  evidenceDigest: projectWorkspaceDigestSchemaV1,
  containsRawNewsletterBody: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
}).strict();

export const absNewsStorySchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  storyId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  clusterId: projectWorkspaceSafeIdSchemaV1,
  queue: z.enum(["important_now", "earlier", "archive"]),
  title: z.string().min(1).max(240),
  summary: projectWorkspaceSummarySchemaV1,
  canonicalUrl: absNewsCanonicalUrlSchemaV1,
  canonicalHost: z.string().min(3).max(253).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  sourceLabel: projectWorkspaceLabelSchemaV1,
  publishedAt: projectWorkspaceTimeSchemaV1.optional(),
  discoveredAt: projectWorkspaceTimeSchemaV1,
  lastVerifiedAt: projectWorkspaceTimeSchemaV1,
  verificationState: z.enum(["verified", "review_only"]),
  priorityScore: z.number().int().min(0).max(100),
  coverageCount: z.number().int().min(1).max(10_000),
  sourceEvidence: z.array(absNewsSourceEvidenceSchemaV1).min(1).max(32),
  contentDigest: projectWorkspaceDigestSchemaV1,
  containsRawNewsletterBody: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  storyDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (new URL(value.canonicalUrl).hostname !== value.canonicalHost) context.addIssue({ code: "custom", message: "canonical host must match the story URL" });
  if (value.coverageCount < value.sourceEvidence.length) context.addIssue({ code: "custom", message: "coverage count cannot be smaller than retained evidence" });
  if (new Set(value.sourceEvidence.map((evidence) => evidence.evidenceId)).size !== value.sourceEvidence.length) context.addIssue({ code: "custom", message: "evidence identifiers must be unique" });
  if (new Set(value.sourceEvidence.map((evidence) => evidence.evidenceDigest)).size !== value.sourceEvidence.length) context.addIssue({ code: "custom", message: "evidence digests must be unique" });
});

export const absNewsStoryInputSchemaV1 = absNewsStorySchemaV1.omit({
  contractVersion: true,
  canonicalHost: true,
  containsRawNewsletterBody: true,
  grantsNetworkAuthority: true,
  grantsCommandAuthority: true,
  grantsExecutionAuthority: true,
  storyDigest: true,
});

export const absNewsActionTemplateSchemaV1 = z.object({
  actionId: z.enum(ABS_NEWS_ACTION_IDS_V1),
  label: projectWorkspaceLabelSchemaV1,
  deliverableKind: z.enum(["report", "setup_guide", "comparison", "evaluation", "article_draft", "newsletter_draft", "social_draft", "monitor_plan"]),
  routeProfileId: projectWorkspaceSafeIdSchemaV1,
  requiredCapability: projectWorkspaceSafeIdSchemaV1,
  allowedPlatforms: z.array(z.enum(["any", "macos", "windows", "linux", "cloud"])).min(1).max(5),
  risk: z.enum(["low", "medium"]),
  reasoningProfile: z.enum(["research_deep", "implementation_balanced", "editorial_balanced", "monitoring_bounded"]),
  effortHint: z.enum(["medium", "high"]),
  requiresOwnerReview: z.literal(true),
  createsProposalOnly: z.literal(true),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.allowedPlatforms).size !== value.allowedPlatforms.length) context.addIssue({ code: "custom", message: "allowed platforms must be unique" });
  if (value.allowedPlatforms.includes("any") && value.allowedPlatforms.length !== 1) context.addIssue({ code: "custom", message: "any cannot be combined with named platforms" });
});

export const absNewsWorkOrderProposalSchemaV1 = z.object({
  verificationFirst: z.literal(true).optional(),
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  proposalId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  storyId: projectWorkspaceSafeIdSchemaV1,
  storyDigest: projectWorkspaceDigestSchemaV1,
  actionId: z.enum(ABS_NEWS_ACTION_IDS_V1),
  actionCatalogDigest: projectWorkspaceDigestSchemaV1,
  requestedTitle: z.string().min(1).max(240),
  goal: z.string().min(1).max(1_200),
  deliverableKind: z.enum(["report", "setup_guide", "comparison", "evaluation", "article_draft", "newsletter_draft", "social_draft", "monitor_plan"]),
  routeProfileId: projectWorkspaceSafeIdSchemaV1,
  requiredCapability: projectWorkspaceSafeIdSchemaV1,
  requestedPlatform: z.enum(["any", "macos", "windows", "linux", "cloud"]),
  risk: z.enum(["low", "medium"]),
  reasoningProfile: z.enum(["research_deep", "implementation_balanced", "editorial_balanced", "monitoring_bounded"]),
  effortHint: z.enum(["medium", "high"]),
  sourceEvidenceDigests: z.array(projectWorkspaceDigestSchemaV1).min(1).max(32),
  sourceUrls: z.array(absNewsCanonicalUrlSchemaV1).min(1).max(32),
  requestedByActorDigest: projectWorkspaceDigestSchemaV1,
  requestedAt: projectWorkspaceTimeSchemaV1,
  proposalIdempotencyKey: projectWorkspaceDigestSchemaV1,
  status: z.literal("draft"),
  requiresOwnerReview: z.literal(true),
  createsWorkItem: z.literal(false),
  dispatchState: z.literal("not_requested"),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  proposalDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (new Set(value.sourceEvidenceDigests).size !== value.sourceEvidenceDigests.length) context.addIssue({ code: "custom", message: "proposal evidence digests must be unique" });
  if (new Set(value.sourceUrls).size !== value.sourceUrls.length) context.addIssue({ code: "custom", message: "proposal source URLs must be unique" });
});

export const absNewsProposalInputSchemaV1 = z.object({
  proposalId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  story: z.unknown(),
  actionId: z.enum(ABS_NEWS_ACTION_IDS_V1),
  requestedTitle: z.string().min(1).max(240),
  goal: z.string().min(1).max(1_200),
  requestedPlatform: z.enum(["any", "macos", "windows", "linux", "cloud"]),
  requestedByActorDigest: projectWorkspaceDigestSchemaV1,
  requestedAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const absNewsProposalReviewSchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  reviewId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  proposalId: projectWorkspaceSafeIdSchemaV1,
  proposalDigest: projectWorkspaceDigestSchemaV1,
  storyId: projectWorkspaceSafeIdSchemaV1,
  storyDigest: projectWorkspaceDigestSchemaV1,
  actionCatalogDigest: projectWorkspaceDigestSchemaV1,
  decision: z.enum(["accepted", "rejected"]),
  safeReasonCode: projectWorkspaceSafeIdSchemaV1,
  reviewerActorDigest: projectWorkspaceDigestSchemaV1,
  reviewedAt: projectWorkspaceTimeSchemaV1,
  grantsApproval: z.literal(false),
  grantsDispatchAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  reviewDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const absNewsProposalReviewInputSchemaV1 = z.object({
  reviewId: projectWorkspaceSafeIdSchemaV1,
  proposal: z.unknown(),
  decision: z.enum(["accepted", "rejected"]),
  safeReasonCode: projectWorkspaceSafeIdSchemaV1,
  reviewerActorDigest: projectWorkspaceDigestSchemaV1,
  reviewedAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const absNewsMaterializationReceiptSchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  receiptId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  proposalId: projectWorkspaceSafeIdSchemaV1,
  proposalDigest: projectWorkspaceDigestSchemaV1,
  acceptedReviewId: projectWorkspaceSafeIdSchemaV1,
  acceptedReviewDigest: projectWorkspaceDigestSchemaV1,
  request: requestRecordSchema,
  workflow: workflowRecordSchema,
  job: jobRecordSchema,
  materializedAt: projectWorkspaceTimeSchemaV1,
  state: z.literal("materialized_proposed"),
  createsAttempt: z.literal(false),
  createsLease: z.literal(false),
  dispatchState: z.literal("not_requested"),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: projectWorkspaceDigestSchemaV1,
}).strict();

export const absNewsMaterializationInputSchemaV1 = z.object({
  proposal: z.unknown(),
  acceptedReview: z.unknown(),
  materializedAt: projectWorkspaceTimeSchemaV1,
  authorityExpiresAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const absNewsAutomationDeclarationSchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  automationId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  automationKind: z.enum(["collector", "monitor"]),
  sourceMode: z.enum(["synthetic", "configured_live"]),
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: z.enum(["rss", "atom", "sitemap", "news_search", "newsletter", "manual"]),
  schedule: scheduleRecordSchema,
  maxItemsPerRun: z.number().int().min(1).max(1_000),
  maxRuntimeSeconds: z.number().int().min(1).max(3_600),
  maxAttempts: z.number().int().min(1).max(10),
  retryableFailureCodes: z.array(projectWorkspaceSafeIdSchemaV1).max(20),
  networkPolicy: z.literal("none"),
  allowedNetworkDestinations: z.tuple([]),
  credentialRefs: z.tuple([]),
  state: z.literal("disabled"),
  activationState: z.literal("owner_authority_required"),
  createsBackgroundProcess: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  declarationDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.schedule.projectId !== value.projectId || value.schedule.id !== value.automationId || value.schedule.state !== "disabled") context.addIssue({ code: "custom", message: "schedule must be the disabled canonical automation schedule" });
  if (new Set(value.retryableFailureCodes).size !== value.retryableFailureCodes.length) context.addIssue({ code: "custom", message: "retryable failure codes must be unique" });
});

export const absNewsAutomationDeclarationInputSchemaV1 = z.object({
  automationId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  automationKind: z.enum(["collector", "monitor"]),
  sourceMode: z.enum(["synthetic", "configured_live"]),
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: z.enum(["rss", "atom", "sitemap", "news_search", "newsletter", "manual"]),
  scheduleType: z.enum(["cron", "interval", "once"]),
  expression: z.string().min(1).max(300),
  timezone: z.string().min(1).max(100),
  idempotencyWindowSeconds: z.number().int().positive().max(31_536_000),
  maxItemsPerRun: z.number().int().min(1).max(1_000),
  maxRuntimeSeconds: z.number().int().min(1).max(3_600),
  maxAttempts: z.number().int().min(1).max(10),
  retryableFailureCodes: z.array(projectWorkspaceSafeIdSchemaV1).max(20),
  declaredAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const absNewsAutomationRunSchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_CONTRACT_V1),
  runId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  automationId: projectWorkspaceSafeIdSchemaV1,
  declarationDigest: projectWorkspaceDigestSchemaV1,
  occurrenceKey: projectWorkspaceSafeIdSchemaV1,
  scheduledFor: projectWorkspaceTimeSchemaV1,
  attemptNumber: z.number().int().min(1).max(10),
  state: z.enum(["pending", "running", "succeeded", "failed", "ambiguous"]),
  createdAt: projectWorkspaceTimeSchemaV1,
  updatedAt: projectWorkspaceTimeSchemaV1,
  safeFailureCode: projectWorkspaceSafeIdSchemaV1.optional(),
  resultDigest: projectWorkspaceDigestSchemaV1.optional(),
  retryPermitted: z.boolean(),
  simulationOnly: z.literal(true),
  scheduleActivationObserved: z.literal(false),
  networkUsed: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  runDigest: projectWorkspaceDigestSchemaV1,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) context.addIssue({ code: "custom", message: "run update cannot precede creation" });
  if (value.state === "succeeded" && !value.resultDigest) context.addIssue({ code: "custom", message: "succeeded run requires a result digest" });
  if (["failed", "ambiguous"].includes(value.state) && !value.safeFailureCode) context.addIssue({ code: "custom", message: "failed or ambiguous run requires a safe failure code" });
  if (!["failed"].includes(value.state) && value.retryPermitted) context.addIssue({ code: "custom", message: "only failed runs may be retryable" });
});

const absNewsDiscoveredUrlSchemaV1 = z.string().min(12).max(2_000).refine((value) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && host.includes(".") && host !== "localhost" && !host.endsWith(".localhost")
      && !host.endsWith(".local") && !host.endsWith(".internal")
      && !/^\d+(?:\.\d+){3}$/.test(host) && !host.includes(":");
  } catch { return false; }
}, "discovered URL must be public HTTPS");

export const absNewsCollectedItemSchemaV1 = z.object({
  collectionItemId: projectWorkspaceSafeIdSchemaV1,
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: z.enum(["rss", "sitemap", "newsletter"]),
  sourceLabel: projectWorkspaceLabelSchemaV1,
  title: z.string().min(1).max(240),
  summary: projectWorkspaceSummarySchemaV1,
  discoveredUrl: absNewsDiscoveredUrlSchemaV1,
  publishedAt: projectWorkspaceTimeSchemaV1.optional(),
  observedAt: projectWorkspaceTimeSchemaV1,
  directlyVerified: z.boolean(),
  contentDigest: projectWorkspaceDigestSchemaV1,
  containsRawNewsletterBody: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
}).strict();

export const absNewsFakeCollectionBatchSchemaV1 = z.object({
  batchId: projectWorkspaceSafeIdSchemaV1,
  sourceId: projectWorkspaceSafeIdSchemaV1,
  sourceKind: z.enum(["rss", "sitemap", "newsletter"]),
  sourceLabel: projectWorkspaceLabelSchemaV1,
  collectedAt: projectWorkspaceTimeSchemaV1,
  items: z.array(absNewsCollectedItemSchemaV1).max(1_000),
  synthetic: z.literal(true),
  networkUsed: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.items.some((item) => item.sourceId !== value.sourceId || item.sourceKind !== value.sourceKind || item.sourceLabel !== value.sourceLabel)) {
    context.addIssue({ code: "custom", message: "collection items must match their batch source" });
  }
  if (new Set(value.items.map((item) => item.collectionItemId)).size !== value.items.length) {
    context.addIssue({ code: "custom", message: "collection item identifiers must be unique" });
  }
});

export const absNewsCollectionInputSchemaV1 = z.object({
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  batches: z.array(absNewsFakeCollectionBatchSchemaV1).max(100),
  collectedAt: projectWorkspaceTimeSchemaV1,
}).strict();

export const absNewsQueueHistorySchemaV1 = z.object({
  eventId: projectWorkspaceSafeIdSchemaV1,
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
  storyId: projectWorkspaceSafeIdSchemaV1,
  priorStoryDigest: projectWorkspaceDigestSchemaV1,
  nextStoryDigest: projectWorkspaceDigestSchemaV1,
  fromQueue: z.enum(["important_now", "earlier", "archive"]),
  toQueue: z.enum(["important_now", "earlier", "archive"]),
  changedByActorDigest: projectWorkspaceDigestSchemaV1,
  changedAt: projectWorkspaceTimeSchemaV1,
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  eventDigest: projectWorkspaceDigestSchemaV1,
}).strict();
