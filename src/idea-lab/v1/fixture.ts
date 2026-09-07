import { sha256Digest } from "../../security";
import {
  buildIdeaLabContributionV1,
  buildIdeaLabDecisionV1,
  buildIdeaLabSessionV1,
  buildIdeaLabSynthesisV1,
  buildProjectLifecycleEventV1,
  buildProjectRegistryProjectionV1,
  type ProjectSnapshotMaterialV1,
} from "./contracts";
import type {
  IdeaLabContributionV1,
  IdeaLabDecisionV1,
  IdeaLabSessionV1,
  IdeaLabSynthesisV1,
  ProjectRegistryProjectionV1,
} from "./types";

const t0 = "2026-08-31T16:00:00.000Z";

function identity(label: string): string {
  return sha256Digest({ syntheticIdeaLabIdentity: label });
}

export interface IdeaLabFixtureV1 {
  session: IdeaLabSessionV1;
  contributions: IdeaLabContributionV1[];
  synthesis: IdeaLabSynthesisV1;
  decision: IdeaLabDecisionV1;
  promotedProject: ProjectRegistryProjectionV1;
}

export function buildIdeaLabFixtureV1(): IdeaLabFixtureV1 {
  const session = buildIdeaLabSessionV1({
    sessionId: "idea-session:local-trades-ai-desk",
    tenantId: "tenant:owner",
    workspaceId: "workspace:control-room",
    title: "AI operations desk for local trades",
    ideaSummary: "A managed AI operations desk that helps small trade businesses answer leads, prepare estimates, and follow up without replacing the owner.",
    targetCustomer: "Owner-operated plumbing, electrical, and HVAC businesses with missed calls and inconsistent follow-up.",
    participants: [
      { participantId: "bot:customer", identityDigest: identity("customer"), displayName: "Customer Lens", perspective: "customer", harness: "hermes", modelClass: "reasoning", platform: "linux", sourceMode: "injected_only", liveConnected: false, canDispatch: false },
      { participantId: "bot:market", identityDigest: identity("market"), displayName: "Market Scout", perspective: "market", harness: "hermes", modelClass: "research", platform: "windows", sourceMode: "injected_only", liveConnected: false, canDispatch: false },
      { participantId: "bot:skeptic", identityDigest: identity("skeptic"), displayName: "Red Team", perspective: "skeptic", harness: "codex", modelClass: "reasoning", platform: "macos", sourceMode: "injected_only", liveConnected: false, canDispatch: false },
      { participantId: "bot:operations", identityDigest: identity("operations"), displayName: "Operator", perspective: "operations", harness: "local_model", modelClass: "planning", platform: "linux", sourceMode: "injected_only", liveConnected: false, canDispatch: false },
    ],
    maxRounds: 2,
    maxDurationSeconds: 600,
    maxCostUsd: 4,
    createdByIdentityDigest: identity("owner"),
    createdAt: t0,
  });

  const contributions = [
    buildIdeaLabContributionV1(session, { participantId: "bot:customer", round: 1, safeOpinion: "Owners feel the pain most when a paid lead waits for a callback; start with a fast response and human handoff promise.", opportunityCode: "lead_response", primaryRiskCode: "trust_gap", suggestedExperiment: "Interview ten trade-business owners and measure missed-lead volume before writing automation.", confidencePercent: 82, contributedAt: "2026-08-31T16:01:00.000Z" }),
    buildIdeaLabContributionV1(session, { participantId: "bot:market", round: 1, safeOpinion: "The market is crowded with generic assistants, but a narrow operations service can differentiate through trade-specific intake and measurable recovery.", opportunityCode: "vertical_focus", primaryRiskCode: "crowded_market", suggestedExperiment: "Compare five existing services and define one workflow they do not complete end to end.", confidencePercent: 74, contributedAt: "2026-08-31T16:02:00.000Z" }),
    buildIdeaLabContributionV1(session, { participantId: "bot:skeptic", round: 1, safeOpinion: "Bad estimates or invented commitments could damage trust quickly, so the first version must never quote price or schedule work without owner confirmation.", opportunityCode: "human_control", primaryRiskCode: "unsafe_commitment", suggestedExperiment: "Run a red-team script against fifty ambiguous customer messages and require safe escalation every time.", confidencePercent: 91, contributedAt: "2026-08-31T16:03:00.000Z" }),
    buildIdeaLabContributionV1(session, { participantId: "bot:operations", round: 1, safeOpinion: "A service is workable if every request becomes a visible queue item with an owner, a deadline, and a complete audit trail.", opportunityCode: "managed_queue", primaryRiskCode: "service_overhead", suggestedExperiment: "Operate one synthetic week and measure minutes of human review per recovered lead.", confidencePercent: 79, contributedAt: "2026-08-31T16:04:00.000Z" }),
  ];

  const synthesis = buildIdeaLabSynthesisV1(session, contributions, {
    marketDemand: 82,
    feasibility: 76,
    differentiation: 72,
    durability: 69,
    ownerFit: 84,
    riskPercent: 31,
    executiveSummary: "The panel sees a promising narrow service if it begins with lead recovery, keeps the business owner in control, and proves the workflow before broader automation.",
    nextExperiment: "Complete ten owner interviews and a fifty-message safety rehearsal, then decide whether to run a two-customer concierge pilot.",
    dissentingPerspectiveCodes: ["unsafe_commitment", "service_overhead"],
    synthesizedAt: "2026-08-31T16:06:00.000Z",
  });

  const decision = buildIdeaLabDecisionV1(session, synthesis, contributions, {
    decision: "create_project",
    safeReasonCode: "owner_promoted_for_validation",
    ownerIdentityDigest: identity("owner"),
    project: {
      projectId: "project:local-trades-ai-desk",
      workspaceName: "Local Trades AI Desk",
      title: "Validate an AI operations desk for local trades",
      summary: "Test demand, safety, and operating cost before any live customer automation is enabled.",
      projectKind: "business_validation",
      priority: 72,
    },
    decidedAt: "2026-08-31T16:08:00.000Z",
  });

  const project: ProjectSnapshotMaterialV1 = {
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    projectId: decision.project!.projectId,
    sourceIdeaSessionId: session.sessionId,
    sourceDecisionDigest: decision.decisionDigest,
    workspaceName: decision.project!.workspaceName,
    title: decision.project!.title,
    summary: decision.project!.summary,
    projectKind: decision.project!.projectKind,
    lifecycleState: "active",
    priority: decision.project!.priority,
    version: 1,
    createdAt: decision.decidedAt,
    updatedAt: decision.decidedAt,
  };
  const event = buildProjectLifecycleEventV1({ ...project, fromState: null, actorIdentityDigest: decision.ownerIdentityDigest, safeReasonCode: decision.safeReasonCode });
  return { session, contributions, synthesis, decision, promotedProject: buildProjectRegistryProjectionV1(project, event) };
}
