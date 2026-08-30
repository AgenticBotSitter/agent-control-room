import { buildAgentTeamFixtureV1 } from "./fixture";
import { buildAgentTeamDurabilityProjectionV1 } from "./durable-projection";
import type { AgentTeamDurabilityProjectionV1 } from "./durable-types";

export function buildAgentTeamDurabilityFixtureV1(projectId: string): AgentTeamDurabilityProjectionV1 {
  const workspace = buildAgentTeamFixtureV1(projectId);
  const primaryRoom = workspace.rooms[0]!;
  return buildAgentTeamDurabilityProjectionV1({
    durabilityViewId: `team-durability.${projectId}`,
    tenantId: workspace.tenantId,
    workspaceId: workspace.workspaceId,
    projectId,
    generatedAt: workspace.generatedAt,
    rooms: workspace.rooms.map((room, index) => ({
      roomId: room.roomId,
      roomLabel: room.label,
      latestRoomSequence: room.messages.length,
      readThroughSequence: index === 0 ? 2 : 0,
      unreadCount: index === 0 ? room.messages.length - 2 : 0,
      unreadNeedsOwnerCount: index === 0 ? room.messages.filter((message) => message.sequence > 2 && message.needsOwner).length : 0,
      needsOwner: index === 0,
      retentionDisposition: "blocked_unconfigured" as const,
      legalHoldState: "none" as const,
      savedDraftCount: workspace.handoffProposals.filter((draft) => draft.roomId === room.roomId).length,
    })),
    savedDrafts: workspace.handoffProposals.map((draft) => ({
      proposalId: draft.proposalId,
      roomId: draft.roomId,
      targetAgentId: draft.targetAgentId,
      title: draft.title,
      platform: draft.platform,
      status: draft.status,
      requiresOwnerReview: draft.requiresOwnerReview,
      createsWorkItem: draft.createsWorkItem,
      dispatchState: draft.dispatchState,
      proposalDigest: draft.proposalDigest,
    })),
    ledgerRevision: 9,
    recordCount: primaryRoom.messages.length + workspace.handoffProposals.length + 3,
  });
}
