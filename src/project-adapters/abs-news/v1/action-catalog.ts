import { sha256Digest } from "../../../security";
import { parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { absNewsActionTemplateSchemaV1 } from "./schemas";
import { ABS_NEWS_ACTION_IDS_V1, type AbsNewsActionIdV1, type AbsNewsActionTemplateV1 } from "./types";

const template = (value: Omit<AbsNewsActionTemplateV1, "requiresOwnerReview" | "createsProposalOnly" | "grantsApproval" | "grantsNetworkAuthority" | "grantsCommandAuthority" | "grantsExecutionAuthority">): AbsNewsActionTemplateV1 => parseExactProjectWorkspaceV1(absNewsActionTemplateSchemaV1, {
  ...value,
  requiresOwnerReview: true,
  createsProposalOnly: true,
  grantsApproval: false,
  grantsNetworkAuthority: false,
  grantsCommandAuthority: false,
  grantsExecutionAuthority: false,
}) as AbsNewsActionTemplateV1;

export const ABS_NEWS_ACTION_CATALOG_V1: readonly AbsNewsActionTemplateV1[] = [
  template({ actionId: "research_brief", label: "Research this", deliverableKind: "report", routeProfileId: "route.abs.research.deep", requiredCapability: "research.web", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "research_deep", effortHint: "high" }),
  template({ actionId: "setup_guide", label: "Write a setup guide", deliverableKind: "setup_guide", routeProfileId: "route.abs.guide.technical", requiredCapability: "documentation.technical", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "implementation_balanced", effortHint: "high" }),
  template({ actionId: "product_comparison", label: "Compare products", deliverableKind: "comparison", routeProfileId: "route.abs.comparison.deep", requiredCapability: "research.comparison", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "research_deep", effortHint: "high" }),
  template({ actionId: "tool_evaluation", label: "Evaluate this tool", deliverableKind: "evaluation", routeProfileId: "route.abs.tool.evaluate", requiredCapability: "tool.evaluate", allowedPlatforms: ["macos", "windows", "linux", "cloud"], risk: "medium", reasoningProfile: "implementation_balanced", effortHint: "high" }),
  template({ actionId: "abs_article_draft", label: "Draft an ABS article", deliverableKind: "article_draft", routeProfileId: "route.abs.article.editorial", requiredCapability: "content.article", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "high" }),
  template({ actionId: "newsletter_draft", label: "Draft a newsletter item", deliverableKind: "newsletter_draft", routeProfileId: "route.abs.newsletter.editorial", requiredCapability: "content.newsletter", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "medium" }),
  template({ actionId: "social_draft", label: "Draft social posts", deliverableKind: "social_draft", routeProfileId: "route.abs.social.editorial", requiredCapability: "content.social", allowedPlatforms: ["any"], risk: "low", reasoningProfile: "editorial_balanced", effortHint: "medium" }),
  template({ actionId: "monitor_updates", label: "Monitor for updates", deliverableKind: "monitor_plan", routeProfileId: "route.abs.monitor.bounded", requiredCapability: "monitor.web", allowedPlatforms: ["cloud"], risk: "low", reasoningProfile: "monitoring_bounded", effortHint: "medium" }),
];

if (ABS_NEWS_ACTION_CATALOG_V1.map((item) => item.actionId).join("|") !== ABS_NEWS_ACTION_IDS_V1.join("|")) throw new Error("ABS News action catalog drift");

export const ABS_NEWS_ACTION_CATALOG_DIGEST_V1 = sha256Digest(ABS_NEWS_ACTION_CATALOG_V1);

export function getAbsNewsActionTemplateV1(actionId: AbsNewsActionIdV1): AbsNewsActionTemplateV1 | undefined {
  return ABS_NEWS_ACTION_CATALOG_V1.find((item) => item.actionId === actionId);
}
