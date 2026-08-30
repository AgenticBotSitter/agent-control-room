import { sha256Digest } from "../../security";
import { AgentTeamContractErrorV1 } from "./errors";
import { parseExactAgentTeamV1 } from "./exact";
import { agentTeamWorkspaceInputSchemaV1, agentTeamWorkspaceSchemaV1 } from "./schemas";
import {
  AGENT_TEAM_WORKSPACE_CONTRACT_V1,
  type AgentHandoffProposalInputV1,
  type AgentHandoffProposalV1,
  type AgentRoomMessageV1,
  type AgentTeamWorkspaceInputV1,
  type AgentTeamWorkspaceV1,
  type AgentWarRoomV1,
} from "./types";

function unsignedWorkspace(value: AgentTeamWorkspaceV1): Omit<AgentTeamWorkspaceV1, "workspaceDigest"> {
  const { workspaceDigest: _workspaceDigest, ...unsigned } = value;
  void _workspaceDigest;
  return unsigned;
}

function unsignedProposal(value: AgentHandoffProposalV1): Omit<AgentHandoffProposalV1, "proposalDigest"> {
  const { proposalDigest: _proposalDigest, ...unsigned } = value;
  void _proposalDigest;
  return unsigned;
}

function assertUnique(values: string[]): void {
  if (new Set(values).size !== values.length) throw new AgentTeamContractErrorV1("invalid_input");
}

function pairKeys(message: AgentRoomMessageV1): string[] {
  if (message.authorKind !== "agent") return [];
  return message.mentionedAgentIds.map((mentionedAgentId) => [message.authorId, mentionedAgentId].sort().join("::"));
}

function validateRoom(room: AgentWarRoomV1, projectId: string, agentIds: Set<string>): void {
  if (room.projectId !== projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
  assertUnique(room.memberAgentIds);
  assertUnique(room.messages.map((message) => message.messageId));
  assertUnique(room.linkedWorkItemIds);
  assertUnique(room.linkedIncidentIds);
  for (const memberId of room.memberAgentIds) if (!agentIds.has(memberId)) throw new AgentTeamContractErrorV1("unknown_agent");
  const pairCounts = new Map<string, number>();
  for (const [index, message] of room.messages.entries()) {
    if (message.sequence !== index + 1 || message.round > room.currentRound) throw new AgentTeamContractErrorV1("room_budget_exceeded");
    if (message.authorKind === "agent" && !room.memberAgentIds.includes(message.authorId)) throw new AgentTeamContractErrorV1("unknown_agent");
    if (message.authorKind === "owner" && message.authorId !== "owner") throw new AgentTeamContractErrorV1("invalid_input");
    assertUnique(message.mentionedAgentIds);
    for (const mentionedId of message.mentionedAgentIds) {
      if (!room.memberAgentIds.includes(mentionedId) || mentionedId === message.authorId) throw new AgentTeamContractErrorV1("unknown_agent");
    }
    for (const key of pairKeys(message)) {
      const next = (pairCounts.get(key) ?? 0) + 1;
      if (next > room.maxAgentPairMessages) throw new AgentTeamContractErrorV1("room_budget_exceeded");
      pairCounts.set(key, next);
    }
  }
  if ((room.state === "needs_owner") !== room.needsOwner) throw new AgentTeamContractErrorV1("invalid_input");
}

function proposal(input: AgentHandoffProposalInputV1): AgentHandoffProposalV1 {
  const idempotencyKey = sha256Digest({
    projectId: input.projectId,
    roomId: input.roomId,
    sourceMessageId: input.sourceMessageId,
    targetAgentId: input.targetAgentId,
    title: input.title,
    goal: input.goal,
    routeProfile: input.routeProfile,
    platform: input.platform,
  });
  const unsigned: Omit<AgentHandoffProposalV1, "proposalDigest"> = {
    ...input,
    status: "draft",
    requiresOwnerReview: true,
    createsWorkItem: false,
    dispatchState: "not_requested",
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
    idempotencyKey,
  };
  return { ...unsigned, proposalDigest: sha256Digest(unsigned) };
}

function proposalInput(value: AgentHandoffProposalV1): AgentHandoffProposalInputV1 {
  return {
    proposalId: value.proposalId,
    projectId: value.projectId,
    roomId: value.roomId,
    sourceMessageId: value.sourceMessageId,
    targetAgentId: value.targetAgentId,
    title: value.title,
    goal: value.goal,
    routeProfile: value.routeProfile,
    platform: value.platform,
  };
}

function validateBindings(input: AgentTeamWorkspaceInputV1): void {
  assertUnique(input.agents.map((agent) => agent.agentId));
  assertUnique(input.agents.map((agent) => agent.handle));
  assertUnique(input.routines.map((routine) => routine.routineId));
  assertUnique(input.routines.map((routine) => routine.scheduleId));
  assertUnique(input.rooms.map((room) => room.roomId));
  assertUnique(input.handoffProposals.map((item) => item.proposalId));
  const agentIds = new Set(input.agents.map((agent) => agent.agentId));
  const rooms = new Map(input.rooms.map((room) => [room.roomId, room]));
  for (const agent of input.agents) {
    if (agent.projectId !== input.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    if (agent.status === "working" && !["active_lease", "authenticated_heartbeat"].includes(agent.presenceBasis)) {
      throw new AgentTeamContractErrorV1("presence_unproved");
    }
    assertUnique(agent.reviewedPackageIds);
  }
  for (const routine of input.routines) {
    if (routine.projectId !== input.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    if (!agentIds.has(routine.agentId)) throw new AgentTeamContractErrorV1("unknown_agent");
  }
  for (const room of input.rooms) validateRoom(room, input.projectId, agentIds);
  for (const item of input.handoffProposals) {
    if (item.projectId !== input.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    if (!agentIds.has(item.targetAgentId)) throw new AgentTeamContractErrorV1("unknown_agent");
    const room = rooms.get(item.roomId);
    if (!room || !room.memberAgentIds.includes(item.targetAgentId)) throw new AgentTeamContractErrorV1("unknown_agent");
    const message = room.messages.find((candidate) => candidate.messageId === item.sourceMessageId);
    if (!message || !message.mentionedAgentIds.includes(item.targetAgentId)) throw new AgentTeamContractErrorV1("invalid_input");
  }
}

export function buildAgentTeamWorkspaceV1(inputValue: unknown): AgentTeamWorkspaceV1 {
  const input = parseExactAgentTeamV1(agentTeamWorkspaceInputSchemaV1, inputValue) as AgentTeamWorkspaceInputV1;
  validateBindings(input);
  const handoffProposals = input.handoffProposals.map(proposal);
  const unsigned: Omit<AgentTeamWorkspaceV1, "workspaceDigest"> = {
    contractVersion: AGENT_TEAM_WORKSPACE_CONTRACT_V1,
    workspaceViewId: input.workspaceViewId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    agents: input.agents,
    routines: input.routines,
    rooms: input.rooms,
    handoffProposals,
    activeAgentCount: input.agents.filter((agent) => agent.status === "working").length,
    needsOwnerCount: input.agents.filter((agent) => agent.needsOwner).length
      + input.routines.filter((routine) => routine.needsOwner).length
      + input.rooms.filter((room) => room.needsOwner).length,
    unreadRoomCount: input.rooms.filter((room) => room.needsOwner).length,
    presentationOnly: true,
    retainsFullMessages: false,
    sharesProviderAccess: false,
    createsWorkItems: false,
    dispatchesWork: false,
    grantsApproval: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  };
  return parseExactAgentTeamV1(agentTeamWorkspaceSchemaV1, {
    ...unsigned,
    workspaceDigest: sha256Digest(unsigned),
  }) as AgentTeamWorkspaceV1;
}

export function parseAgentTeamWorkspaceV1(value: unknown): AgentTeamWorkspaceV1 {
  const workspace = parseExactAgentTeamV1(agentTeamWorkspaceSchemaV1, value) as AgentTeamWorkspaceV1;
  if (sha256Digest(unsignedWorkspace(workspace)) !== workspace.workspaceDigest) throw new AgentTeamContractErrorV1("digest_mismatch");
  validateBindings({
    workspaceViewId: workspace.workspaceViewId,
    tenantId: workspace.tenantId,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    generatedAt: workspace.generatedAt,
    agents: workspace.agents,
    routines: workspace.routines,
    rooms: workspace.rooms,
    handoffProposals: workspace.handoffProposals.map(proposalInput),
  });
  for (const item of workspace.handoffProposals) {
    if (sha256Digest(unsignedProposal(item)) !== item.proposalDigest) throw new AgentTeamContractErrorV1("digest_mismatch");
    if (proposal(proposalInput(item)).idempotencyKey !== item.idempotencyKey) throw new AgentTeamContractErrorV1("replay_drift");
  }
  const active = workspace.agents.filter((agent) => agent.status === "working").length;
  const needsOwner = workspace.agents.filter((agent) => agent.needsOwner).length
    + workspace.routines.filter((routine) => routine.needsOwner).length
    + workspace.rooms.filter((room) => room.needsOwner).length;
  const unread = workspace.rooms.filter((room) => room.needsOwner).length;
  if (workspace.activeAgentCount !== active || workspace.needsOwnerCount !== needsOwner || workspace.unreadRoomCount !== unread) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  return workspace;
}
