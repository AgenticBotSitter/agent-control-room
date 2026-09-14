import { sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { NEWS_ACTION_CATALOG_DIGEST_V1, getNewsActionTemplateV1 } from "./action-catalog";
import { newsProposalInputSchemaV1, newsWorkOrderProposalSchemaV1 } from "./schemas";
import { parseNewsStoryV1 } from "./story";
import { NEWS_CONTRACT_V1, type NewsWorkOrderProposalV1 } from "./types";

function unsigned(proposal: NewsWorkOrderProposalV1): Omit<NewsWorkOrderProposalV1, "proposalDigest"> {
  const { proposalDigest: _proposalDigest, ...material } = proposal;
  void _proposalDigest;
  return material;
}

export function buildNewsWorkOrderProposalV1(inputValue: unknown): NewsWorkOrderProposalV1 {
  const input = parseExactProjectWorkspaceV1(newsProposalInputSchemaV1, inputValue);
  const story = parseNewsStoryV1(input.story);
  if (story.tenantId !== input.tenantId || story.workspaceId !== input.workspaceId || story.projectId !== input.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  if (story.verificationState !== "verified" && input.actionId !== "research_brief") throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const action = getNewsActionTemplateV1(input.actionId);
  if (!action) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (!action.allowedPlatforms.includes("any") && !action.allowedPlatforms.includes(input.requestedPlatform)) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (action.allowedPlatforms.includes("any") && input.requestedPlatform !== "any") throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const evidence = [...story.sourceEvidence].sort((left, right) => left.evidenceDigest.localeCompare(right.evidenceDigest));
  const sourceEvidenceDigests = evidence.map((item) => item.evidenceDigest);
  const sourceUrls = [...new Set(evidence.map((item) => item.canonicalUrl))].sort();
  const proposalIdempotencyKey = sha256Digest({ tenantId: input.tenantId, workspaceId: input.workspaceId, projectId: input.projectId, storyDigest: story.storyDigest, actionId: action.actionId, actionCatalogDigest: NEWS_ACTION_CATALOG_DIGEST_V1, requestedTitle: input.requestedTitle, goal: input.goal, requestedPlatform: input.requestedPlatform });
  const material: Omit<NewsWorkOrderProposalV1, "proposalDigest"> = {
    contractVersion: NEWS_CONTRACT_V1,
    proposalId: input.proposalId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    storyId: story.storyId,
    storyDigest: story.storyDigest,
    ...(story.verificationState === "review_only" ? { verificationFirst: true as const } : {}),
    actionId: action.actionId,
    actionCatalogDigest: NEWS_ACTION_CATALOG_DIGEST_V1,
    requestedTitle: input.requestedTitle,
    goal: input.goal,
    deliverableKind: action.deliverableKind,
    routeProfileId: action.routeProfileId,
    requiredCapability: action.requiredCapability,
    requestedPlatform: input.requestedPlatform,
    risk: action.risk,
    reasoningProfile: action.reasoningProfile,
    effortHint: action.effortHint,
    sourceEvidenceDigests,
    sourceUrls,
    requestedByActorDigest: input.requestedByActorDigest,
    requestedAt: input.requestedAt,
    proposalIdempotencyKey,
    status: "draft",
    requiresOwnerReview: true,
    createsWorkItem: false,
    dispatchState: "not_requested",
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactProjectWorkspaceV1(newsWorkOrderProposalSchemaV1, { ...material, proposalDigest: sha256Digest(material) }) as NewsWorkOrderProposalV1;
}

export function parseNewsWorkOrderProposalV1(value: unknown): NewsWorkOrderProposalV1 {
  const proposal = parseExactProjectWorkspaceV1(newsWorkOrderProposalSchemaV1, value) as NewsWorkOrderProposalV1;
  if (sha256Digest(unsigned(proposal)) !== proposal.proposalDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  const action = getNewsActionTemplateV1(proposal.actionId);
  if (proposal.verificationFirst && proposal.actionId !== "research_brief") throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (!action || proposal.actionCatalogDigest !== NEWS_ACTION_CATALOG_DIGEST_V1 || proposal.deliverableKind !== action.deliverableKind || proposal.routeProfileId !== action.routeProfileId || proposal.requiredCapability !== action.requiredCapability || proposal.risk !== action.risk || proposal.reasoningProfile !== action.reasoningProfile || proposal.effortHint !== action.effortHint) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return proposal;
}
