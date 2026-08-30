import { z } from "zod";
import {
  AGENT_TEAM_DURABILITY_PROJECTION_V1,
  AGENT_TEAM_DURABLE_EVENT_V1,
  AGENT_TEAM_READ_RECEIPT_V1,
  AGENT_TEAM_ROOM_POLICY_EVENT_V1,
} from "./durable-types";
import {
  agentHandoffProposalSchemaV1,
  agentTeamDigestSchemaV1,
  agentTeamLabelSchemaV1,
  agentTeamPlatformSchemaV1,
  agentTeamSafeIdSchemaV1,
  agentTeamSummarySchemaV1,
  agentTeamTimeSchemaV1,
} from "./schemas";

const durableScope = {
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
};

export const agentTeamRoomEventInputSchemaV1 = z.object({
  ...durableScope,
  eventId: agentTeamSafeIdSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  roomLabel: agentTeamLabelSchemaV1,
  messageId: agentTeamSafeIdSchemaV1,
  roomSequence: z.number().int().min(1).max(10),
  round: z.number().int().min(1).max(3),
  authorKind: z.enum(["owner", "agent", "system"]),
  authorId: agentTeamSafeIdSchemaV1,
  safeSummary: agentTeamSummarySchemaV1,
  mentionedAgentIds: z.array(agentTeamSafeIdSchemaV1).max(6),
  mentionsOwner: z.boolean(),
  needsOwner: z.boolean(),
  occurredAt: agentTeamTimeSchemaV1,
}).strict();

export const agentTeamRoomEventSchemaV1 = agentTeamRoomEventInputSchemaV1.extend({
  schema: z.literal(AGENT_TEAM_DURABLE_EVENT_V1),
  storesSafeSummaryOnly: z.literal(true),
  retainsFullMessage: z.literal(false),
  createsWorkItem: z.literal(false),
  grantsAuthority: z.literal(false),
  eventDigest: agentTeamDigestSchemaV1,
}).strict();

export const agentTeamReadReceiptInputSchemaV1 = z.object({
  ...durableScope,
  receiptId: agentTeamSafeIdSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  readerId: z.literal("owner"),
  readThroughSequence: z.number().int().min(0).max(10),
  occurredAt: agentTeamTimeSchemaV1,
}).strict();

export const agentTeamReadReceiptSchemaV1 = agentTeamReadReceiptInputSchemaV1.extend({
  schema: z.literal(AGENT_TEAM_READ_RECEIPT_V1),
  marksReadOnly: z.literal(true),
  acknowledgesAction: z.literal(false),
  grantsAuthority: z.literal(false),
  receiptDigest: agentTeamDigestSchemaV1,
}).strict();

export const agentTeamRoomPolicyInputSchemaV1 = z.object({
  ...durableScope,
  policyEventId: agentTeamSafeIdSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  roomLabel: agentTeamLabelSchemaV1,
  memberAgentIds: z.array(agentTeamSafeIdSchemaV1).min(2).max(6),
  revision: z.number().int().min(1).max(1_000),
  predecessorPolicyDigest: agentTeamDigestSchemaV1.optional(),
  legalHoldState: z.enum(["none", "active"]),
  legalHoldEvidenceDigest: agentTeamDigestSchemaV1.optional(),
  occurredAt: agentTeamTimeSchemaV1,
}).strict().superRefine((value, context) => {
  if ((value.revision === 1) === Boolean(value.predecessorPolicyDigest)) context.addIssue({ code: "custom", message: "invalid predecessor" });
  if ((value.legalHoldState === "active") !== Boolean(value.legalHoldEvidenceDigest)) context.addIssue({ code: "custom", message: "invalid legal hold evidence" });
});

export const agentTeamRoomPolicyEventSchemaV1 = agentTeamRoomPolicyInputSchemaV1.safeExtend({
  schema: z.literal(AGENT_TEAM_ROOM_POLICY_EVENT_V1),
  retentionDisposition: z.literal("blocked_unconfigured"),
  deletionExecutorPresent: z.literal(false),
  policyDigest: agentTeamDigestSchemaV1,
}).strict();

export const agentTeamDurableRoomProjectionSchemaV1 = z.object({
  roomId: agentTeamSafeIdSchemaV1,
  roomLabel: agentTeamLabelSchemaV1,
  latestRoomSequence: z.number().int().min(0).max(10),
  readThroughSequence: z.number().int().min(0).max(10),
  unreadCount: z.number().int().min(0).max(10),
  unreadNeedsOwnerCount: z.number().int().min(0).max(10),
  needsOwner: z.boolean(),
  retentionDisposition: z.literal("blocked_unconfigured"),
  legalHoldState: z.enum(["none", "active"]),
  savedDraftCount: z.number().int().min(0).max(100),
}).strict();

export const agentTeamSavedDraftProjectionSchemaV1 = agentHandoffProposalSchemaV1.pick({
  proposalId: true,
  roomId: true,
  targetAgentId: true,
  title: true,
  platform: true,
  status: true,
  requiresOwnerReview: true,
  createsWorkItem: true,
  dispatchState: true,
  proposalDigest: true,
}).strict();

export const agentTeamDurabilityProjectionInputSchemaV1 = z.object({
  ...durableScope,
  durabilityViewId: agentTeamSafeIdSchemaV1,
  generatedAt: agentTeamTimeSchemaV1,
  rooms: z.array(agentTeamDurableRoomProjectionSchemaV1).max(100),
  savedDrafts: z.array(agentTeamSavedDraftProjectionSchemaV1).max(100),
  ledgerRevision: z.number().int().min(1),
  recordCount: z.number().int().min(0).max(10_000),
}).strict();

export const agentTeamDurabilityProjectionSchemaV1 = agentTeamDurabilityProjectionInputSchemaV1.extend({
  contractVersion: z.literal(AGENT_TEAM_DURABILITY_PROJECTION_V1),
  unreadRoomCount: z.number().int().min(0).max(100),
  unreadMessageCount: z.number().int().min(0).max(1_000),
  needsOwnerRoomCount: z.number().int().min(0).max(100),
  savedDraftCount: z.number().int().min(0).max(100),
  persistenceState: z.literal("authenticated_local"),
  checkpointState: z.literal("matched"),
  restartSemantics: z.literal("verify_before_use"),
  storesSafeSummariesOnly: z.literal(true),
  retainsFullMessages: z.literal(false),
  deletionExecutorPresent: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
  grantsAuthority: z.literal(false),
  durabilityDigest: agentTeamDigestSchemaV1,
}).strict();

export { agentHandoffProposalSchemaV1, agentTeamPlatformSchemaV1 };
