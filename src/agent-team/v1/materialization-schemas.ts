import { z } from "zod";
import { jobRecordSchema, requestRecordSchema, workflowRecordSchema } from "../../domain/v1";
import { actionInboxItemSchemaV1 } from "../../operator-surfaces/v1";
import { agentHandoffProposalSchemaV1, agentTeamDigestSchemaV1, agentTeamSafeCodeSchemaV1, agentTeamSafeIdSchemaV1, agentTeamTimeSchemaV1 } from "./schemas";
import { AGENT_TEAM_HANDOFF_MATERIALIZATION_V1, AGENT_TEAM_HANDOFF_REVIEW_V1 } from "./materialization-types";

const scope = { tenantId: agentTeamSafeIdSchemaV1, workspaceId: agentTeamSafeIdSchemaV1, projectId: agentTeamSafeIdSchemaV1 };

export const agentTeamHandoffReviewInputSchemaV1 = z.object({
  ...scope,
  reviewId: agentTeamSafeIdSchemaV1,
  proposal: agentHandoffProposalSchemaV1,
  decision: z.enum(["accepted", "rejected", "withdrawn"]),
  safeReasonCode: agentTeamSafeCodeSchemaV1,
  reviewerActorDigest: agentTeamDigestSchemaV1,
  ownerAuthenticationEvidenceDigest: agentTeamDigestSchemaV1,
  reviewedAt: agentTeamTimeSchemaV1,
}).strict();

export const agentTeamHandoffReviewSchemaV1 = z.object({
  contractVersion: z.literal(AGENT_TEAM_HANDOFF_REVIEW_V1),
  ...scope,
  reviewId: agentTeamSafeIdSchemaV1,
  proposalId: agentTeamSafeIdSchemaV1,
  proposalDigest: agentTeamDigestSchemaV1,
  proposalIdempotencyKey: agentTeamDigestSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  sourceMessageId: agentTeamSafeIdSchemaV1,
  targetAgentId: agentTeamSafeIdSchemaV1,
  decision: z.enum(["accepted", "rejected", "withdrawn"]),
  safeReasonCode: agentTeamSafeCodeSchemaV1,
  reviewerActorDigest: agentTeamDigestSchemaV1,
  ownerAuthenticationEvidenceDigest: agentTeamDigestSchemaV1,
  reviewedAt: agentTeamTimeSchemaV1,
  isOwnerReview: z.literal(true),
  grantsApproval: z.literal(false),
  grantsDispatchAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  reviewDigest: agentTeamDigestSchemaV1,
}).strict();

export const agentTeamHandoffMaterializationInputSchemaV1 = z.object({
  ...scope,
  proposal: agentHandoffProposalSchemaV1,
  acceptedReview: agentTeamHandoffReviewSchemaV1,
  materializedAt: agentTeamTimeSchemaV1,
  authorityExpiresAt: agentTeamTimeSchemaV1,
}).strict();

export const agentTeamHandoffMaterializationReceiptSchemaV1 = z.object({
  contractVersion: z.literal(AGENT_TEAM_HANDOFF_MATERIALIZATION_V1),
  ...scope,
  receiptId: agentTeamSafeIdSchemaV1,
  proposalId: agentTeamSafeIdSchemaV1,
  proposalDigest: agentTeamDigestSchemaV1,
  acceptedReviewId: agentTeamSafeIdSchemaV1,
  acceptedReviewDigest: agentTeamDigestSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  sourceMessageId: agentTeamSafeIdSchemaV1,
  targetAgentId: agentTeamSafeIdSchemaV1,
  request: requestRecordSchema,
  workflow: workflowRecordSchema,
  job: jobRecordSchema,
  actionInbox: actionInboxItemSchemaV1,
  materializedAt: agentTeamTimeSchemaV1,
  state: z.literal("materialized_proposed"),
  createsAttempt: z.literal(false),
  createsLease: z.literal(false),
  dispatchState: z.literal("not_requested"),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  receiptDigest: agentTeamDigestSchemaV1,
}).strict();
