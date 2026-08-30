import type { AgentPlatformV1, AgentTeamWorkspaceV1 } from "./types";

export const HERMES_BOT_MODE_OBSERVATION_V1 = "control-room-hermes-bot-mode-observation/v1" as const;
export const HERMES_BOT_MODE_PROJECTION_V1 = "control-room-hermes-bot-mode-projection/v1" as const;
export const HERMES_BOT_MODE_ADAPTER_V1 = "adapter.hermes.bot-mode.read.v1" as const;
export const HERMES_BOT_MODE_ADAPTER_VERSION_V1 = "1.0.0" as const;

export const HERMES_BOT_MODE_RESOURCE_CEILINGS_V1 = Object.freeze({
  maxProfiles: 100,
  maxRoutines: 500,
  maxRooms: 100,
  maxRoomMembers: 6,
  maxRoomEvents: 10,
  maxRoomRounds: 3,
  maxAgentPairMessages: 4,
  maxRoomDurationSeconds: 1_800,
  maxRoomReasoningUnits: 100_000,
  maxRoomCostUsd: 25,
  maxPresenceLifetimeSeconds: 300,
} as const);

export type HermesBotModeCollectionTruthV1 = "observed" | "absent" | "unknown";
export type HermesBotModeSourceProfileStateV1 = "enabled" | "disabled" | "unknown";

export interface HermesBotModeManifestV1 {
  adapterId: typeof HERMES_BOT_MODE_ADAPTER_V1;
  adapterVersion: typeof HERMES_BOT_MODE_ADAPTER_VERSION_V1;
  observationContract: typeof HERMES_BOT_MODE_OBSERVATION_V1;
  projectionContract: typeof HERMES_BOT_MODE_PROJECTION_V1;
  hermesPackageVersion: "0.20.6";
  hermesRevision: string;
  compatibilityAuthority: "accepted_hermes_agent_revision";
  researchContextOnly: readonly [
    "hermes_agent_bot_mode_guide",
    "hermes_bot_mode_repository",
    "hermes_profile_routing",
  ];
  sourceMode: "injected_only";
  supportedReads: readonly ["profiles", "rooms", "routines", "safe_summary_events"];
  prohibitedReads: readonly ["full_messages", "raw_prompts", "memory", "native_profiles", "provider_sessions", "mcp_configuration"];
  supportedWrites: readonly [];
  nativeQualified: false;
  sharesProviderAccess: false;
  createsSchedules: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsLeaseAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  resourceCeilings: typeof HERMES_BOT_MODE_RESOURCE_CEILINGS_V1;
  manifestDigest: string;
}

export interface HermesBotModeCompatibilityEvidenceV1 {
  hermesPackageVersion: string;
  hermesRevision: string;
  observationContract: string;
  sourceMode: string;
  readCapabilities: string[];
  writeCapabilities: string[];
  nativeQualified: boolean;
  sharesProviderAccess: boolean;
  fullMessageReads: boolean;
}

export type HermesBotModeCompatibilityReasonV1 =
  | "invalid_evidence"
  | "version_drift"
  | "revision_drift"
  | "contract_drift"
  | "source_mode_drift"
  | "read_capability_drift"
  | "write_capability_present"
  | "native_qualification_claimed"
  | "provider_sharing_claimed"
  | "full_message_read_claimed";

export interface HermesBotModeCompatibilityDecisionV1 {
  compatible: boolean;
  reasons: HermesBotModeCompatibilityReasonV1[];
}

export interface HermesBotModeProfileObservationV1 {
  profileKeyDigest: string;
  identityEvidenceDigest: string;
  projectId: string;
  displayName: string;
  handle: string;
  role: string;
  deviceKeyDigest: string;
  deviceLabel: string;
  platform: AgentPlatformV1;
  modelClass: string;
  sourceState: HermesBotModeSourceProfileStateV1;
  queuedWorkCount: number;
  needsOwner: boolean;
  reviewedPackageIds: string[];
  sharedProviderAccess: false;
  fullProfileIncluded: false;
}

export interface HermesBotModePresenceEvidenceV1 {
  profileKeyDigest: string;
  projectId: string;
  basis: "active_lease" | "authenticated_heartbeat";
  evidenceDigest: string;
  observedAt: string;
  validUntil: string;
  currentWorkItemId: string;
  currentWorkSummary: string;
}

export interface HermesBotModeRoutineObservationV1 {
  routineKeyDigest: string;
  scheduleKeyDigest: string;
  projectId: string;
  profileKeyDigest: string;
  label: string;
  safeSummary: string;
  state: "scheduled" | "running" | "blocked" | "disabled" | "unknown";
  nextOccurrenceAt?: string;
  lastOutcomeCode?: string;
  needsOwner: boolean;
  scheduleObservedOnly: true;
  commandCapable: false;
  providerAccess: false;
}

export interface HermesBotModeRoomEventObservationV1 {
  eventKeyDigest: string;
  sequence: number;
  round: number;
  authorKind: "owner" | "agent" | "system";
  authorProfileKeyDigest?: string;
  safeSummary: string;
  mentionedProfileKeyDigests: string[];
  mentionsOwner: boolean;
  needsOwner: boolean;
  occurredAt: string;
  fullMessageIncluded: false;
  providerOutputIncluded: false;
}

export interface HermesBotModeRoomObservationV1 {
  roomKeyDigest: string;
  projectId: string;
  label: string;
  purpose: "planning" | "build" | "review" | "research" | "incident";
  state: "open" | "paused" | "needs_owner" | "closed" | "unknown";
  memberProfileKeyDigests: string[];
  currentRound: number;
  events: HermesBotModeRoomEventObservationV1[];
  linkedWorkItemIds: string[];
  linkedIncidentIds: string[];
  needsOwner: boolean;
  fullMessagesIncluded: false;
  sharedProviderAccess: false;
  createsWorkItems: false;
  dispatchesWork: false;
}

export interface HermesBotModeObservationV1 {
  contractVersion: typeof HERMES_BOT_MODE_OBSERVATION_V1;
  sourceMode: "injected_only";
  tenantId: string;
  workspaceId: string;
  projectId: string;
  observedAt: string;
  evaluatedAt: string;
  collectionTruth: {
    profiles: HermesBotModeCollectionTruthV1;
    routines: HermesBotModeCollectionTruthV1;
    rooms: HermesBotModeCollectionTruthV1;
    events: HermesBotModeCollectionTruthV1;
  };
  profiles: HermesBotModeProfileObservationV1[];
  presenceEvidence: HermesBotModePresenceEvidenceV1[];
  routines: HermesBotModeRoutineObservationV1[];
  rooms: HermesBotModeRoomObservationV1[];
  resourceCeilings: typeof HERMES_BOT_MODE_RESOURCE_CEILINGS_V1;
  nativeQualified: false;
  rpcObserved: false;
  networkObserved: false;
  retainsFullMessages: false;
  sharesProviderAccess: false;
  createsSchedules: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsLeaseAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface HermesBotModeIdentityBindingV1 {
  agentId: string;
  profileKeyDigest: string;
  deviceKeyDigest: string;
  identityEvidenceDigest: string;
  identityBasis: "injected_digest_attestation";
  workingEvidence?: {
    basis: "active_lease" | "authenticated_heartbeat";
    evidenceDigest: string;
    observedAt: string;
    validUntil: string;
    currentWorkItemId: string;
    currentWorkSummary: string;
  };
  nativeQualified: false;
}

export interface HermesBotModeSafeProjectionV1 {
  contractVersion: typeof HERMES_BOT_MODE_PROJECTION_V1;
  adapterId: typeof HERMES_BOT_MODE_ADAPTER_V1;
  adapterVersion: typeof HERMES_BOT_MODE_ADAPTER_VERSION_V1;
  sourceMode: "injected_only";
  tenantId: string;
  workspaceId: string;
  projectId: string;
  observedAt: string;
  evaluatedAt: string;
  collectionTruth: HermesBotModeObservationV1["collectionTruth"];
  manifestDigest: string;
  observationDigest: string;
  identityBindings: HermesBotModeIdentityBindingV1[];
  workspace: AgentTeamWorkspaceV1 | null;
  nativeQualified: false;
  retainsFullMessages: false;
  sharesProviderAccess: false;
  createsSchedules: false;
  createsWorkItems: false;
  dispatchesWork: false;
  grantsApproval: false;
  grantsLeaseAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
  projectionDigest: string;
}

export interface HermesBotModeReadAdapterV1 {
  manifest: HermesBotModeManifestV1;
  evaluateCompatibility(evidence: unknown): HermesBotModeCompatibilityDecisionV1;
  normalizeObservation(observation: unknown): HermesBotModeSafeProjectionV1;
}

export interface HermesBotModeConformanceFixtureV1 {
  name: string;
  observation: unknown;
  expectedProfiles: number;
  expectedRooms: number;
  expectedRoutines: number;
  expectedWorking: number;
}

export type HermesBotModeConformanceReasonV1 =
  | "adapter_shape_invalid"
  | "compatibility_rejected"
  | "fixture_invalid"
  | "normalization_failed"
  | "authority_ceiling_failed";

export interface HermesBotModeConformanceResultV1 {
  adapterId: string;
  compatible: boolean;
  fixtureCount: number;
  normalizedProfiles: number;
  normalizedRooms: number;
  normalizedRoutines: number;
  checks: {
    exactPin: boolean;
    injectedOnly: boolean;
    safeProjection: boolean;
    resourceCeilings: boolean;
    negativeAuthority: boolean;
  };
  reasons: HermesBotModeConformanceReasonV1[];
}
