import { z } from "zod";

const nativeDateV1 = Date, nativeDateParseV1 = Date.parse, nativeDateToISOStringV1 = Date.prototype.toISOString,
  nativeNumberV1 = Number, nativeNumberIsFiniteV1 = Number.isFinite,
  nativeReflectApplyV1 = Reflect.apply, nativeRegExpExecV1 = RegExp.prototype.exec;
const ideaTimePatternV1 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function capturedPatternMatchesV1(pattern: RegExp, value: string): boolean {
  return nativeReflectApplyV1(nativeRegExpExecV1, pattern, [value]) !== null;
}

function numericTimePartV1(value: string | undefined): number {
  return nativeReflectApplyV1(nativeNumberV1, undefined, [value]) as number;
}

export function capturedIdeaTimeMillisecondsV1(value: string): number | undefined {
  const match = nativeReflectApplyV1(nativeRegExpExecV1, ideaTimePatternV1, [value]) as RegExpExecArray | null;
  if (!match) return undefined;
  const year = numericTimePartV1(match[1]), month = numericTimePartV1(match[2]), day = numericTimePartV1(match[3]);
  const hour = numericTimePartV1(match[4]), minute = numericTimePartV1(match[5]), second = numericTimePartV1(match[6]);
  const offsetHour = match[8] ? numericTimePartV1(match[9]) : 0;
  const offsetMinute = match[8] ? numericTimePartV1(match[10]) : 0;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = month === 2 ? (leapYear ? 29 : 28)
    : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return undefined;
  const milliseconds = nativeDateParseV1(value);
  return nativeNumberIsFiniteV1(milliseconds) ? milliseconds : undefined;
}

export function capturedIdeaTimeFromMillisecondsV1(milliseconds: number): string | undefined {
  if (!nativeNumberIsFiniteV1(milliseconds)) return undefined;
  try {
    const formatted = nativeReflectApplyV1(nativeDateToISOStringV1, new nativeDateV1(milliseconds), []) as string;
    return capturedIdeaTimeMillisecondsV1(formatted) === undefined ? undefined : formatted;
  } catch {
    return undefined;
  }
}

export function capturedIdeaTimeStringV1(value: string | Date): string | undefined {
  try {
    const formatted = typeof value === "string" ? value
      : nativeReflectApplyV1(nativeDateToISOStringV1, value, []) as string;
    return capturedIdeaTimeMillisecondsV1(formatted) === undefined ? undefined : formatted;
  } catch {
    return undefined;
  }
}

export function capturedIdeaTimeNowV1(): string {
  const formatted = capturedIdeaTimeStringV1(new nativeDateV1());
  if (!formatted) throw new Error("captured Idea Lab clock unavailable");
  return formatted;
}

function capturedIdeaTimeV1(value: string): boolean {
  return capturedIdeaTimeMillisecondsV1(value) !== undefined;
}

export const IDEA_LAB_SESSION_V1 = "control-room-idea-lab-session/v1" as const;
export const IDEA_LAB_CONTRIBUTION_V1 = "control-room-idea-lab-contribution/v1" as const;
export const IDEA_LAB_SYNTHESIS_V1 = "control-room-idea-lab-synthesis/v1" as const;
export const IDEA_LAB_DECISION_V1 = "control-room-idea-lab-decision/v1" as const;
export const PROJECT_REGISTRY_LIFECYCLE_V1 = "control-room-project-registry-lifecycle/v1" as const;
export const IDEA_LAB_SESSION_PROJECTION_V1 = "control-room-idea-lab-session-projection/v1" as const;
export const CONTROL_ROOM_IDEA_ADAPTER_V1 = "adapter.control-room-native-ideas" as const;

export const ideaLabPerspectivesV1 = Object.freeze([
  "customer", "market", "skeptic", "finance", "operations", "technology", "growth", "risk",
] as const);
export const projectLifecycleStatesV1 = Object.freeze(["active", "paused", "completed", "archived"] as const);
export const ideaLabSessionStatesV1 = Object.freeze(["ready", "running", "panel_complete", "synthesized", "decided",
  "cancelled", "failed_definite", "ambiguous"] as const);

export const ideaIdSchemaV1 = z.string().min(3).max(180)
  .refine((value) => capturedPatternMatchesV1(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, value));
export const ideaDigestSchemaV1 = z.string()
  .refine((value) => capturedPatternMatchesV1(/^sha256:[a-f0-9]{64}$/, value));
export const ideaAuthTagSchemaV1 = z.string()
  .refine((value) => capturedPatternMatchesV1(/^hmac-sha256:[a-f0-9]{64}$/, value));
export const ideaTimeSchemaV1 = z.string().refine(capturedIdeaTimeV1);
export const ideaCodeSchemaV1 = z.string().min(2).max(100)
  .refine((value) => capturedPatternMatchesV1(/^[a-z][a-z0-9_]*$/, value));
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
export const ideaOwnerIntentSchemaV1 = z.object({ decision: z.enum(["create_project", "save", "reject"]),
  safeReasonCode: ideaCodeSchemaV1, project: projectCreationSpecSchemaV1.optional(),
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
  monitoringPagePath: z.string()
    .refine((value) => capturedPatternMatchesV1(/^\/projects\/[a-zA-Z0-9._:%-]+$/, value)),
  presentationOnly: z.literal(true),
  canDispatch: z.literal(false), grantsExecutionAuthority: z.literal(false), projectionDigest: ideaDigestSchemaV1,
}).strict();

export const ideaLabSessionProjectionSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_SESSION_PROJECTION_V1), tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1, sessionDigest: ideaDigestSchemaV1, title: ideaLabelSchemaV1,
  ideaSummary:ideaTextSchemaV1,targetCustomer:z.string().min(1).max(300),
  state: z.enum(ideaLabSessionStatesV1), participantCount: z.number().int().min(3).max(6),
  contributionCount: z.number().int().min(0).max(18), messagesUsed: z.number().int().min(0).max(18),
  costUsd: z.number().min(0).max(25), runId: ideaIdSchemaV1.optional(), runDigest: ideaDigestSchemaV1.optional(),
  synthesisDigest: ideaDigestSchemaV1.optional(), decisionDigest: ideaDigestSchemaV1.optional(),
  projectId: ideaIdSchemaV1.optional(), safeStatusCode: ideaCodeSchemaV1, retryPermitted: z.literal(false),
  liveProviderConfigured: z.literal(false), providerContacted: z.literal(false),
  grantsApproval: z.literal(false), grantsCommandAuthority: z.literal(false), grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), automaticProjectCreationAllowed: z.literal(false),
  updatedAt: ideaTimeSchemaV1, projectionDigest: ideaDigestSchemaV1,
}).strict();
