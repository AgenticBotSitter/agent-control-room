import type { AgentHandoffProposalV1, AgentPlatformV1 } from "./types";
import type { AgentTeamHandoffReviewV1 } from "./materialization-types";

export const AGENT_TEAM_DURABLE_EVENT_V1 = "control-room-agent-team-room-event/v1" as const;
export const AGENT_TEAM_READ_RECEIPT_V1 = "control-room-agent-team-read-receipt/v1" as const;
export const AGENT_TEAM_ROOM_POLICY_EVENT_V1 = "control-room-agent-team-room-policy-event/v1" as const;
export const AGENT_TEAM_DURABILITY_PROJECTION_V1 = "control-room-agent-team-durability-projection/v1" as const;

export interface AgentTeamDurableScopeV1 {
  tenantId: string;
  workspaceId: string;
  projectId: string;
}

export interface AgentTeamRoomEventInputV1 extends AgentTeamDurableScopeV1 {
  eventId: string;
  roomId: string;
  roomLabel: string;
  messageId: string;
  roomSequence: number;
  round: number;
  authorKind: "owner" | "agent" | "system";
  authorId: string;
  safeSummary: string;
  mentionedAgentIds: string[];
  mentionsOwner: boolean;
  needsOwner: boolean;
  occurredAt: string;
}

export interface AgentTeamRoomEventV1 extends AgentTeamRoomEventInputV1 {
  schema: typeof AGENT_TEAM_DURABLE_EVENT_V1;
  storesSafeSummaryOnly: true;
  retainsFullMessage: false;
  createsWorkItem: false;
  grantsAuthority: false;
  eventDigest: string;
}

export interface AgentTeamReadReceiptInputV1 extends AgentTeamDurableScopeV1 {
  receiptId: string;
  roomId: string;
  readerId: "owner";
  readThroughSequence: number;
  occurredAt: string;
}

export interface AgentTeamReadReceiptV1 extends AgentTeamReadReceiptInputV1 {
  schema: typeof AGENT_TEAM_READ_RECEIPT_V1;
  marksReadOnly: true;
  acknowledgesAction: false;
  grantsAuthority: false;
  receiptDigest: string;
}

export interface AgentTeamRoomPolicyInputV1 extends AgentTeamDurableScopeV1 {
  policyEventId: string;
  roomId: string;
  roomLabel: string;
  memberAgentIds: string[];
  revision: number;
  predecessorPolicyDigest?: string;
  legalHoldState: "none" | "active";
  legalHoldEvidenceDigest?: string;
  occurredAt: string;
}

export interface AgentTeamRoomPolicyEventV1 extends AgentTeamRoomPolicyInputV1 {
  schema: typeof AGENT_TEAM_ROOM_POLICY_EVENT_V1;
  retentionDisposition: "blocked_unconfigured";
  deletionExecutorPresent: false;
  policyDigest: string;
}

export type AgentTeamDurableRecordV1 = AgentTeamRoomEventV1 | AgentTeamReadReceiptV1 | AgentTeamRoomPolicyEventV1
  | AgentHandoffProposalV1 | AgentTeamHandoffReviewV1;

export interface AgentTeamDurableRoomProjectionV1 {
  roomId: string;
  roomLabel: string;
  latestRoomSequence: number;
  readThroughSequence: number;
  unreadCount: number;
  unreadNeedsOwnerCount: number;
  needsOwner: boolean;
  retentionDisposition: "blocked_unconfigured";
  legalHoldState: "none" | "active";
  savedDraftCount: number;
}

export interface AgentTeamSavedDraftProjectionV1 {
  proposalId: string;
  roomId: string;
  targetAgentId: string;
  title: string;
  platform: AgentPlatformV1;
  status: "draft";
  requiresOwnerReview: true;
  createsWorkItem: false;
  dispatchState: "not_requested";
  proposalDigest: string;
}

export interface AgentTeamDurabilityProjectionInputV1 extends AgentTeamDurableScopeV1 {
  durabilityViewId: string;
  generatedAt: string;
  rooms: AgentTeamDurableRoomProjectionV1[];
  savedDrafts: AgentTeamSavedDraftProjectionV1[];
  ledgerRevision: number;
  recordCount: number;
}

export interface AgentTeamDurabilityProjectionV1 extends AgentTeamDurabilityProjectionInputV1 {
  contractVersion: typeof AGENT_TEAM_DURABILITY_PROJECTION_V1;
  unreadRoomCount: number;
  unreadMessageCount: number;
  needsOwnerRoomCount: number;
  savedDraftCount: number;
  persistenceState: "authenticated_local";
  checkpointState: "matched";
  restartSemantics: "verify_before_use";
  storesSafeSummariesOnly: true;
  retainsFullMessages: false;
  deletionExecutorPresent: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsAuthority: false;
  durabilityDigest: string;
}
