import { sha256Digest } from "../../security";
import { HERMES_PINNED_REVISION_V1 } from "../../harness/hermes-v1";
import { AgentTeamContractErrorV1 } from "./errors";
import { parseExactAgentTeamV1 } from "./exact";
import {
  hermesBotModeCompatibilityEvidenceSchemaV1,
  hermesBotModeObservationSchemaV1,
  hermesBotModeProfileObservationSchemaV1,
  hermesBotModeRoomEventObservationSchemaV1,
  hermesBotModeRoomObservationSchemaV1,
  hermesBotModeRoutineObservationSchemaV1,
  hermesBotModeSafeProjectionSchemaV1,
} from "./hermes-bot-mode-schemas";
import {
  HERMES_BOT_MODE_ADAPTER_V1,
  HERMES_BOT_MODE_ADAPTER_VERSION_V1,
  HERMES_BOT_MODE_OBSERVATION_V1,
  HERMES_BOT_MODE_PROJECTION_V1,
  HERMES_BOT_MODE_RESOURCE_CEILINGS_V1,
  type HermesBotModeCompatibilityDecisionV1,
  type HermesBotModeCompatibilityEvidenceV1,
  type HermesBotModeIdentityBindingV1,
  type HermesBotModeManifestV1,
  type HermesBotModeObservationV1,
  type HermesBotModePresenceEvidenceV1,
  type HermesBotModeProfileObservationV1,
  type HermesBotModeReadAdapterV1,
  type HermesBotModeRoomEventObservationV1,
  type HermesBotModeRoomObservationV1,
  type HermesBotModeRoutineObservationV1,
  type HermesBotModeSafeProjectionV1,
} from "./hermes-bot-mode-types";
import type { AgentRoomMessageV1, AgentRoutineV1, AgentTeamMemberV1, AgentWarRoomV1 } from "./types";
import { buildAgentTeamWorkspaceV1, parseAgentTeamWorkspaceV1 } from "./workspace";

const REQUIRED_READS = ["profiles", "rooms", "routines", "safe_summary_events"] as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

const unsignedManifest: Omit<HermesBotModeManifestV1, "manifestDigest"> = {
  adapterId: HERMES_BOT_MODE_ADAPTER_V1,
  adapterVersion: HERMES_BOT_MODE_ADAPTER_VERSION_V1,
  observationContract: HERMES_BOT_MODE_OBSERVATION_V1,
  projectionContract: HERMES_BOT_MODE_PROJECTION_V1,
  hermesPackageVersion: "0.20.6",
  hermesRevision: HERMES_PINNED_REVISION_V1,
  compatibilityAuthority: "accepted_hermes_agent_revision",
  researchContextOnly: ["hermes_agent_bot_mode_guide", "hermes_bot_mode_repository", "hermes_profile_routing"],
  sourceMode: "injected_only",
  supportedReads: REQUIRED_READS,
  prohibitedReads: ["full_messages", "raw_prompts", "memory", "native_profiles", "provider_sessions", "mcp_configuration"],
  supportedWrites: [],
  nativeQualified: false,
  sharesProviderAccess: false,
  createsSchedules: false,
  createsWorkItems: false,
  dispatchesWork: false,
  grantsApproval: false,
  grantsLeaseAuthority: false,
  grantsCommandAuthority: false,
  grantsExecutionAuthority: false,
  resourceCeilings: HERMES_BOT_MODE_RESOURCE_CEILINGS_V1,
};

export const hermesBotModeManifestV1: HermesBotModeManifestV1 = deepFreeze({
  ...unsignedManifest,
  manifestDigest: sha256Digest(unsignedManifest),
});

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function evaluateHermesBotModeCompatibilityV1(evidenceValue: unknown): HermesBotModeCompatibilityDecisionV1 {
  let evidence: HermesBotModeCompatibilityEvidenceV1;
  try {
    evidence = parseExactAgentTeamV1(hermesBotModeCompatibilityEvidenceSchemaV1, evidenceValue) as HermesBotModeCompatibilityEvidenceV1;
  } catch {
    return deepFreeze({ compatible: false, reasons: ["invalid_evidence"] });
  }
  const reasons: HermesBotModeCompatibilityDecisionV1["reasons"] = [];
  if (evidence.hermesPackageVersion !== hermesBotModeManifestV1.hermesPackageVersion) reasons.push("version_drift");
  if (evidence.hermesRevision !== hermesBotModeManifestV1.hermesRevision) reasons.push("revision_drift");
  if (evidence.observationContract !== HERMES_BOT_MODE_OBSERVATION_V1) reasons.push("contract_drift");
  if (evidence.sourceMode !== "injected_only") reasons.push("source_mode_drift");
  if (!sameOrderedStrings(evidence.readCapabilities, REQUIRED_READS)) reasons.push("read_capability_drift");
  if (evidence.writeCapabilities.length !== 0) reasons.push("write_capability_present");
  if (evidence.nativeQualified !== false) reasons.push("native_qualification_claimed");
  if (evidence.sharesProviderAccess !== false) reasons.push("provider_sharing_claimed");
  if (evidence.fullMessageReads !== false) reasons.push("full_message_read_claimed");
  return deepFreeze({ compatible: reasons.length === 0, reasons });
}

function digestId(prefix: string, value: unknown, length = 24): string {
  return `${prefix}.${sha256Digest(value).slice("sha256:".length, "sha256:".length + length)}`;
}

function milliseconds(value: string): number {
  return Date.parse(value);
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new AgentTeamContractErrorV1("invalid_input");
}

function collectionMatches(truth: "observed" | "absent" | "unknown", count: number): boolean {
  return truth === "observed" ? count > 0 : count === 0;
}

function validateObservationBindings(observation: HermesBotModeObservationV1): void {
  if (milliseconds(observation.evaluatedAt) < milliseconds(observation.observedAt)) throw new AgentTeamContractErrorV1("invalid_input");
  const eventCount = observation.rooms.reduce((total, room) => total + room.events.length, 0);
  if (!collectionMatches(observation.collectionTruth.profiles, observation.profiles.length)
    || !collectionMatches(observation.collectionTruth.routines, observation.routines.length)
    || !collectionMatches(observation.collectionTruth.rooms, observation.rooms.length)
    || !collectionMatches(observation.collectionTruth.events, eventCount)) {
    throw new AgentTeamContractErrorV1("invalid_input");
  }
  if (observation.profiles.length === 0 && (observation.presenceEvidence.length || observation.routines.length || observation.rooms.length)) {
    throw new AgentTeamContractErrorV1("unknown_agent");
  }
  assertUnique(observation.profiles.map((profile) => profile.profileKeyDigest));
  assertUnique(observation.profiles.map((profile) => profile.identityEvidenceDigest));
  assertUnique(observation.presenceEvidence.map((evidence) => evidence.profileKeyDigest));
  assertUnique(observation.presenceEvidence.map((evidence) => evidence.evidenceDigest));
  assertUnique(observation.routines.map((routine) => routine.routineKeyDigest));
  assertUnique(observation.routines.map((routine) => routine.scheduleKeyDigest));
  assertUnique(observation.rooms.map((room) => room.roomKeyDigest));
  const profileKeys = new Set(observation.profiles.map((profile) => profile.profileKeyDigest));
  for (const profile of observation.profiles) if (profile.projectId !== observation.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
  for (const evidence of observation.presenceEvidence) {
    if (evidence.projectId !== observation.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    if (!profileKeys.has(evidence.profileKeyDigest)) throw new AgentTeamContractErrorV1("unknown_agent");
    const observed = milliseconds(evidence.observedAt);
    const validUntil = milliseconds(evidence.validUntil);
    const lifetime = validUntil - observed;
    if (observed > milliseconds(observation.observedAt) || lifetime <= 0
      || lifetime > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxPresenceLifetimeSeconds * 1_000) {
      throw new AgentTeamContractErrorV1("presence_unproved");
    }
    const profile = observation.profiles.find((candidate) => candidate.profileKeyDigest === evidence.profileKeyDigest);
    if (!profile || profile.sourceState !== "enabled") throw new AgentTeamContractErrorV1("presence_unproved");
  }
  for (const routine of observation.routines) {
    if (routine.projectId !== observation.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    if (!profileKeys.has(routine.profileKeyDigest)) throw new AgentTeamContractErrorV1("unknown_agent");
    if (routine.state === "scheduled" && !routine.nextOccurrenceAt) throw new AgentTeamContractErrorV1("invalid_input");
    if (["disabled", "unknown"].includes(routine.state) && routine.nextOccurrenceAt) throw new AgentTeamContractErrorV1("invalid_input");
  }
  for (const room of observation.rooms) {
    if (room.projectId !== observation.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
    assertUnique(room.memberProfileKeyDigests);
    assertUnique(room.events.map((event) => event.eventKeyDigest));
    for (const member of room.memberProfileKeyDigests) if (!profileKeys.has(member)) throw new AgentTeamContractErrorV1("unknown_agent");
    let priorOccurredAt = 0;
    let firstOccurredAt = 0;
    let priorRound = 0;
    for (const [index, event] of room.events.entries()) {
      if (event.sequence !== index + 1 || event.round > room.currentRound || event.round < priorRound) {
        throw new AgentTeamContractErrorV1("room_budget_exceeded");
      }
      const occurredAt = milliseconds(event.occurredAt);
      if (occurredAt < priorOccurredAt || occurredAt > milliseconds(observation.observedAt)) {
        throw new AgentTeamContractErrorV1("room_budget_exceeded");
      }
      if (index === 0) firstOccurredAt = occurredAt;
      if (occurredAt - firstOccurredAt > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxRoomDurationSeconds * 1_000) {
        throw new AgentTeamContractErrorV1("room_budget_exceeded");
      }
      priorOccurredAt = occurredAt;
      priorRound = event.round;
      if (event.authorProfileKeyDigest && !room.memberProfileKeyDigests.includes(event.authorProfileKeyDigest)) {
        throw new AgentTeamContractErrorV1("unknown_agent");
      }
      assertUnique(event.mentionedProfileKeyDigests);
      for (const mentioned of event.mentionedProfileKeyDigests) {
        if (!room.memberProfileKeyDigests.includes(mentioned) || mentioned === event.authorProfileKeyDigest) {
          throw new AgentTeamContractErrorV1("unknown_agent");
        }
      }
    }
    if (room.state === "needs_owner" && !room.needsOwner) throw new AgentTeamContractErrorV1("invalid_input");
    if (room.state !== "needs_owner" && room.state !== "unknown" && room.needsOwner) throw new AgentTeamContractErrorV1("invalid_input");
  }
}

interface ProfileNormalizationContextV1 {
  tenantId: string;
  workspaceId: string;
  projectId: string;
  observedAt: string;
  evaluatedAt: string;
  routineCount: number;
  presenceEvidence?: HermesBotModePresenceEvidenceV1;
}

function normalizeHermesBotModeProfileV1(
  value: unknown,
  context: ProfileNormalizationContextV1,
): { member: AgentTeamMemberV1; binding: HermesBotModeIdentityBindingV1 } {
  const profile = parseExactAgentTeamV1(hermesBotModeProfileObservationSchemaV1, value) as HermesBotModeProfileObservationV1;
  if (profile.projectId !== context.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
  const agentId = digestId("agent.hermes", {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    profileKeyDigest: profile.profileKeyDigest,
    deviceKeyDigest: profile.deviceKeyDigest,
  });
  const evidence = context.presenceEvidence;
  const fresh = Boolean(evidence
    && milliseconds(context.evaluatedAt) >= milliseconds(evidence.observedAt)
    && milliseconds(context.evaluatedAt) <= milliseconds(evidence.validUntil));
  if (fresh && profile.sourceState !== "enabled") throw new AgentTeamContractErrorV1("presence_unproved");
  const member: AgentTeamMemberV1 = {
    agentId,
    projectId: context.projectId,
    displayName: profile.displayName,
    handle: `${profile.handle}@${profile.deviceKeyDigest.slice(-10)}`,
    kind: "hermes",
    role: profile.role,
    deviceLabel: profile.deviceLabel,
    platform: profile.platform,
    modelClass: profile.modelClass,
    status: fresh ? "working" : evidence ? "stale" : profile.sourceState === "enabled" ? "available" : profile.sourceState === "disabled" ? "offline" : "stale",
    presenceBasis: fresh ? evidence!.basis : profile.sourceState === "disabled" ? "none" : "last_known",
    ...(fresh ? {
      lastObservedAt: evidence!.observedAt,
      currentWorkItemId: evidence!.currentWorkItemId,
      currentWorkSummary: evidence!.currentWorkSummary,
    } : profile.sourceState === "disabled" ? {} : { lastObservedAt: evidence?.observedAt ?? context.observedAt }),
    queuedWorkCount: profile.queuedWorkCount,
    routineCount: context.routineCount,
    needsOwner: profile.needsOwner,
    reviewedPackageIds: profile.reviewedPackageIds,
    profileIsProjection: true,
    grantsProviderAccess: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return {
    member,
    binding: {
      agentId,
      profileKeyDigest: profile.profileKeyDigest,
      deviceKeyDigest: profile.deviceKeyDigest,
      identityEvidenceDigest: profile.identityEvidenceDigest,
      identityBasis: "injected_digest_attestation",
      ...(fresh ? {
        workingEvidence: {
          basis: evidence!.basis,
          evidenceDigest: evidence!.evidenceDigest,
          observedAt: evidence!.observedAt,
          validUntil: evidence!.validUntil,
          currentWorkItemId: evidence!.currentWorkItemId,
          currentWorkSummary: evidence!.currentWorkSummary,
        },
      } : {}),
      nativeQualified: false,
    },
  };
}

function normalizeHermesBotModeRoutineV1(
  value: unknown,
  context: { projectId: string; agentIdByProfile: ReadonlyMap<string, string> },
): AgentRoutineV1 {
  const routine = parseExactAgentTeamV1(hermesBotModeRoutineObservationSchemaV1, value) as HermesBotModeRoutineObservationV1;
  if (routine.projectId !== context.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
  const agentId = context.agentIdByProfile.get(routine.profileKeyDigest);
  if (!agentId) throw new AgentTeamContractErrorV1("unknown_agent");
  return {
    routineId: digestId("routine.hermes", { projectId: context.projectId, routineKeyDigest: routine.routineKeyDigest }),
    projectId: context.projectId,
    agentId,
    scheduleId: digestId("schedule.hermes", { projectId: context.projectId, scheduleKeyDigest: routine.scheduleKeyDigest }),
    label: routine.label,
    safeSummary: routine.safeSummary,
    state: routine.state === "unknown" ? "blocked" : routine.state,
    ...(routine.nextOccurrenceAt ? { nextOccurrenceAt: routine.nextOccurrenceAt } : {}),
    ...(routine.lastOutcomeCode ? { lastOutcomeCode: routine.lastOutcomeCode } : {}),
    needsOwner: routine.needsOwner,
    scheduleIsAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
}

function normalizeHermesBotModeRoomEventV1(
  value: unknown,
  context: { roomId: string; agentIdByProfile: ReadonlyMap<string, string> },
): AgentRoomMessageV1 {
  const event = parseExactAgentTeamV1(hermesBotModeRoomEventObservationSchemaV1, value) as HermesBotModeRoomEventObservationV1;
  const authorId = event.authorKind === "owner" ? "owner"
    : event.authorKind === "system" ? "system.hermes.bot_mode"
      : context.agentIdByProfile.get(event.authorProfileKeyDigest ?? "");
  if (!authorId) throw new AgentTeamContractErrorV1("unknown_agent");
  const mentionedAgentIds = event.mentionedProfileKeyDigests.map((key) => {
    const agentId = context.agentIdByProfile.get(key);
    if (!agentId) throw new AgentTeamContractErrorV1("unknown_agent");
    return agentId;
  });
  return {
    messageId: digestId("message.hermes", { roomId: context.roomId, eventKeyDigest: event.eventKeyDigest }),
    sequence: event.sequence,
    round: event.round,
    authorKind: event.authorKind,
    authorId,
    safeSummary: event.safeSummary,
    mentionedAgentIds,
    mentionsOwner: event.mentionsOwner,
    needsOwner: event.needsOwner,
    occurredAt: event.occurredAt,
    createsWorkItem: false,
    grantsAuthority: false,
  };
}

function normalizeHermesBotModeRoomV1(
  value: unknown,
  context: { projectId: string; agentIdByProfile: ReadonlyMap<string, string> },
): AgentWarRoomV1 {
  const room = parseExactAgentTeamV1(hermesBotModeRoomObservationSchemaV1, value) as HermesBotModeRoomObservationV1;
  if (room.projectId !== context.projectId) throw new AgentTeamContractErrorV1("scope_mismatch");
  const roomId = digestId("room.hermes", { projectId: context.projectId, roomKeyDigest: room.roomKeyDigest });
  const memberAgentIds = room.memberProfileKeyDigests.map((key) => {
    const agentId = context.agentIdByProfile.get(key);
    if (!agentId) throw new AgentTeamContractErrorV1("unknown_agent");
    return agentId;
  });
  return {
    roomId,
    projectId: context.projectId,
    label: room.label,
    purpose: room.purpose,
    state: room.state === "unknown" ? room.needsOwner ? "needs_owner" : "paused" : room.state,
    memberAgentIds,
    currentRound: room.currentRound,
    messages: room.events.map((event) => normalizeHermesBotModeRoomEventV1(event, { roomId, agentIdByProfile: context.agentIdByProfile })),
    linkedWorkItemIds: room.linkedWorkItemIds,
    linkedIncidentIds: room.linkedIncidentIds,
    needsOwner: room.needsOwner,
    maxRounds: 3,
    maxMessages: 10,
    maxAgentPairMessages: 4,
    maxDurationSeconds: 1_800,
    maxReasoningUnits: 100_000,
    maxCostUsd: 25,
    canonicalAuditRequired: true,
    chatIsOrchestrationAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
}

function unsignedProjection(value: HermesBotModeSafeProjectionV1): Omit<HermesBotModeSafeProjectionV1, "projectionDigest"> {
  const { projectionDigest: _projectionDigest, ...unsigned } = value;
  void _projectionDigest;
  return unsigned;
}

export function normalizeHermesBotModeObservationV1(observationValue: unknown): HermesBotModeSafeProjectionV1 {
  const observation = parseExactAgentTeamV1(hermesBotModeObservationSchemaV1, observationValue) as HermesBotModeObservationV1;
  validateObservationBindings(observation);
  const presenceByProfile = new Map(observation.presenceEvidence.map((evidence) => [evidence.profileKeyDigest, evidence]));
  const routineCounts = new Map<string, number>();
  for (const routine of observation.routines) routineCounts.set(routine.profileKeyDigest, (routineCounts.get(routine.profileKeyDigest) ?? 0) + 1);
  const normalizedProfiles = observation.profiles.map((profile) => normalizeHermesBotModeProfileV1(profile, {
    tenantId: observation.tenantId,
    workspaceId: observation.workspaceId,
    projectId: observation.projectId,
    observedAt: observation.observedAt,
    evaluatedAt: observation.evaluatedAt,
    routineCount: routineCounts.get(profile.profileKeyDigest) ?? 0,
    presenceEvidence: presenceByProfile.get(profile.profileKeyDigest),
  }));
  assertUnique(normalizedProfiles.map(({ member }) => member.agentId));
  assertUnique(normalizedProfiles.map(({ member }) => member.handle));
  const agentIdByProfile = new Map(normalizedProfiles.map(({ binding }) => [binding.profileKeyDigest, binding.agentId]));
  const routines = observation.routines.map((routine) => normalizeHermesBotModeRoutineV1(routine, { projectId: observation.projectId, agentIdByProfile }));
  const rooms = observation.rooms.map((room) => normalizeHermesBotModeRoomV1(room, { projectId: observation.projectId, agentIdByProfile }));
  const observationDigest = sha256Digest(observation);
  const workspace = normalizedProfiles.length === 0 ? null : buildAgentTeamWorkspaceV1({
    workspaceViewId: digestId("workspace.hermes.bot", {
      tenantId: observation.tenantId,
      workspaceId: observation.workspaceId,
      projectId: observation.projectId,
    }),
    tenantId: observation.tenantId,
    workspaceId: observation.workspaceId,
    projectId: observation.projectId,
    generatedAt: observation.evaluatedAt,
    agents: normalizedProfiles.map(({ member }) => member),
    routines,
    rooms,
    handoffProposals: [],
  });
  const unsigned: Omit<HermesBotModeSafeProjectionV1, "projectionDigest"> = {
    contractVersion: HERMES_BOT_MODE_PROJECTION_V1,
    adapterId: HERMES_BOT_MODE_ADAPTER_V1,
    adapterVersion: HERMES_BOT_MODE_ADAPTER_VERSION_V1,
    sourceMode: "injected_only",
    tenantId: observation.tenantId,
    workspaceId: observation.workspaceId,
    projectId: observation.projectId,
    observedAt: observation.observedAt,
    evaluatedAt: observation.evaluatedAt,
    collectionTruth: observation.collectionTruth,
    manifestDigest: hermesBotModeManifestV1.manifestDigest,
    observationDigest,
    identityBindings: normalizedProfiles.map(({ binding }) => binding),
    workspace,
    nativeQualified: false,
    retainsFullMessages: false,
    sharesProviderAccess: false,
    createsSchedules: false,
    createsWorkItems: false,
    dispatchesWork: false,
    grantsApproval: false,
    grantsLeaseAuthority: false,
    grantsCommandAuthority: false,
    grantsExecutionAuthority: false,
  };
  return deepFreeze(parseExactAgentTeamV1(hermesBotModeSafeProjectionSchemaV1, {
    ...unsigned,
    projectionDigest: sha256Digest(unsigned),
  }) as HermesBotModeSafeProjectionV1);
}

export function parseHermesBotModeProjectionV1(value: unknown): HermesBotModeSafeProjectionV1 {
  const projection = parseExactAgentTeamV1(hermesBotModeSafeProjectionSchemaV1, value) as HermesBotModeSafeProjectionV1;
  if (projection.manifestDigest !== hermesBotModeManifestV1.manifestDigest
    || sha256Digest(unsignedProjection(projection)) !== projection.projectionDigest) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  if (projection.workspace && (projection.workspace.tenantId !== projection.tenantId
    || projection.workspace.workspaceId !== projection.workspaceId
    || projection.workspace.projectId !== projection.projectId)) {
    throw new AgentTeamContractErrorV1("scope_mismatch");
  }
  if (projection.workspace) parseAgentTeamWorkspaceV1(projection.workspace);
  if (!projection.workspace && (projection.identityBindings.length !== 0
    || Object.values(projection.collectionTruth).some((truth) => truth === "observed"))) {
    throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  if (projection.workspace) {
    assertUnique(projection.identityBindings.map((binding) => binding.agentId));
    assertUnique(projection.identityBindings.map((binding) => binding.profileKeyDigest));
    assertUnique(projection.identityBindings.map((binding) => binding.identityEvidenceDigest));
    const agentById = new Map(projection.workspace.agents.map((agent) => [agent.agentId, agent]));
    for (const binding of projection.identityBindings) {
      if (binding.agentId !== digestId("agent.hermes", {
        tenantId: projection.tenantId,
        workspaceId: projection.workspaceId,
        projectId: projection.projectId,
        profileKeyDigest: binding.profileKeyDigest,
        deviceKeyDigest: binding.deviceKeyDigest,
      })) throw new AgentTeamContractErrorV1("digest_mismatch");
      const agent = agentById.get(binding.agentId);
      if (!agent || agent.kind !== "hermes" || !agent.handle.endsWith(`@${binding.deviceKeyDigest.slice(-10)}`)) {
        throw new AgentTeamContractErrorV1("digest_mismatch");
      }
      const evidence = binding.workingEvidence;
      if (agent.status === "working") {
        if (!evidence || agent.presenceBasis !== evidence.basis || agent.lastObservedAt !== evidence.observedAt
          || agent.currentWorkItemId !== evidence.currentWorkItemId || agent.currentWorkSummary !== evidence.currentWorkSummary) {
          throw new AgentTeamContractErrorV1("presence_unproved");
        }
        const observed = milliseconds(evidence.observedAt);
        const validUntil = milliseconds(evidence.validUntil);
        const evaluated = milliseconds(projection.evaluatedAt);
        if (observed > milliseconds(projection.observedAt) || observed > evaluated || validUntil < evaluated || validUntil - observed <= 0
          || validUntil - observed > HERMES_BOT_MODE_RESOURCE_CEILINGS_V1.maxPresenceLifetimeSeconds * 1_000) {
          throw new AgentTeamContractErrorV1("presence_unproved");
        }
      } else if (evidence) {
        throw new AgentTeamContractErrorV1("presence_unproved");
      }
    }
    const boundAgents = [...projection.identityBindings.map((binding) => binding.agentId)].sort();
    const workspaceAgents = [...projection.workspace.agents.map((agent) => agent.agentId)].sort();
    if (boundAgents.join("|") !== workspaceAgents.join("|")
      || projection.workspace.handoffProposals.length !== 0
      || !collectionMatches(projection.collectionTruth.profiles, projection.workspace.agents.length)
      || !collectionMatches(projection.collectionTruth.routines, projection.workspace.routines.length)
      || !collectionMatches(projection.collectionTruth.rooms, projection.workspace.rooms.length)
      || !collectionMatches(projection.collectionTruth.events,
        projection.workspace.rooms.reduce((total, room) => total + room.messages.length, 0))) {
      throw new AgentTeamContractErrorV1("digest_mismatch");
    }
    for (const agent of projection.workspace.agents) {
      const routineCount = projection.workspace.routines.filter((routine) => routine.agentId === agent.agentId).length;
      if (agent.routineCount !== routineCount) throw new AgentTeamContractErrorV1("digest_mismatch");
    }
  }
  return deepFreeze(projection);
}

export const hermesBotModeReadAdapterV1: HermesBotModeReadAdapterV1 = Object.freeze({
  manifest: hermesBotModeManifestV1,
  evaluateCompatibility: evaluateHermesBotModeCompatibilityV1,
  normalizeObservation: normalizeHermesBotModeObservationV1,
});
