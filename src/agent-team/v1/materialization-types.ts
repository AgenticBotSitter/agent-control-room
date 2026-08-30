import type { JobRecord, RequestRecord, WorkflowRecord } from "../../domain/v1";
import type { ActionInboxItemV1 } from "../../operator-surfaces/v1";
import type { AgentTeamDurableScopeV1 } from "./durable-types";
import type { AgentHandoffProposalV1 } from "./types";

export const AGENT_TEAM_HANDOFF_REVIEW_V1 = "control-room-agent-team-handoff-review/v1" as const;
export const AGENT_TEAM_HANDOFF_MATERIALIZATION_V1 = "control-room-agent-team-handoff-materialization/v1" as const;

export interface AgentTeamHandoffReviewInputV1 extends AgentTeamDurableScopeV1 {
  reviewId: string;
  proposal: AgentHandoffProposalV1;
  decision: "accepted" | "rejected" | "withdrawn";
  safeReasonCode: string;
  reviewerActorDigest: string;
  ownerAuthenticationEvidenceDigest: string;
  reviewedAt: string;
}

export interface AgentTeamHandoffReviewV1 extends AgentTeamDurableScopeV1 {
  contractVersion: typeof AGENT_TEAM_HANDOFF_REVIEW_V1;
  reviewId: string;
  proposalId: string;
  proposalDigest: string;
  proposalIdempotencyKey: string;
  roomId: string;
  sourceMessageId: string;
  targetAgentId: string;
  decision: "accepted" | "rejected" | "withdrawn";
  safeReasonCode: string;
  reviewerActorDigest: string;
  ownerAuthenticationEvidenceDigest: string;
  reviewedAt: string;
  isOwnerReview: true;
  grantsApproval: false;
  grantsDispatchAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  reviewDigest: string;
}

export interface AgentTeamHandoffMaterializationInputV1 extends AgentTeamDurableScopeV1 {
  proposal: AgentHandoffProposalV1;
  acceptedReview: AgentTeamHandoffReviewV1;
  materializedAt: string;
  authorityExpiresAt: string;
}

export interface AgentTeamHandoffMaterializationReceiptV1 extends AgentTeamDurableScopeV1 {
  contractVersion: typeof AGENT_TEAM_HANDOFF_MATERIALIZATION_V1;
  receiptId: string;
  proposalId: string;
  proposalDigest: string;
  acceptedReviewId: string;
  acceptedReviewDigest: string;
  roomId: string;
  sourceMessageId: string;
  targetAgentId: string;
  request: RequestRecord;
  workflow: WorkflowRecord;
  job: JobRecord;
  actionInbox: ActionInboxItemV1;
  materializedAt: string;
  state: "materialized_proposed";
  createsAttempt: false;
  createsLease: false;
  dispatchState: "not_requested";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface AgentTeamHandoffReviewProjectionV1 {
  actionInbox: ActionInboxItemV1;
  proposalId: string;
  proposalDigest: string;
  reviewState: "awaiting_owner" | "rejected" | "withdrawn" | "accepted_pending_materialization" | "materialized_proposed";
  createsWorkItem: boolean;
  dispatchState: "not_requested";
  grantsAuthority: false;
  materializedWork?: { requestId: string; workflowId: string; jobId: string; state: "proposed" };
}
