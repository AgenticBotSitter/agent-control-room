import { z } from "zod";
import { AGENT_TEAM_WORKSPACE_CONTRACT_V1 } from "./types";

export const agentTeamSafeIdSchemaV1 = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
export const agentTeamSafeCodeSchemaV1 = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const agentTeamLabelSchemaV1 = z.string().min(1).max(180);
export const agentTeamSummarySchemaV1 = z.string().min(1).max(800);
export const agentTeamTimeSchemaV1 = z.string().datetime({ offset: true });
export const agentTeamDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const agentTeamPlatformSchemaV1 = z.enum(["any", "macos", "windows", "linux", "cloud"]);

export const agentTeamMemberSchemaV1 = z.object({
  agentId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  displayName: agentTeamLabelSchemaV1,
  handle: agentTeamSafeIdSchemaV1,
  kind: z.enum(["codex", "hermes", "human", "other"]),
  role: agentTeamLabelSchemaV1,
  deviceLabel: agentTeamLabelSchemaV1,
  platform: agentTeamPlatformSchemaV1,
  modelClass: agentTeamSafeCodeSchemaV1,
  status: z.enum(["working", "available", "blocked", "stale", "offline"]),
  presenceBasis: z.enum(["active_lease", "authenticated_heartbeat", "last_known", "none"]),
  lastObservedAt: agentTeamTimeSchemaV1.optional(),
  currentWorkItemId: agentTeamSafeIdSchemaV1.optional(),
  currentWorkSummary: agentTeamSummarySchemaV1.optional(),
  queuedWorkCount: z.number().int().min(0).max(10_000),
  routineCount: z.number().int().min(0).max(1_000),
  needsOwner: z.boolean(),
  reviewedPackageIds: z.array(agentTeamSafeIdSchemaV1).max(24),
  profileIsProjection: z.literal(true),
  grantsProviderAccess: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.status === "working" && !["active_lease", "authenticated_heartbeat"].includes(value.presenceBasis)) {
    context.addIssue({ code: "custom", message: "working presence requires current evidence" });
  }
  if (value.status === "working" && (!value.currentWorkItemId || !value.currentWorkSummary || !value.lastObservedAt)) {
    context.addIssue({ code: "custom", message: "working agents require bound current work" });
  }
  if (["stale", "offline"].includes(value.status) && value.currentWorkItemId) {
    context.addIssue({ code: "custom", message: "stale and offline agents cannot claim current work" });
  }
  if (value.presenceBasis === "none" && value.lastObservedAt) {
    context.addIssue({ code: "custom", message: "none presence cannot carry an observation" });
  }
});

export const agentRoutineSchemaV1 = z.object({
  routineId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  agentId: agentTeamSafeIdSchemaV1,
  scheduleId: agentTeamSafeIdSchemaV1,
  label: agentTeamLabelSchemaV1,
  safeSummary: agentTeamSummarySchemaV1,
  state: z.enum(["scheduled", "running", "blocked", "disabled"]),
  nextOccurrenceAt: agentTeamTimeSchemaV1.optional(),
  lastOutcomeCode: agentTeamSafeCodeSchemaV1.optional(),
  needsOwner: z.boolean(),
  scheduleIsAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (value.state === "scheduled" && !value.nextOccurrenceAt) context.addIssue({ code: "custom", message: "scheduled routines require a next occurrence" });
  if (value.state === "disabled" && value.nextOccurrenceAt) context.addIssue({ code: "custom", message: "disabled routines cannot claim a next occurrence" });
});

export const agentRoomMessageSchemaV1 = z.object({
  messageId: agentTeamSafeIdSchemaV1,
  sequence: z.number().int().min(1).max(10),
  round: z.number().int().min(1).max(3),
  authorKind: z.enum(["owner", "agent", "system"]),
  authorId: agentTeamSafeIdSchemaV1,
  safeSummary: agentTeamSummarySchemaV1,
  mentionedAgentIds: z.array(agentTeamSafeIdSchemaV1).max(6),
  mentionsOwner: z.boolean(),
  needsOwner: z.boolean(),
  occurredAt: agentTeamTimeSchemaV1,
  createsWorkItem: z.literal(false),
  grantsAuthority: z.literal(false),
}).strict();

export const agentWarRoomSchemaV1 = z.object({
  roomId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  label: agentTeamLabelSchemaV1,
  purpose: z.enum(["planning", "build", "review", "research", "incident"]),
  state: z.enum(["open", "paused", "needs_owner", "closed"]),
  memberAgentIds: z.array(agentTeamSafeIdSchemaV1).min(2).max(6),
  currentRound: z.number().int().min(1).max(3),
  messages: z.array(agentRoomMessageSchemaV1).max(10),
  linkedWorkItemIds: z.array(agentTeamSafeIdSchemaV1).max(20),
  linkedIncidentIds: z.array(agentTeamSafeIdSchemaV1).max(20),
  needsOwner: z.boolean(),
  maxRounds: z.literal(3),
  maxMessages: z.literal(10),
  maxAgentPairMessages: z.literal(4),
  maxDurationSeconds: z.literal(1800),
  maxReasoningUnits: z.literal(100000),
  maxCostUsd: z.literal(25),
  canonicalAuditRequired: z.literal(true),
  chatIsOrchestrationAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export const agentHandoffProposalInputSchemaV1 = z.object({
  proposalId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  roomId: agentTeamSafeIdSchemaV1,
  sourceMessageId: agentTeamSafeIdSchemaV1,
  targetAgentId: agentTeamSafeIdSchemaV1,
  title: agentTeamLabelSchemaV1,
  goal: agentTeamSummarySchemaV1,
  routeProfile: agentTeamSafeCodeSchemaV1,
  platform: agentTeamPlatformSchemaV1,
}).strict();

export const agentHandoffProposalSchemaV1 = agentHandoffProposalInputSchemaV1.extend({
  status: z.literal("draft"),
  requiresOwnerReview: z.literal(true),
  createsWorkItem: z.literal(false),
  dispatchState: z.literal("not_requested"),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  idempotencyKey: agentTeamDigestSchemaV1,
  proposalDigest: agentTeamDigestSchemaV1,
}).strict();

export const agentTeamWorkspaceInputSchemaV1 = z.object({
  workspaceViewId: agentTeamSafeIdSchemaV1,
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  generatedAt: agentTeamTimeSchemaV1,
  agents: z.array(agentTeamMemberSchemaV1).min(1).max(100),
  routines: z.array(agentRoutineSchemaV1).max(500),
  rooms: z.array(agentWarRoomSchemaV1).max(100),
  handoffProposals: z.array(agentHandoffProposalInputSchemaV1).max(100),
}).strict();

export const agentTeamWorkspaceSchemaV1 = agentTeamWorkspaceInputSchemaV1.omit({ handoffProposals: true }).extend({
  contractVersion: z.literal(AGENT_TEAM_WORKSPACE_CONTRACT_V1),
  handoffProposals: z.array(agentHandoffProposalSchemaV1).max(100),
  activeAgentCount: z.number().int().min(0).max(100),
  needsOwnerCount: z.number().int().min(0).max(10_000),
  unreadRoomCount: z.number().int().min(0).max(100),
  presentationOnly: z.literal(true),
  retainsFullMessages: z.literal(false),
  sharesProviderAccess: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  workspaceDigest: agentTeamDigestSchemaV1,
}).strict();
