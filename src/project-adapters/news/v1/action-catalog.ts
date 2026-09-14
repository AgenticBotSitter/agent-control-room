import { sha256Digest } from "../../../security";
import { parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { newsActionTemplateSchemaV1 } from "./schemas";
import { NEWS_ACTION_IDS_V1, type NewsActionIdV1, type NewsActionTemplateV1 } from "./types";

const template = (value: Omit<NewsActionTemplateV1, "requiresOwnerReview" | "createsProposalOnly" | "grantsApproval" | "grantsNetworkAuthority" | "grantsCommandAuthority" | "grantsExecutionAuthority">): NewsActionTemplateV1 => parseExactProjectWorkspaceV1(newsActionTemplateSchemaV1, {
  ...value,
  requiresOwnerReview: true,
  createsProposalOnly: true,
  grantsApproval: false,
  grantsNetworkAuthority: false,
  grantsCommandAuthority: false,
  grantsExecutionAuthority: false,
}) as NewsActionTemplateV1;

export const NEWS_ACTION_CATALOG_V1: readonly NewsActionTemplateV1[] = [
  template({ actionId: "research_brief", label: "Research this", deliverableKind: "report", routeProfileId: "route.news.research.deep", requiredCapability: "research.web", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "research_deep", effortHint: "high" }),
  template({ actionId: "setup_guide", label: "Write a setup guide", deliverableKind: "setup_guide", routeProfileId: "route.news.guide.technical", requiredCapability: "documentation.technical", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "implementation_balanced", effortHint: "high" }),
  template({ actionId: "product_comparison", label: "Compare products", deliverableKind: "comparison", routeProfileId: "route.news.comparison.deep", requiredCapability: "research.comparison", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "research_deep", effortHint: "high" }),
  template({ actionId: "tool_evaluation", label: "Evaluate this tool", deliverableKind: "evaluation", routeProfileId: "route.news.tool.evaluate", requiredCapability: "tool.evaluate", allowedPlatforms: ["macos", "windows", "linux", "cloud"], risk: "medium", reasoningProfile: "implementation_balanced", effortHint: "high" }),
  template({ actionId: "news_article_draft", label: "Draft a news article", deliverableKind: "article_draft", routeProfileId: "route.news.article.editorial", requiredCapability: "content.article", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "high" }),
  template({ actionId: "newsletter_draft", label: "Draft a newsletter item", deliverableKind: "newsletter_draft", routeProfileId: "route.news.newsletter.editorial", requiredCapability: "content.newsletter", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "medium" }),
  template({ actionId: "social_draft", label: "Draft social posts", deliverableKind: "social_draft", routeProfileId: "route.news.social.editorial", requiredCapability: "content.social", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "medium" }),
  template({ actionId: "monitor_updates", label: "Monitor for updates", deliverableKind: "monitor_plan", routeProfileId: "route.news.monitor.bounded", requiredCapability: "monitor.web", allowedPlatforms: ["cloud"], risk: "low", reasoningProfile: "monitoring_bounded", effortHint: "medium" }),
];

if (NEWS_ACTION_CATALOG_V1.map((item) => item.actionId).join("|") !== NEWS_ACTION_IDS_V1.join("|")) throw new Error("News action catalog drift");

export const NEWS_ACTION_CATALOG_DIGEST_V1 = sha256Digest(NEWS_ACTION_CATALOG_V1);

export function getNewsActionTemplateV1(actionId: NewsActionIdV1): NewsActionTemplateV1 | undefined {
  return NEWS_ACTION_CATALOG_V1.find((item) => item.actionId === actionId);
}
