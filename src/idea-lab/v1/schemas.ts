import { z } from "zod";

export const IDEA_LAB_SESSION_V1 = "control-room-idea-lab-session/v1" as const;
export const IDEA_LAB_CONTRIBUTION_V1 = "control-room-idea-lab-contribution/v1" as const;
export const IDEA_LAB_SYNTHESIS_V1 = "control-room-idea-lab-synthesis/v1" as const;
export const IDEA_LAB_DECISION_V1 = "control-room-idea-lab-decision/v1" as const;
export const PROJECT_REGISTRY_LIFECYCLE_V1 = "control-room-project-registry-lifecycle/v1" as const;
export const CONTROL_ROOM_IDEA_ADAPTER_V1 = "adapter.control-room-native-ideas" as const;

export const ideaLabPerspectivesV1 = Object.freeze([
  "customer", "market", "skeptic", "finance", "operations", "technology", "growth", "risk",
] as const);
export const projectLifecycleStatesV1 = Object.freeze(["active", "paused", "completed", "archived"] as const);

export const ideaIdSchemaV1 = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const ideaDigestSchemaV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ideaAuthTagSchemaV1 = z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/);
export const ideaTimeSchemaV1 = z.string().datetime({ offset: true });
export const ideaCodeSchemaV1 = z.string().min(2).max(100).regex(/^[a-z][a-z0-9_]*$/);
export const ideaLabelSchemaV1 = z.string().min(1).max(120);
export const ideaTextSchemaV1 = z.string().min(1).max(800);

const nonAuthority = {
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false), grantsLeaseAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  automaticProjectCreationAllowed: z.literal(false),
} as const;

export const ideaParticipantSchemaV1 = z.object({
  participantId: ideaIdSchemaV1, identityDigest: ideaDigestSchemaV1, displayName: ideaLabelSchemaV1,
  perspective: z.enum(ideaLabPerspectivesV1), harness: z.enum(["hermes", "codex", "local_model"]),
  modelClass: ideaCodeSchemaV1, platform: z.enum(["macos", "windows", "linux", "cloud"]),
  sourceMode: z.literal("injected_only"), liveConnected: z.literal(false), canDispatch: z.literal(false),
}).strict();

export const ideaSessionSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_SESSION_V1), sessionId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1, title: ideaLabelSchemaV1, ideaSummary: ideaTextSchemaV1,
  targetCustomer: z.string().min(1).max(300), participants: z.array(ideaParticipantSchemaV1).min(3).max(6),
  maxRounds: z.number().int().min(1).max(3), maxMessages: z.number().int().min(3).max(18),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
  createdByIdentityDigest: ideaDigestSchemaV1, createdAt: ideaTimeSchemaV1,
  liveBotContactAuthorized: z.literal(false), providerContacted: z.literal(false), ...nonAuthority,
  sessionDigest: ideaDigestSchemaV1,
}).strict();

export const ideaContributionSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_CONTRIBUTION_V1), contributionId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1, participantId: ideaIdSchemaV1, participantIdentityDigest: ideaDigestSchemaV1,
  perspective: z.enum(ideaLabPerspectivesV1), round: z.number().int().min(1).max(3),
  safeOpinion: ideaTextSchemaV1, opportunityCode: ideaCodeSchemaV1, primaryRiskCode: ideaCodeSchemaV1,
  suggestedExperiment: z.string().min(1).max(500), confidencePercent: z.number().int().min(0).max(100),
  sourceMode: z.enum(["injected_only", "provider_filtered"]), contributedAt: ideaTimeSchemaV1,
  liveBotContactAuthorized: z.boolean(), providerContacted: z.boolean(), ...nonAuthority,
  contributionDigest: ideaDigestSchemaV1,
}).strict();

export const ideaSynthesisSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_SYNTHESIS_V1), synthesisId: ideaIdSchemaV1, sessionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1, sessionDigest: ideaDigestSchemaV1,
  contributionDigests: z.array(ideaDigestSchemaV1).min(3).max(18), participantCount: z.number().int().min(3).max(6),
  contributionCount: z.number().int().min(3).max(18), marketDemand: z.number().int().min(0).max(100),
  feasibility: z.number().int().min(0).max(100), differentiation: z.number().int().min(0).max(100),
  durability: z.number().int().min(0).max(100), ownerFit: z.number().int().min(0).max(100),
  riskPercent: z.number().int().min(0).max(100), overallScore: z.number().int().min(0).max(100),
  recommendation: z.enum(["promote", "save", "reject"]), executiveSummary: ideaTextSchemaV1,
  nextExperiment: z.string().min(1).max(500), dissentingPerspectiveCodes: z.array(ideaCodeSchemaV1).max(6),
  advisoryOnly: z.literal(true), ownerDecisionRequired: z.literal(true), synthesizedAt: ideaTimeSchemaV1,
  liveBotContactAuthorized: z.boolean(), providerContacted: z.boolean(), ...nonAuthority, synthesisDigest: ideaDigestSchemaV1,
}).strict();

export const projectCreationSpecSchemaV1 = z.object({
  projectId: ideaIdSchemaV1, workspaceName: ideaLabelSchemaV1, title: ideaLabelSchemaV1,
  summary: z.string().min(1).max(600), projectKind: ideaCodeSchemaV1, priority: z.number().int().min(0).max(100),
}).strict();

export const ideaDecisionSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_DECISION_V1), decisionId: ideaIdSchemaV1, sessionId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1, sessionDigest: ideaDigestSchemaV1,
  synthesisDigest: ideaDigestSchemaV1, decision: z.enum(["create_project", "save", "reject"]),
  safeReasonCode: ideaCodeSchemaV1, ownerIdentityDigest: ideaDigestSchemaV1,
  project: projectCreationSpecSchemaV1.optional(), decidedAt: ideaTimeSchemaV1,
  automaticDecision: z.literal(false), ownerDecisionRequired: z.literal(false),
  liveBotContactAuthorized: z.literal(false), providerContacted: z.literal(false), ...nonAuthority,
  decisionDigest: ideaDigestSchemaV1,
}).strict();

export const projectLifecycleEventSchemaV1 = z.object({
  contractVersion: z.literal(PROJECT_REGISTRY_LIFECYCLE_V1), eventId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1, projectId: ideaIdSchemaV1, sourceIdeaSessionId: ideaIdSchemaV1,
  sourceDecisionDigest: ideaDigestSchemaV1, fromState: z.enum(projectLifecycleStatesV1).nullable(),
  toState: z.enum(projectLifecycleStatesV1), version: z.number().int().min(1), actorIdentityDigest: ideaDigestSchemaV1,
  safeReasonCode: ideaCodeSchemaV1, projectSnapshotDigest: ideaDigestSchemaV1, occurredAt: ideaTimeSchemaV1,
  grantsApproval: z.literal(false), grantsCommandAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  eventDigest: ideaDigestSchemaV1,
}).strict();

export const projectRegistryProjectionSchemaV1 = z.object({
  contractVersion: z.literal("control-room-project-registry-projection/v1"), tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1, projectId: ideaIdSchemaV1, sourceIdeaSessionId: ideaIdSchemaV1,
  workspaceName: ideaLabelSchemaV1, title: ideaLabelSchemaV1, summary: z.string().min(1).max(600),
  projectKind: ideaCodeSchemaV1, lifecycleState: z.enum(projectLifecycleStatesV1), priority: z.number().int().min(0).max(100),
  version: z.number().int().min(1), createdAt: ideaTimeSchemaV1, updatedAt: ideaTimeSchemaV1,
  sourceDecisionDigest: ideaDigestSchemaV1, latestEventDigest: ideaDigestSchemaV1,
  monitoringPagePath: z.string().regex(/^\/projects\/[a-zA-Z0-9._:%-]+$/), presentationOnly: z.literal(true),
  canDispatch: z.literal(false), grantsExecutionAuthority: z.literal(false), projectionDigest: ideaDigestSchemaV1,
}).strict();
