export const AGENT_TEAM_WORKSPACE_CONTRACT_V1 = "control-room-agent-team-workspace/v1" as const;

export const AGENT_TEAM_ROOM_POLICY_V1 = {
  minMembers: 2,
  maxMembers: 6,
  maxRounds: 3,
  maxMessages: 10,
  maxAgentPairMessages: 4,
  maxDurationSeconds: 1_800,
  maxReasoningUnits: 100_000,
  maxCostUsd: 25,
} as const;

export type AgentTeamKindV1 = "codex" | "hermes" | "human" | "other";
export type AgentTeamStatusV1 = "working" | "available" | "blocked" | "stale" | "offline";
export type AgentPresenceBasisV1 = "active_lease" | "authenticated_heartbeat" | "last_known" | "none";
export type AgentRoutineStateV1 = "scheduled" | "running" | "blocked" | "disabled";
export type AgentRoomStateV1 = "open" | "paused" | "needs_owner" | "closed";
export type AgentRoomPurposeV1 = "planning" | "build" | "review" | "research" | "incident";
export type AgentPlatformV1 = "any" | "macos" | "windows" | "linux" | "cloud";

export interface AgentTeamMemberV1 {
  agentId: string;
  projectId: string;
  displayName: string;
  handle: string;
  kind: AgentTeamKindV1;
  role: string;
  deviceLabel: string;
  platform: AgentPlatformV1;
  modelClass: string;
  status: AgentTeamStatusV1;
  presenceBasis: AgentPresenceBasisV1;
  lastObservedAt?: string;
  currentWorkItemId?: string;
  currentWorkSummary?: string;
  queuedWorkCount: number;
  routineCount: number;
  needsOwner: boolean;
  reviewedPackageIds: string[];
  profileIsProjection: true;
  grantsProviderAccess: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface AgentRoutineV1 {
  routineId: string;
  projectId: string;
  agentId: string;
  scheduleId: string;
  label: string;
  safeSummary: string;
  state: AgentRoutineStateV1;
  nextOccurrenceAt?: string;
  lastOutcomeCode?: string;
  needsOwner: boolean;
  scheduleIsAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface AgentRoomMessageV1 {
  messageId: string;
  sequence: number;
  round: number;
  authorKind: "owner" | "agent" | "system";
  authorId: string;
  safeSummary: string;
  mentionedAgentIds: string[];
  mentionsOwner: boolean;
  needsOwner: boolean;
  occurredAt: string;
  createsWorkItem: false;
  grantsAuthority: false;
}

export interface AgentWarRoomV1 {
  roomId: string;
  projectId: string;
  label: string;
  purpose: AgentRoomPurposeV1;
  state: AgentRoomStateV1;
  memberAgentIds: string[];
  currentRound: number;
  messages: AgentRoomMessageV1[];
  linkedWorkItemIds: string[];
  linkedIncidentIds: string[];
  needsOwner: boolean;
  maxRounds: 3;
  maxMessages: 10;
  maxAgentPairMessages: 4;
  maxDurationSeconds: 1800;
  maxReasoningUnits: 100000;
  maxCostUsd: 25;
  canonicalAuditRequired: true;
  chatIsOrchestrationAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface AgentHandoffProposalV1 {
  proposalId: string;
  projectId: string;
  roomId: string;
  sourceMessageId: string;
  targetAgentId: string;
  title: string;
  goal: string;
  routeProfile: string;
  platform: AgentPlatformV1;
  status: "draft";
  requiresOwnerReview: true;
  createsWorkItem: false;
  dispatchState: "not_requested";
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  idempotencyKey: string;
  proposalDigest: string;
}

export interface AgentHandoffProposalInputV1 {
  proposalId: string;
  projectId: string;
  roomId: string;
  sourceMessageId: string;
  targetAgentId: string;
  title: string;
  goal: string;
  routeProfile: string;
  platform: AgentPlatformV1;
}

export interface AgentTeamWorkspaceInputV1 {
  workspaceViewId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  generatedAt: string;
  agents: AgentTeamMemberV1[];
  routines: AgentRoutineV1[];
  rooms: AgentWarRoomV1[];
  handoffProposals: AgentHandoffProposalInputV1[];
}

export interface AgentTeamWorkspaceV1 {
  contractVersion: typeof AGENT_TEAM_WORKSPACE_CONTRACT_V1;
  workspaceViewId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  generatedAt: string;
  agents: AgentTeamMemberV1[];
  routines: AgentRoutineV1[];
  rooms: AgentWarRoomV1[];
  handoffProposals: AgentHandoffProposalV1[];
  activeAgentCount: number;
  needsOwnerCount: number;
  unreadRoomCount: number;
  presentationOnly: true;
  retainsFullMessages: false;
  sharesProviderAccess: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  workspaceDigest: string;
}
