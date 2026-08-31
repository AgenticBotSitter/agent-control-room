import { buildAgentTeamWorkspaceV1 } from "./workspace";
import type { AgentTeamMemberV1, AgentTeamWorkspaceV1 } from "./types";

const observedAt = "2026-08-30T12:30:00.000Z";

function member(projectId: string, value: Omit<AgentTeamMemberV1, "projectId" | "profileIsProjection" | "grantsProviderAccess" | "grantsCommandAuthority" | "grantsExecutionAuthority">): AgentTeamMemberV1 {
  return {
    ...value,
    projectId,
    profileIsProjection: true,
    grantsProviderAccess: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
}

export function buildAgentTeamFixtureV1(projectId: string): AgentTeamWorkspaceV1 {
  const roomId = `room.${projectId}.build`;
  return buildAgentTeamWorkspaceV1({
    workspaceViewId: `team-view.${projectId}`,
    tenantId: "tenant.owner",
    workspaceId: "workspace.control-room",
    projectId,
    generatedAt: observedAt,
    agents: [
      member(projectId, {
        agentId: "agent.codex.architect", displayName: "Codex Architect", handle: "codex@control-room", kind: "codex",
        role: "Architecture, security, and integration", deviceLabel: "Control Room", platform: "any",
        modelClass: "implementation_frontier", status: "working", presenceBasis: "active_lease", lastObservedAt: observedAt,
        currentWorkItemId: "work.cr11a.team-workspace", currentWorkSummary: "Building the Agent Team and bounded War Room slice.",
        queuedWorkCount: 3, routineCount: 1, needsOwner: false, reviewedPackageIds: ["package.agent-build-worker.v2"],
      }),
      member(projectId, {
        agentId: "agent.marvin", displayName: "Marvin", handle: "marvin@mac-mini", kind: "hermes",
        role: "Mac research and implementation", deviceLabel: "Mac mini", platform: "macos",
        modelClass: "implementation_balanced", status: "available", presenceBasis: "authenticated_heartbeat", lastObservedAt: "2026-08-30T12:29:40.000Z",
        queuedWorkCount: 2, routineCount: 2, needsOwner: false, reviewedPackageIds: ["package.agent-build-worker.v2", "package.mac-safe-research.v1"],
      }),
      member(projectId, {
        agentId: "agent.scout", displayName: "Scout", handle: "scout@linux-node", kind: "hermes",
        role: "Research and source verification", deviceLabel: "Linux node", platform: "linux",
        modelClass: "research_deep", status: "blocked", presenceBasis: "authenticated_heartbeat", lastObservedAt: "2026-08-30T12:28:55.000Z",
        queuedWorkCount: 1, routineCount: 1, needsOwner: true, reviewedPackageIds: ["package.research-source-verification.v1"],
      }),
      member(projectId, {
        agentId: "agent.reviewer", displayName: "Independent Reviewer", handle: "reviewer@review-route", kind: "other",
        role: "Independent evidence review", deviceLabel: "Review route", platform: "any",
        modelClass: "review_independent", status: "stale", presenceBasis: "last_known", lastObservedAt: "2026-08-30T10:10:00.000Z",
        queuedWorkCount: 0, routineCount: 0, needsOwner: false, reviewedPackageIds: ["package.independent-review.v1"],
      }),
    ],
    routines: [
      { routineId: "routine.daily-build-brief", projectId, agentId: "agent.codex.architect", scheduleId: "schedule.daily-build-brief",
        label: "Daily build brief", safeSummary: "Prepare a bounded project progress brief from accepted Control Room records.", state: "scheduled",
        nextOccurrenceAt: "2026-08-31T15:00:00.000Z", lastOutcomeCode: "accepted", needsOwner: false,
        scheduleIsAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false },
      { routineId: "routine.mac-capacity-check", projectId, agentId: "agent.marvin", scheduleId: "schedule.mac-capacity-check",
        label: "Mac capacity review", safeSummary: "Review authenticated capacity evidence and prepare a placement proposal when needed.", state: "scheduled",
        nextOccurrenceAt: "2026-08-30T18:00:00.000Z", lastOutcomeCode: "no_change", needsOwner: false,
        scheduleIsAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false },
      { routineId: "routine.source-watch", projectId, agentId: "agent.scout", scheduleId: "schedule.source-watch",
        label: "Source watch", safeSummary: "A proposed research routine awaiting a reviewed source ceiling.", state: "blocked",
        lastOutcomeCode: "owner_scope_required", needsOwner: true,
        scheduleIsAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false },
    ],
    rooms: [
      {
        roomId, projectId, label: "Build room", purpose: "build", state: "needs_owner",
        memberAgentIds: ["agent.codex.architect", "agent.marvin", "agent.scout"], currentRound: 2,
        messages: [
          { messageId: "message.build.1", sequence: 1, round: 1, authorKind: "owner", authorId: "owner",
            safeSummary: "Build the Agent Team workspace as a large local phase and keep hosting disabled.", mentionedAgentIds: [], mentionsOwner: false,
            needsOwner: false, occurredAt: "2026-08-30T12:00:00.000Z", createsWorkItem: false, grantsAuthority: false },
          { messageId: "message.build.2", sequence: 2, round: 1, authorKind: "agent", authorId: "agent.codex.architect",
            safeSummary: "The contract keeps presence evidence-based, rooms bounded, and handoffs proposal-only.", mentionedAgentIds: ["agent.marvin"], mentionsOwner: false,
            needsOwner: false, occurredAt: "2026-08-30T12:05:00.000Z", createsWorkItem: false, grantsAuthority: false },
          { messageId: "message.build.3", sequence: 3, round: 2, authorKind: "agent", authorId: "agent.scout",
            safeSummary: "The next durable room ledger needs an owner-approved retention ceiling before raw message storage is considered.", mentionedAgentIds: [], mentionsOwner: true,
            needsOwner: true, occurredAt: "2026-08-30T12:18:00.000Z", createsWorkItem: false, grantsAuthority: false },
          { messageId: "message.build.4", sequence: 4, round: 2, authorKind: "agent", authorId: "agent.codex.architect",
            safeSummary: "Marvin can prepare the bounded persistence comparison after owner review of this draft handoff.", mentionedAgentIds: ["agent.marvin"], mentionsOwner: false,
            needsOwner: false, occurredAt: "2026-08-30T12:22:00.000Z", createsWorkItem: false, grantsAuthority: false },
        ],
        linkedWorkItemIds: ["work.cr11a.team-workspace"], linkedIncidentIds: [], needsOwner: true,
        maxRounds: 3, maxMessages: 10, maxAgentPairMessages: 4, maxDurationSeconds: 1800, maxReasoningUnits: 100000, maxCostUsd: 25,
        canonicalAuditRequired: true, chatIsOrchestrationAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false,
      },
      {
        roomId: `room.${projectId}.review`, projectId, label: "Evidence review", purpose: "review", state: "paused",
        memberAgentIds: ["agent.codex.architect", "agent.reviewer"], currentRound: 1, messages: [], linkedWorkItemIds: [], linkedIncidentIds: [], needsOwner: false,
        maxRounds: 3, maxMessages: 10, maxAgentPairMessages: 4, maxDurationSeconds: 1800, maxReasoningUnits: 100000, maxCostUsd: 25,
        canonicalAuditRequired: true, chatIsOrchestrationAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false,
      },
    ],
    handoffProposals: [{
      proposalId: `handoff.${projectId}.persistence-comparison`, projectId, roomId, sourceMessageId: "message.build.4", targetAgentId: "agent.marvin",
      title: "Compare durable War Room persistence options",
      goal: "Compare bounded event-ledger designs against existing Control Room audit, retention, and project-isolation contracts without changing live infrastructure.",
      routeProfile: "route.team.persistence.compare", platform: "macos",
    }],
  });
}
