import { z } from "zod";
import {
  agentTeamDigestSchemaV1,
  agentTeamLabelSchemaV1,
  agentTeamPlatformSchemaV1,
  agentTeamSafeCodeSchemaV1,
  agentTeamSafeIdSchemaV1,
  agentTeamSummarySchemaV1,
  agentTeamTimeSchemaV1,
  agentTeamWorkspaceSchemaV1,
} from "./schemas";
import {
  HERMES_BOT_MODE_ADAPTER_V1,
  HERMES_BOT_MODE_ADAPTER_VERSION_V1,
  HERMES_BOT_MODE_OBSERVATION_V1,
  HERMES_BOT_MODE_PROJECTION_V1,
  HERMES_BOT_MODE_RESOURCE_CEILINGS_V1,
} from "./hermes-bot-mode-types";

const collectionTruthSchema = z.enum(["observed", "absent", "unknown"]);

export const hermesBotModeResourceCeilingsSchemaV1 = z.object({
  maxProfiles: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxProfiles),
  maxRoutines: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoutines),
  maxRooms: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRooms),
  maxRoomMembers: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomMembers),
  maxRoomEvents: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomEvents),
  maxRoomRounds: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomRounds),
  maxAgentPairMessages: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxAgentPairMessages),
  maxRoomDurationSeconds: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomDurationSeconds),
  maxRoomReasoningUnits: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomReasoningUnits),
  maxRoomCostUsd: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomCostUsd),
  maxPresenceLifetimeSeconds: z.literal(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxPresenceLifetimeSeconds),
}).strict();

export const hermesBotModeCompatibilityEvidenceSchemaV1 = z.object({
  hermesPackageVersion: z.string().min(1).max(80),
  hermesRevision: z.string().regex(/^[a-f0-9]{40}$/),
  observationContract: z.string().min(1).max(120),
  sourceMode: agentTeamSafeCodeSchemaV1,
  readCapabilities: z.array(agentTeamSafeCodeSchemaV1).max(12),
  writeCapabilities: z.array(agentTeamSafeCodeSchemaV1).max(12),
  nativeQualified: z.boolean(),
  sharesProviderAccess: z.boolean(),
  fullMessageReads: z.boolean(),
}).strict();

export const hermesBotModeProfileObservationSchemaV1 = z.object({
  profileKeyDigest: agentTeamDigestSchemaV1,
  identityEvidenceDigest: agentTeamDigestSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  displayName: agentTeamLabelSchemaV1,
  handle: agentTeamSafeIdSchemaV1,
  role: agentTeamLabelSchemaV1,
  deviceKeyDigest: agentTeamDigestSchemaV1,
  deviceLabel: agentTeamLabelSchemaV1,
  platform: agentTeamPlatformSchemaV1,
  modelClass: agentTeamSafeCodeSchemaV1,
  sourceState: z.enum(["enabled", "disabled", "unknown"]),
  queuedWorkCount: z.number().int().min(0).max(10_000),
  needsOwner: z.boolean(),
  reviewedPackageIds: z.array(agentTeamSafeIdSchemaV1).max(24),
  sharedProviderAccess: z.literal(false),
  fullProfileIncluded: z.literal(false),
}).strict();

export const hermesBotModePresenceEvidenceSchemaV1 = z.object({
  profileKeyDigest: agentTeamDigestSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  basis: z.enum(["active_lease", "authenticated_heartbeat"]),
  evidenceDigest: agentTeamDigestSchemaV1,
  observedAt: agentTeamTimeSchemaV1,
  validUntil: agentTeamTimeSchemaV1,
  currentWorkItemId: agentTeamSafeIdSchemaV1,
  currentWorkSummary: agentTeamSummarySchemaV1,
}).strict();

export const hermesBotModeRoutineObservationSchemaV1 = z.object({
  routineKeyDigest: agentTeamDigestSchemaV1,
  scheduleKeyDigest: agentTeamDigestSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  profileKeyDigest: agentTeamDigestSchemaV1,
  label: agentTeamLabelSchemaV1,
  safeSummary: agentTeamSummarySchemaV1,
  state: z.enum(["scheduled", "running", "blocked", "disabled", "unknown"]),
  nextOccurrenceAt: agentTeamTimeSchemaV1.optional(),
  lastOutcomeCode: agentTeamSafeCodeSchemaV1.optional(),
  needsOwner: z.boolean(),
  scheduleObservedOnly: z.literal(true),
  commandCapable: z.literal(false),
  providerAccess: z.literal(false),
}).strict();

export const hermesBotModeRoomEventObservationSchemaV1 = z.object({
  eventKeyDigest: agentTeamDigestSchemaV1,
  sequence: z.number().int().min(1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomEvents),
  round: z.number().int().min(1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomRounds),
  authorKind: z.enum(["owner", "agent", "system"]),
  authorProfileKeyDigest: agentTeamDigestSchemaV1.optional(),
  safeSummary: agentTeamSummarySchemaV1,
  mentionedProfileKeyDigests: z.array(agentTeamDigestSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomMembers),
  mentionsOwner: z.boolean(),
  needsOwner: z.boolean(),
  occurredAt: agentTeamTimeSchemaV1,
  fullMessageIncluded: z.literal(false),
  providerOutputIncluded: z.literal(false),
}).strict().superRefine((value, context) => {
  if ((value.authorKind === "agent") !== Boolean(value.authorProfileKeyDigest)) {
    context.addIssue({ code: "custom", message: "agent authors require one profile identity" });
  }
});

export const hermesBotModeRoomObservationSchemaV1 = z.object({
  roomKeyDigest: agentTeamDigestSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  label: agentTeamLabelSchemaV1,
  purpose: z.enum(["planning", "build", "review", "research", "incident"]),
  state: z.enum(["open", "paused", "needs_owner", "closed", "unknown"]),
  memberProfileKeyDigests: z.array(agentTeamDigestSchemaV1).min(2).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomMembers),
  currentRound: z.number().int().min(1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomRounds),
  events: z.array(hermesBotModeRoomEventObservationSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomEvents),
  linkedWorkItemIds: z.array(agentTeamSafeIdSchemaV1).max(20),
  linkedIncidentIds: z.array(agentTeamSafeIdSchemaV1).max(20),
  needsOwner: z.boolean(),
  fullMessagesIncluded: z.literal(false),
  sharedProviderAccess: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
}).strict();

export const hermesBotModeObservationSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_OBSERVATION_V1),
  sourceMode: z.literal("injected_only"),
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  observedAt: agentTeamTimeSchemaV1,
  evaluatedAt: agentTeamTimeSchemaV1,
  collectionTruth: z.object({
    profiles: collectionTruthSchema,
    routines: collectionTruthSchema,
    rooms: collectionTruthSchema,
    events: collectionTruthSchema,
  }).strict(),
  profiles: z.array(hermesBotModeProfileObservationSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxProfiles),
  presenceEvidence: z.array(hermesBotModePresenceEvidenceSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxProfiles),
  routines: z.array(hermesBotModeRoutineObservationSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoutines),
  rooms: z.array(hermesBotModeRoomObservationSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRooms),
  resourceCeilings: hermesBotModeResourceCeilingsSchemaV1,
  nativeQualified: z.literal(false),
  rpcObserved: z.literal(false),
  networkObserved: z.literal(false),
  retainsFullMessages: z.literal(false),
  sharesProviderAccess: z.literal(false),
  createsSchedules: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
  grantsApproval: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export const hermesBotModeIdentityBindingSchemaV1 = z.object({
  agentId: agentTeamSafeIdSchemaV1,
  profileKeyDigest: agentTeamDigestSchemaV1,
  deviceKeyDigest: agentTeamDigestSchemaV1,
  identityEvidenceDigest: agentTeamDigestSchemaV1,
  identityBasis: z.literal("injected_digest_attestation"),
  workingEvidence: z.object({
    basis: z.enum(["active_lease", "authenticated_heartbeat"]),
    evidenceDigest: agentTeamDigestSchemaV1,
    observedAt: agentTeamTimeSchemaV1,
    validUntil: agentTeamTimeSchemaV1,
    currentWorkItemId: agentTeamSafeIdSchemaV1,
    currentWorkSummary: agentTeamSummarySchemaV1,
  }).strict().optional(),
  nativeQualified: z.literal(false),
}).strict();

export const hermesBotModeSafeProjectionSchemaV1 = z.object({
  contractVersion: z.literal(HERMES_BOT_MODE_PROJECTION_V1),
  adapterId: z.literal(HERMES_BOT_MODE_ADAPTER_V1),
  adapterVersion: z.literal(HERMES_BOT_MODE_ADAPTER_VERSION_V1),
  sourceMode: z.literal("injected_only"),
  tenantId: agentTeamSafeIdSchemaV1,
  workspaceId: agentTeamSafeIdSchemaV1,
  projectId: agentTeamSafeIdSchemaV1,
  observedAt: agentTeamTimeSchemaV1,
  evaluatedAt: agentTeamTimeSchemaV1,
  collectionTruth: z.object({
    profiles: collectionTruthSchema,
    routines: collectionTruthSchema,
    rooms: collectionTruthSchema,
    events: collectionTruthSchema,
  }).strict(),
  manifestDigest: agentTeamDigestSchemaV1,
  observationDigest: agentTeamDigestSchemaV1,
  identityBindings: z.array(hermesBotModeIdentityBindingSchemaV1).max(HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxProfiles),
  workspace: agentTeamWorkspaceSchemaV1.nullable(),
  nativeQualified: z.literal(false),
  retainsFullMessages: z.literal(false),
  sharesProviderAccess: z.literal(false),
  createsSchedules: z.literal(false),
  createsWorkItems: z.literal(false),
  dispatchesWork: z.literal(false),
  grantsApproval: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  projectionDigest: agentTeamDigestSchemaV1,
}).strict();
