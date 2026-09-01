import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  capturedIdeaTimeMillisecondsV1, IDEA_LAB_CONTRIBUTION_V1, IDEA_LAB_DECISION_V1, IDEA_LAB_SESSION_V1, IDEA_LAB_SYNTHESIS_V1,
  PROJECT_REGISTRY_LIFECYCLE_V1, ideaCodeSchemaV1, ideaContributionSchemaV1, ideaDecisionSchemaV1,
  ideaDigestSchemaV1, ideaIdSchemaV1, ideaLabelSchemaV1, ideaParticipantSchemaV1, ideaSessionSchemaV1,
  ideaSynthesisSchemaV1, ideaTextSchemaV1, ideaTimeSchemaV1, projectCreationSpecSchemaV1,
  projectLifecycleEventSchemaV1, projectLifecycleStatesV1, projectRegistryProjectionSchemaV1,
} from "./schemas";
import type {
  IdeaLabContributionV1, IdeaLabDecisionV1, IdeaLabSessionV1, IdeaLabSynthesisV1,
  ProjectLifecycleEventV1, ProjectRegistryProjectionV1,
} from "./types";

function without<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value }; delete result[key]; return result;
}
function digestValid(value: Record<string, unknown>, key: string): boolean {
  return value[key] === sha256Digest(without(value, key));
}

const sessionInputSchema = z.object({ sessionId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1,
  title: ideaLabelSchemaV1, ideaSummary: ideaTextSchemaV1, targetCustomer: z.string().min(1).max(300),
  participants: z.array(ideaParticipantSchemaV1).min(3).max(6), maxRounds: z.number().int().min(1).max(3),
  maxDurationSeconds: z.number().int().min(60).max(900), maxCostUsd: z.number().min(0).max(25),
  createdByIdentityDigest: ideaDigestSchemaV1, createdAt: ideaTimeSchemaV1 }).strict();

export function buildIdeaLabSessionV1(value: unknown): IdeaLabSessionV1 {
  const input = parseExactIdeaLabV1(sessionInputSchema, value);
  if (new Set(input.participants.map((item) => item.participantId)).size !== input.participants.length
    || new Set(input.participants.map((item) => item.identityDigest)).size !== input.participants.length
    || new Set(input.participants.map((item) => item.perspective)).size !== input.participants.length
    || !input.participants.some((item) => item.perspective === "skeptic")) throw new IdeaLabErrorV1("invalid_input");
  const material = { contractVersion: IDEA_LAB_SESSION_V1, ...input,
    maxMessages: input.participants.length * input.maxRounds, liveBotContactAuthorized: false as const,
    providerContacted: false as const, grantsApproval: false as const, grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const, grantsExecutionAuthority: false as const, automaticProjectCreationAllowed: false as const };
  return ideaSessionSchemaV1.parse({ ...material, sessionDigest: sha256Digest(material) });
}

export function parseIdeaLabSessionV1(value: unknown): IdeaLabSessionV1 {
  const parsed = parseExactIdeaLabV1(ideaSessionSchemaV1, value);
  if (!digestValid(parsed, "sessionDigest") || parsed.maxMessages !== parsed.participants.length * parsed.maxRounds
    || new Set(parsed.participants.map((item) => item.participantId)).size !== parsed.participants.length
    || new Set(parsed.participants.map((item) => item.identityDigest)).size !== parsed.participants.length
    || new Set(parsed.participants.map((item) => item.perspective)).size !== parsed.participants.length
    || !parsed.participants.some((item) => item.perspective === "skeptic")) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

const contributionInputSchema = z.object({ participantId: ideaIdSchemaV1, round: z.number().int().min(1).max(3),
  safeOpinion: ideaTextSchemaV1, opportunityCode: ideaCodeSchemaV1, primaryRiskCode: ideaCodeSchemaV1,
  suggestedExperiment: z.string().min(1).max(500), confidencePercent: z.number().int().min(0).max(100),
  contributedAt: ideaTimeSchemaV1 }).strict();

export function buildIdeaLabContributionV1(sessionValue: unknown, value: unknown,
  source: { sourceMode: "injected_only"; liveBotContactAuthorized: false; providerContacted: false }
    | { sourceMode: "provider_filtered"; liveBotContactAuthorized: true; providerContacted: true }
    = { sourceMode: "injected_only", liveBotContactAuthorized: false, providerContacted: false }): IdeaLabContributionV1 {
  const session = parseIdeaLabSessionV1(sessionValue), input = parseExactIdeaLabV1(contributionInputSchema, value);
  const participant = session.participants.find((item) => item.participantId === input.participantId);
  if (!participant || input.round > session.maxRounds
    || capturedIdeaTimeMillisecondsV1(input.contributedAt)! < capturedIdeaTimeMillisecondsV1(session.createdAt)!) {
    throw new IdeaLabErrorV1("scope_mismatch");
  }
  const material = { contractVersion: IDEA_LAB_CONTRIBUTION_V1,
    contributionId: `contribution.idea:${sha256Digest({ sessionDigest: session.sessionDigest,
      participantId: input.participantId, round: input.round }).slice(7, 31)}`, sessionId: session.sessionId,
    tenantId: session.tenantId, workspaceId: session.workspaceId, sessionDigest: session.sessionDigest,
    participantId: participant.participantId, participantIdentityDigest: participant.identityDigest,
    perspective: participant.perspective, round: input.round, safeOpinion: input.safeOpinion,
    opportunityCode: input.opportunityCode, primaryRiskCode: input.primaryRiskCode,
    suggestedExperiment: input.suggestedExperiment, confidencePercent: input.confidencePercent,
    ...source, contributedAt: input.contributedAt, grantsApproval: false as const, grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const, grantsExecutionAuthority: false as const, automaticProjectCreationAllowed: false as const };
  return ideaContributionSchemaV1.parse({ ...material, contributionDigest: sha256Digest(material) });
}

export function parseIdeaLabContributionV1(value: unknown, sessionValue: unknown): IdeaLabContributionV1 {
  const session = parseIdeaLabSessionV1(sessionValue), parsed = parseExactIdeaLabV1(ideaContributionSchemaV1, value);
  const participant = session.participants.find((item) => item.participantId === parsed.participantId);
  const expectedId = `contribution.idea:${sha256Digest({ sessionDigest: session.sessionDigest,
    participantId: parsed.participantId, round: parsed.round }).slice(7, 31)}`;
  if (!digestValid(parsed, "contributionDigest") || !participant || parsed.contributionId !== expectedId
    || parsed.sessionId !== session.sessionId || parsed.tenantId !== session.tenantId || parsed.workspaceId !== session.workspaceId
    || parsed.sessionDigest !== session.sessionDigest || parsed.participantIdentityDigest !== participant.identityDigest
    || parsed.perspective !== participant.perspective || parsed.round > session.maxRounds
    || (parsed.sourceMode === "injected_only" && (parsed.liveBotContactAuthorized || parsed.providerContacted))
    || (parsed.sourceMode === "provider_filtered" && (!parsed.liveBotContactAuthorized || !parsed.providerContacted))
    || capturedIdeaTimeMillisecondsV1(parsed.contributedAt)!
      < capturedIdeaTimeMillisecondsV1(session.createdAt)!) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

const synthesisInputSchema = z.object({ marketDemand: z.number().int().min(0).max(100), feasibility: z.number().int().min(0).max(100),
  differentiation: z.number().int().min(0).max(100), durability: z.number().int().min(0).max(100),
  ownerFit: z.number().int().min(0).max(100), riskPercent: z.number().int().min(0).max(100),
  executiveSummary: ideaTextSchemaV1, nextExperiment: z.string().min(1).max(500),
  dissentingPerspectiveCodes: z.array(ideaCodeSchemaV1).max(6), synthesizedAt: ideaTimeSchemaV1 }).strict();

export function buildIdeaLabSynthesisV1(sessionValue: unknown, contributionValues: unknown[], value: unknown): IdeaLabSynthesisV1 {
  const session = parseIdeaLabSessionV1(sessionValue), input = parseExactIdeaLabV1(synthesisInputSchema, value);
  const contributions = contributionValues.map((item) => parseIdeaLabContributionV1(item, session))
    .sort((left, right) => left.contributionDigest.localeCompare(right.contributionDigest));
  let futureContribution = false;
  const synthesizedAt = capturedIdeaTimeMillisecondsV1(input.synthesizedAt)!;
  for (const contribution of contributions) if (capturedIdeaTimeMillisecondsV1(contribution.contributedAt)! > synthesizedAt) {
    futureContribution = true; break;
  }
  if (contributions.length > session.maxMessages
    || new Set(contributions.map((item) => item.contributionId)).size !== contributions.length
    || session.participants.some((participant) => !contributions.some((item) => item.participantId === participant.participantId))
    || futureContribution) {
    throw new IdeaLabErrorV1("panel_incomplete");
  }
  const overallScore = Math.round((input.marketDemand + input.feasibility + input.differentiation + input.durability
    + input.ownerFit + (100 - input.riskPercent)) / 6);
  const recommendation = overallScore >= 70 ? "promote" as const : overallScore >= 45 ? "save" as const : "reject" as const;
  const material = { contractVersion: IDEA_LAB_SYNTHESIS_V1,
    synthesisId: `synthesis.idea:${session.sessionDigest.slice(7, 31)}`, sessionId: session.sessionId,
    tenantId: session.tenantId, workspaceId: session.workspaceId, sessionDigest: session.sessionDigest,
    contributionDigests: contributions.map((item) => item.contributionDigest), participantCount: session.participants.length,
    contributionCount: contributions.length, ...input, overallScore, recommendation, advisoryOnly: true as const,
    ownerDecisionRequired: true as const,
    liveBotContactAuthorized: contributions.some((item) => item.liveBotContactAuthorized),
    providerContacted: contributions.some((item) => item.providerContacted),
    grantsApproval: false as const, grantsCommandAuthority: false as const, grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const, automaticProjectCreationAllowed: false as const };
  return ideaSynthesisSchemaV1.parse({ ...material, synthesisDigest: sha256Digest(material) });
}

export function parseIdeaLabSynthesisV1(value: unknown, sessionValue: unknown, contributionValues: unknown[]): IdeaLabSynthesisV1 {
  const session = parseIdeaLabSessionV1(sessionValue), parsed = parseExactIdeaLabV1(ideaSynthesisSchemaV1, value);
  const expected = buildIdeaLabSynthesisV1(session, contributionValues, {
    marketDemand: parsed.marketDemand, feasibility: parsed.feasibility, differentiation: parsed.differentiation,
    durability: parsed.durability, ownerFit: parsed.ownerFit, riskPercent: parsed.riskPercent,
    executiveSummary: parsed.executiveSummary, nextExperiment: parsed.nextExperiment,
    dissentingPerspectiveCodes: parsed.dissentingPerspectiveCodes, synthesizedAt: parsed.synthesizedAt,
  });
  if (expected.synthesisDigest !== parsed.synthesisDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

const decisionInputSchema = z.object({ decision: z.enum(["create_project", "save", "reject"]), safeReasonCode: ideaCodeSchemaV1,
  ownerIdentityDigest: ideaDigestSchemaV1, project: projectCreationSpecSchemaV1.optional(), decidedAt: ideaTimeSchemaV1 }).strict();

export function buildIdeaLabDecisionV1(sessionValue: unknown, synthesisValue: unknown,
  contributions: unknown[], value: unknown): IdeaLabDecisionV1 {
  const session = parseIdeaLabSessionV1(sessionValue), synthesis = parseIdeaLabSynthesisV1(synthesisValue, session, contributions);
  const input = parseExactIdeaLabV1(decisionInputSchema, value);
  if ((input.decision === "create_project") !== !!input.project
    || capturedIdeaTimeMillisecondsV1(input.decidedAt)! < capturedIdeaTimeMillisecondsV1(synthesis.synthesizedAt)!) {
    throw new IdeaLabErrorV1("invalid_input");
  }
  const material = { contractVersion: IDEA_LAB_DECISION_V1,
    decisionId: `decision.idea:${session.sessionDigest.slice(7, 31)}`, sessionId: session.sessionId,
    tenantId: session.tenantId, workspaceId: session.workspaceId, sessionDigest: session.sessionDigest,
    synthesisDigest: synthesis.synthesisDigest, decision: input.decision, safeReasonCode: input.safeReasonCode,
    ownerIdentityDigest: input.ownerIdentityDigest, ...(input.project ? { project: input.project } : {}), decidedAt: input.decidedAt,
    automaticDecision: false as const, ownerDecisionRequired: false as const, liveBotContactAuthorized: false as const,
    providerContacted: false as const, grantsApproval: false as const, grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const, grantsExecutionAuthority: false as const, automaticProjectCreationAllowed: false as const };
  return ideaDecisionSchemaV1.parse({ ...material, decisionDigest: sha256Digest(material) });
}

export function parseIdeaLabDecisionV1(value: unknown, session: IdeaLabSessionV1, synthesis: IdeaLabSynthesisV1): IdeaLabDecisionV1 {
  const parsed = parseExactIdeaLabV1(ideaDecisionSchemaV1, value);
  if (!digestValid(parsed, "decisionDigest") || parsed.sessionId !== session.sessionId || parsed.tenantId !== session.tenantId
    || parsed.workspaceId !== session.workspaceId || parsed.sessionDigest !== session.sessionDigest
    || parsed.synthesisDigest !== synthesis.synthesisDigest || (parsed.decision === "create_project") !== !!parsed.project
    || capturedIdeaTimeMillisecondsV1(parsed.decidedAt)!
      < capturedIdeaTimeMillisecondsV1(synthesis.synthesizedAt)!) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

export interface ProjectSnapshotMaterialV1 { tenantId: string; workspaceId: string; projectId: string;
  sourceIdeaSessionId: string; sourceDecisionDigest: string; workspaceName: string; title: string; summary: string;
  projectKind: string; lifecycleState: typeof projectLifecycleStatesV1[number]; priority: number; version: number;
  createdAt: string; updatedAt: string; }

export function projectSnapshotDigestV1(value: ProjectSnapshotMaterialV1): string { return sha256Digest(value); }

export function buildProjectLifecycleEventV1(value: ProjectSnapshotMaterialV1 & { fromState: typeof projectLifecycleStatesV1[number] | null;
  actorIdentityDigest: string; safeReasonCode: string }): ProjectLifecycleEventV1 {
  const snapshot: ProjectSnapshotMaterialV1 = { tenantId: value.tenantId, workspaceId: value.workspaceId,
    projectId: value.projectId, sourceIdeaSessionId: value.sourceIdeaSessionId, sourceDecisionDigest: value.sourceDecisionDigest,
    workspaceName: value.workspaceName, title: value.title, summary: value.summary, projectKind: value.projectKind,
    lifecycleState: value.lifecycleState, priority: value.priority, version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt };
  const material = { contractVersion: PROJECT_REGISTRY_LIFECYCLE_V1,
    eventId: `event.project-lifecycle:${sha256Digest({ projectId: value.projectId, version: value.version }).slice(7, 31)}`,
    tenantId: value.tenantId, workspaceId: value.workspaceId, projectId: value.projectId,
    sourceIdeaSessionId: value.sourceIdeaSessionId, sourceDecisionDigest: value.sourceDecisionDigest,
    fromState: value.fromState, toState: value.lifecycleState, version: value.version,
    actorIdentityDigest: value.actorIdentityDigest, safeReasonCode: value.safeReasonCode,
    projectSnapshotDigest: projectSnapshotDigestV1(snapshot), occurredAt: value.updatedAt,
    grantsApproval: false as const, grantsCommandAuthority: false as const, grantsExecutionAuthority: false as const };
  return projectLifecycleEventSchemaV1.parse({ ...material, eventDigest: sha256Digest(material) });
}

export function parseProjectLifecycleEventV1(value: unknown): ProjectLifecycleEventV1 {
  const parsed = parseExactIdeaLabV1(projectLifecycleEventSchemaV1, value);
  if (!digestValid(parsed, "eventDigest")) throw new IdeaLabErrorV1("integrity_failed"); return parsed;
}

export function buildProjectRegistryProjectionV1(snapshot: ProjectSnapshotMaterialV1,
  eventValue: unknown): ProjectRegistryProjectionV1 {
  const event = parseProjectLifecycleEventV1(eventValue);
  if (event.tenantId !== snapshot.tenantId || event.workspaceId !== snapshot.workspaceId || event.projectId !== snapshot.projectId
    || event.sourceIdeaSessionId !== snapshot.sourceIdeaSessionId || event.sourceDecisionDigest !== snapshot.sourceDecisionDigest
    || event.toState !== snapshot.lifecycleState || event.version !== snapshot.version
    || event.projectSnapshotDigest !== projectSnapshotDigestV1(snapshot) || event.occurredAt !== snapshot.updatedAt) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const material = { contractVersion: "control-room-project-registry-projection/v1" as const, ...snapshot,
    latestEventDigest: event.eventDigest, monitoringPagePath: `/projects/${encodeURIComponent(snapshot.projectId)}`,
    presentationOnly: true as const, canDispatch: false as const, grantsExecutionAuthority: false as const };
  return projectRegistryProjectionSchemaV1.parse({ ...material, projectionDigest: sha256Digest(material) });
}

export function parseProjectRegistryProjectionV1(value: unknown): ProjectRegistryProjectionV1 {
  const parsed = parseExactIdeaLabV1(projectRegistryProjectionSchemaV1, value);
  if (!digestValid(parsed, "projectionDigest") || parsed.monitoringPagePath !== `/projects/${encodeURIComponent(parsed.projectId)}`) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}

const transitions: Record<typeof projectLifecycleStatesV1[number], ReadonlySet<typeof projectLifecycleStatesV1[number]>> = {
  active: new Set(["paused", "completed"]), paused: new Set(["active", "completed"]),
  completed: new Set(["archived"]), archived: new Set(["active"]),
};
export function assertProjectLifecycleTransitionV1(from: typeof projectLifecycleStatesV1[number],
  to: typeof projectLifecycleStatesV1[number]): void {
  if (!transitions[from].has(to)) throw new IdeaLabErrorV1("state_conflict");
}
