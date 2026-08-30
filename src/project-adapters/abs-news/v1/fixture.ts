import { sha256Digest } from "../../../security";
import { buildProjectWorkspaceSnapshotV1 } from "../../../project-workspace/v1";
import { ABS_NEWS_ACTION_CATALOG_DIGEST_V1, ABS_NEWS_ACTION_CATALOG_V1 } from "./action-catalog";
import { buildAbsNewsStoryV1 } from "./story";
import { ABS_NEWS_ADAPTER_ID_V1, ABS_NEWS_PROJECT_ID_V1, ABS_NEWS_WORKSPACE_ID_V1, type AbsNewsSourceEvidenceV1, type AbsNewsSyntheticWorkspaceV1 } from "./types";

const tenantId = "tenant.owner";
const generatedAt = "2026-08-29T19:30:00.000Z";

function evidence(id: string, sourceKind: AbsNewsSourceEvidenceV1["sourceKind"], sourceLabel: string, canonicalUrl: string): AbsNewsSourceEvidenceV1 {
  return { evidenceId: `evidence.abs.${id}`, sourceId: `source.abs.${id}`, sourceKind, sourceLabel, canonicalUrl, observedAt: generatedAt, evidenceDigest: sha256Digest({ id, canonicalUrl, synthetic: true }), containsRawNewsletterBody: false, grantsNetworkAuthority: false };
}

export function buildAbsNewsSyntheticWorkspaceV1(): AbsNewsSyntheticWorkspaceV1 {
  const stories = [
    buildAbsNewsStoryV1({
      storyId: "story.abs.agent-runtime", tenantId, workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, clusterId: "cluster.abs.agent-runtime", queue: "important_now",
      title: "Synthetic agent runtime release", summary: "A synthetic verified story used to demonstrate research, guide, evaluation, and editorial work-order proposals.",
      canonicalUrl: "https://example.com/ai/agent-runtime-release", sourceLabel: "Synthetic AI source", publishedAt: "2026-08-29T18:00:00.000Z", discoveredAt: "2026-08-29T18:10:00.000Z", lastVerifiedAt: generatedAt,
      verificationState: "verified", priorityScore: 94, coverageCount: 3,
      sourceEvidence: [evidence("agent-runtime-primary", "rss", "Synthetic primary feed", "https://example.com/ai/agent-runtime-release"), evidence("agent-runtime-newsletter", "newsletter", "Synthetic newsletter", "https://news.example.com/issues/agent-runtime")],
      contentDigest: sha256Digest({ body: "synthetic-agent-runtime-release" }),
    }),
    buildAbsNewsStoryV1({
      storyId: "story.abs.local-model-guide", tenantId, workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, clusterId: "cluster.abs.local-model-guide", queue: "important_now",
      title: "Synthetic local model deployment update", summary: "A synthetic technical update that is suitable for a platform-specific setup-guide proposal.",
      canonicalUrl: "https://docs.example.com/local-model/update", sourceLabel: "Synthetic technical source", publishedAt: "2026-08-29T16:00:00.000Z", discoveredAt: "2026-08-29T16:12:00.000Z", lastVerifiedAt: generatedAt,
      verificationState: "verified", priorityScore: 87, coverageCount: 1, sourceEvidence: [evidence("local-model-guide", "sitemap", "Synthetic documentation", "https://docs.example.com/local-model/update")],
      contentDigest: sha256Digest({ body: "synthetic-local-model-update" }),
    }),
    buildAbsNewsStoryV1({
      storyId: "story.abs.unverified-rumor", tenantId, workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, clusterId: "cluster.abs.unverified-rumor", queue: "earlier",
      title: "Synthetic item awaiting direct verification", summary: "This synthetic review-only item proves that search or newsletter discovery alone cannot create an agent work-order proposal.",
      canonicalUrl: "https://search.example.com/results/unverified-item", sourceLabel: "Synthetic discovery source", discoveredAt: "2026-08-29T14:00:00.000Z", lastVerifiedAt: "2026-08-29T14:01:00.000Z",
      verificationState: "review_only", priorityScore: 40, coverageCount: 1, sourceEvidence: [evidence("unverified-rumor", "news_search", "Synthetic search result", "https://search.example.com/results/unverified-item")],
      contentDigest: sha256Digest({ body: "synthetic-unverified-item" }),
    }),
  ];
  const workspace = buildProjectWorkspaceSnapshotV1({
    snapshotId: "snapshot.abs.news.synthetic", tenantId, workspaceId: ABS_NEWS_WORKSPACE_ID_V1, projectId: ABS_NEWS_PROJECT_ID_V1, adapterId: ABS_NEWS_ADAPTER_ID_V1, projectType: "ai-tech-news",
    title: "ABS AI and Tech News", summary: "A synthetic owner workspace for verified AI and technology discoveries, agent work-order proposals, reviews, and publication preparation.", authorityMode: "control_room_native", generatedAt,
    extensionSections: [
      { sectionId: "daily-brief", extensionKind: "daily_brief", label: "Daily Brief", itemCount: 2 },
      { sectionId: "ai-tech-news", extensionKind: "news_queue", label: "AI and Tech News", itemCount: 3 },
      { sectionId: "newsletters", extensionKind: "newsletter_queue", label: "Newsletters", itemCount: 1 },
      { sectionId: "companies-people", extensionKind: "entity_watch", label: "Companies and People", itemCount: 0 },
      { sectionId: "saved-ideas", extensionKind: "saved_ideas", label: "Saved Ideas", itemCount: 0 },
      { sectionId: "research-queue", extensionKind: "proposal_queue", label: "Research Queue", itemCount: 0 },
      { sectionId: "drafts", extensionKind: "draft_queue", label: "Drafts", itemCount: 0 },
      { sectionId: "published", extensionKind: "publication_history", label: "Published", itemCount: 0 },
      { sectionId: "audience", extensionKind: "audience_metrics", label: "Audience", itemCount: 0 },
    ],
    sourceStatuses: [
      { sourceId: "source.abs.synthetic-rss", sourceKind: "rss", label: "Synthetic RSS", mode: "synthetic", state: "available", safeStatusCode: "synthetic_fixture", checkedAt: generatedAt, lastSuccessfulAt: generatedAt, itemCount: 1, grantsNetworkAuthority: false },
      { sourceId: "source.abs.synthetic-newsletter", sourceKind: "newsletter", label: "Synthetic newsletter", mode: "synthetic", state: "available", safeStatusCode: "synthetic_fixture", checkedAt: generatedAt, lastSuccessfulAt: generatedAt, itemCount: 1, grantsNetworkAuthority: false },
      { sourceId: "source.abs.live-collection", sourceKind: "collector", label: "Live collection", mode: "configured", state: "disabled", safeStatusCode: "owner_authority_required", grantsNetworkAuthority: false },
    ],
    activeItemCount: 2, waitingReviewCount: 1, failedItemCount: 0, snapshotHighWaterDigest: sha256Digest(stories.map((story) => story.storyDigest)),
  });
  return { workspace, stories, actionCatalog: [...ABS_NEWS_ACTION_CATALOG_V1], actionCatalogDigest: ABS_NEWS_ACTION_CATALOG_DIGEST_V1 };
}
