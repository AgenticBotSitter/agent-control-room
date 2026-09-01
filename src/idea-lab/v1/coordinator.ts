import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { buildIdeaLabContributionV1, parseIdeaLabSessionV1 } from "./contracts";
import { capturedIdeaTimeMillisecondsV1, capturedIdeaTimeNowV1, ideaCodeSchemaV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaParticipantSchemaV1, ideaTextSchemaV1, ideaTimeSchemaV1 } from "./schemas";
import type { IdeaLabContributionV1, IdeaLabParticipantV1, IdeaLabSessionV1 } from "./types";
import type { IdeaLabBotRunStoreV1 } from "./coordinator-store";
import type { IdeaLabProjectRegistryStoreV1 } from "./store";
import {
  parseIdeaLabLivePanelAdmissionV1,
  type IdeaLabLivePanelAdmissionAuthorityV1,
  type IdeaLabLivePanelAdmissionV1,
} from "./live-panel-admission";

export const IDEA_LAB_PROVIDER_SESSION_EVIDENCE_V1 = "control-room-idea-lab-provider-session-evidence/v1" as const;
export const IDEA_LAB_BOT_RUN_V1 = "control-room-idea-lab-bot-run/v1" as const;
export const ideaLabBotRunStatesV1 = Object.freeze([
  "prepared", "running", "completed", "cancelled", "failed_definite", "ambiguous",
] as const);

const providerCapabilitiesSchema = z.object({
  start: z.literal(true), filteredEvents: z.literal(true), usage: z.literal(true), cancel: z.literal(true),
  toolsDisabled: z.literal(true), mcpDisabled: z.literal(true), providerContentRetained: z.literal(false),
}).strict();

export const ideaLabProviderSessionEvidenceSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_PROVIDER_SESSION_EVIDENCE_V1), evidenceId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1, workspaceId: ideaIdSchemaV1, sessionId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1, participantId: ideaIdSchemaV1,
  participantIdentityDigest: ideaDigestSchemaV1,
  mode: z.enum(["repository_fake", "hermes_bot_mode_filtered"]),
  harnessPackage: z.enum(["control_room_fake", "hermes_agent"]), harnessVersion: z.string().min(1).max(40),
  sourceRevision: z.string().min(7).max(80), adapterDigest: ideaDigestSchemaV1,
  profileIdDigest: ideaDigestSchemaV1, conversationIdDigest: ideaDigestSchemaV1,
  capabilities: providerCapabilitiesSchema, sanitized: z.literal(true),
  liveProviderAuthorized: z.boolean(), providerContacted: z.boolean(),
  capturedAt: ideaTimeSchemaV1, expiresAt: ideaTimeSchemaV1,
  grantsApproval: z.literal(false), grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  evidenceDigest: ideaDigestSchemaV1,
}).strict();

const attemptSchema = z.object({
  attemptId: ideaIdSchemaV1, participantId: ideaIdSchemaV1, participantIdentityDigest: ideaDigestSchemaV1,
  round: z.number().int().min(1).max(3), state: z.enum(["provider_marked", "completed", "failed_definite", "ambiguous"]),
  markerDigest: ideaDigestSchemaV1, receiptDigest: ideaDigestSchemaV1.optional(), contributionDigest: ideaDigestSchemaV1.optional(),
  safeCode: ideaCodeSchemaV1.optional(), costUsd: z.number().min(0).max(25), messagesUsed: z.number().int().min(0).max(1),
  startedAt: ideaTimeSchemaV1, settledAt: ideaTimeSchemaV1.optional(),
}).strict();

export const ideaLabBotRunSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_BOT_RUN_V1), runId: ideaIdSchemaV1, tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1, sessionId: ideaIdSchemaV1, sessionDigest: ideaDigestSchemaV1,
  evidenceDigests: z.array(ideaDigestSchemaV1).min(3).max(6), state: z.enum(ideaLabBotRunStatesV1),
  attempts: z.array(attemptSchema).max(18), messagesUsed: z.number().int().min(0).max(18),
  costUsd: z.number().min(0).max(25), safeCode: ideaCodeSchemaV1, retryPermitted: z.literal(false),
  providerContacted: z.boolean(), startedAt: ideaTimeSchemaV1, updatedAt: ideaTimeSchemaV1,
  grantsApproval: z.literal(false), grantsCommandAuthority: z.literal(false), grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), automaticProjectCreationAllowed: z.literal(false), runDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabProviderSessionEvidenceV1 = z.infer<typeof ideaLabProviderSessionEvidenceSchemaV1>;
export type IdeaLabBotRunV1 = z.infer<typeof ideaLabBotRunSchemaV1>;
export type IdeaLabBotAttemptV1 = IdeaLabBotRunV1["attempts"][number];

function withoutDigest<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value }; delete result[key]; return result;
}

function timeMillisecondsV1(value: string): number {
  const milliseconds = capturedIdeaTimeMillisecondsV1(value);
  if (milliseconds === undefined) throw new IdeaLabErrorV1("integrity_failed");
  return milliseconds;
}

export function parseIdeaLabProviderSessionEvidenceV1(value: unknown, sessionValue: unknown): IdeaLabProviderSessionEvidenceV1 {
  const session = parseIdeaLabSessionV1(sessionValue);
  const parsed = parseExactIdeaLabV1(ideaLabProviderSessionEvidenceSchemaV1, value);
  const participant = session.participants.find((item) => item.participantId === parsed.participantId);
  const fake = parsed.mode === "repository_fake";
  if (sha256Digest(withoutDigest(parsed, "evidenceDigest")) !== parsed.evidenceDigest || !participant
    || parsed.tenantId !== session.tenantId || parsed.workspaceId !== session.workspaceId
    || parsed.sessionId !== session.sessionId || parsed.sessionDigest !== session.sessionDigest
    || parsed.participantIdentityDigest !== participant.identityDigest
    || timeMillisecondsV1(parsed.expiresAt) <= timeMillisecondsV1(parsed.capturedAt)
    || (fake && (parsed.harnessPackage !== "control_room_fake" || parsed.liveProviderAuthorized || parsed.providerContacted))
    || (!fake && (parsed.harnessPackage !== "hermes_agent" || !parsed.liveProviderAuthorized || !parsed.providerContacted))) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}

export function buildRepositoryFakeProviderEvidenceV1(sessionValue: unknown, participantValue: unknown,
  input: { evidenceId: string; capturedAt: string; expiresAt: string }): IdeaLabProviderSessionEvidenceV1 {
  const session = parseIdeaLabSessionV1(sessionValue);
  const requestedParticipant = parseExactIdeaLabV1(ideaParticipantSchemaV1, participantValue);
  const participant = session.participants.find((item) => item.participantId === requestedParticipant.participantId);
  if (!participant || participant.identityDigest !== requestedParticipant.identityDigest) throw new IdeaLabErrorV1("scope_mismatch");
  const material = {
    contractVersion: IDEA_LAB_PROVIDER_SESSION_EVIDENCE_V1, evidenceId: input.evidenceId, tenantId: session.tenantId,
    workspaceId: session.workspaceId, sessionId: session.sessionId, sessionDigest: session.sessionDigest,
    participantId: participant.participantId, participantIdentityDigest: participant.identityDigest,
    mode: "repository_fake" as const, harnessPackage: "control_room_fake" as const, harnessVersion: "1.0.0",
    sourceRevision: "repository-only", adapterDigest: sha256Digest({ adapter: "idea-lab-fake-v1" }),
    profileIdDigest: sha256Digest({ participantId: participant.participantId, kind: "fake-profile" }),
    conversationIdDigest: sha256Digest({ sessionDigest: session.sessionDigest, participantId: participant.participantId }),
    capabilities: { start: true as const, filteredEvents: true as const, usage: true as const, cancel: true as const,
      toolsDisabled: true as const, mcpDisabled: true as const, providerContentRetained: false as const },
    sanitized: true as const, liveProviderAuthorized: false, providerContacted: false,
    capturedAt: input.capturedAt, expiresAt: input.expiresAt, grantsApproval: false as const,
    grantsCommandAuthority: false as const, grantsLeaseAuthority: false as const, grantsExecutionAuthority: false as const,
  };
  return ideaLabProviderSessionEvidenceSchemaV1.parse({ ...material, evidenceDigest: sha256Digest(material) });
}

export function parseIdeaLabBotRunV1(value: unknown): IdeaLabBotRunV1 {
  const parsed = parseExactIdeaLabV1(ideaLabBotRunSchemaV1, value);
  let invalidAttemptChronology = false;
  for (let index = 0; index < parsed.attempts.length; index += 1) {
    const item = parsed.attempts[index]!;
    if (item.settledAt && timeMillisecondsV1(item.settledAt) < timeMillisecondsV1(item.startedAt)
      || index > 0 && timeMillisecondsV1(item.startedAt) < timeMillisecondsV1(parsed.attempts[index - 1]!.startedAt)) {
      invalidAttemptChronology = true; break;
    }
  }
  if (sha256Digest(withoutDigest(parsed, "runDigest")) !== parsed.runDigest
    || parsed.messagesUsed !== parsed.attempts.filter((item) => item.state === "completed").length
    || parsed.costUsd !== parsed.attempts.reduce((sum, item) => sum + (item.state === "completed" ? item.costUsd : 0), 0)
    || new Set(parsed.evidenceDigests).size !== parsed.evidenceDigests.length || invalidAttemptChronology) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}

export function buildIdeaLabBotRunV1(value: Omit<IdeaLabBotRunV1, "contractVersion" | "retryPermitted" |
  "grantsApproval" | "grantsCommandAuthority" | "grantsLeaseAuthority" | "grantsExecutionAuthority" |
  "automaticProjectCreationAllowed" | "runDigest">): IdeaLabBotRunV1 {
  const material = { contractVersion: IDEA_LAB_BOT_RUN_V1, ...value, retryPermitted: false as const,
    grantsApproval: false as const, grantsCommandAuthority: false as const, grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const, automaticProjectCreationAllowed: false as const };
  return ideaLabBotRunSchemaV1.parse({ ...material, runDigest: sha256Digest(material) });
}

const safeDriverResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("completed"), safeOpinion: ideaTextSchemaV1, opportunityCode: ideaCodeSchemaV1,
    primaryRiskCode: ideaCodeSchemaV1, suggestedExperiment: z.string().min(1).max(500),
    confidencePercent: z.number().int().min(0).max(100), costUsd: z.number().min(0).max(25),
    providerReceiptDigest: ideaDigestSchemaV1, providerContacted: z.boolean() }).strict(),
  z.object({ outcome: z.literal("failed_definite"), safeCode: ideaCodeSchemaV1,
    providerReceiptDigest: ideaDigestSchemaV1, providerContacted: z.boolean() }).strict(),
]);
export type IdeaLabBotDriverResultV1 = z.infer<typeof safeDriverResultSchema>;

export interface IdeaLabBotPanelDriverV1 {
  readonly mode: "repository_fake" | "hermes_bot_mode_filtered";
  invoke(input: Readonly<{ session: IdeaLabSessionV1; participant: IdeaLabParticipantV1; round: number;
    safePrompt: string; evidence: IdeaLabProviderSessionEvidenceV1; markerDigest: string;
    liveAdmission?: IdeaLabLivePanelAdmissionV1 }>): Promise<unknown>;
}

/** Server-held verifier for live evidence. Evidence claims never authorize themselves. */
export interface IdeaLabProviderEvidenceAuthorityV1 {
  verify(evidence: IdeaLabProviderSessionEvidenceV1, now: string): Promise<boolean>;
}

export class DeterministicIdeaLabFakeDriverV1 implements IdeaLabBotPanelDriverV1 {
  readonly mode = "repository_fake" as const;
  constructor(private readonly outcomes: Readonly<Record<string, "completed" | "failed_definite" | "throw">> = {}) {}
  async invoke(input: Parameters<IdeaLabBotPanelDriverV1["invoke"]>[0]): Promise<unknown> {
    const outcome = this.outcomes[`${input.participant.participantId}:${input.round}`] ?? "completed";
    if (outcome === "throw") throw new Error("repository fake interruption");
    const providerReceiptDigest = sha256Digest({ markerDigest: input.markerDigest, outcome });
    if (outcome === "failed_definite") return { outcome, safeCode: "fake_definite_failure", providerReceiptDigest, providerContacted: false };
    return { outcome, safeOpinion: `${input.participant.displayName} evaluated the idea from the ${input.participant.perspective} perspective.`,
      opportunityCode: `${input.participant.perspective}_opportunity`, primaryRiskCode: `${input.participant.perspective}_risk`,
      suggestedExperiment: `Run one bounded ${input.participant.perspective} experiment before promotion.`,
      confidencePercent: 70, costUsd: 0, providerReceiptDigest, providerContacted: false };
  }
}

export class IdeaLabBotCoordinatorV1 {
  constructor(private readonly ledger: IdeaLabBotRunStoreV1, private readonly registry: IdeaLabProjectRegistryStoreV1,
    private readonly driver: IdeaLabBotPanelDriverV1, private readonly clock: () => string = capturedIdeaTimeNowV1,
    private readonly providerEvidenceAuthority?: IdeaLabProviderEvidenceAuthorityV1,
    private readonly livePanelAdmissionAuthority?: IdeaLabLivePanelAdmissionAuthorityV1) {}

  async execute(input: { runId: string; session: unknown; evidence: unknown[]; safePrompt: string;
    liveAdmission?: unknown; cancelRequested?: () => boolean }): Promise<IdeaLabBotRunV1> {
    const session = parseIdeaLabSessionV1(input.session);
    if (input.safePrompt.length < 1 || input.safePrompt.length > 800) throw new IdeaLabErrorV1("invalid_input");
    const evidence = input.evidence.map((item) => parseIdeaLabProviderSessionEvidenceV1(item, session));
    if (evidence.length !== session.participants.length || evidence.some((item) => item.mode !== this.driver.mode)
      || new Set(evidence.map((item) => item.participantId)).size !== session.participants.length
      || session.participants.some((p) => !evidence.some((item) => item.participantId === p.participantId))) {
      throw new IdeaLabErrorV1("scope_mismatch");
    }
    const now = this.clock(), nowMilliseconds = capturedIdeaTimeMillisecondsV1(now);
    if (nowMilliseconds === undefined) throw new IdeaLabErrorV1("integrity_failed");
    let evidenceChronologyInvalid = false;
    for (const item of evidence) if (timeMillisecondsV1(item.capturedAt) > nowMilliseconds
      || timeMillisecondsV1(item.expiresAt) <= nowMilliseconds) { evidenceChronologyInvalid = true; break; }
    if (evidenceChronologyInvalid) {
      throw new IdeaLabErrorV1("scope_mismatch");
    }
    let liveAdmission: IdeaLabLivePanelAdmissionV1 | undefined;
    if (this.driver.mode === "hermes_bot_mode_filtered") {
      if (!this.providerEvidenceAuthority || !this.livePanelAdmissionAuthority || input.liveAdmission === undefined) {
        throw new IdeaLabErrorV1("authorization_denied");
      }
      let admission: IdeaLabLivePanelAdmissionV1;
      try { admission = parseIdeaLabLivePanelAdmissionV1(input.liveAdmission, session, evidence, input.runId, now); }
      catch { throw new IdeaLabErrorV1("authorization_denied"); }
      for (const item of evidence) if (!await this.providerEvidenceAuthority.verify(item, now)) {
        throw new IdeaLabErrorV1("authorization_denied");
      }
      if (!await this.livePanelAdmissionAuthority.consume({ admission, session, evidence, now })) {
        throw new IdeaLabErrorV1("authorization_denied");
      }
      liveAdmission = admission;
    } else if (input.liveAdmission !== undefined) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    let run = await this.ledger.prepare(buildIdeaLabBotRunV1({ runId: input.runId, tenantId: session.tenantId,
      workspaceId: session.workspaceId, sessionId: session.sessionId, sessionDigest: session.sessionDigest,
      evidenceDigests: evidence.map((item) => item.evidenceDigest).sort(), state: "prepared", attempts: [], messagesUsed: 0,
      costUsd: 0, safeCode: "prepared", providerContacted: false, startedAt: now, updatedAt: now }));
    if (run.state !== "prepared") return run.state === "running" ? this.ledger.recover(run.runId, this.clock()) : run;
    for (let round = 1; round <= session.maxRounds; round += 1) for (const participant of session.participants) {
      if (input.cancelRequested?.()) return this.ledger.cancel(run.runId, this.clock());
      if (timeMillisecondsV1(this.clock()) - timeMillisecondsV1(run.startedAt) >= session.maxDurationSeconds * 1000
        || run.messagesUsed >= session.maxMessages || run.costUsd >= session.maxCostUsd) {
        return this.ledger.failDefinite(run.runId, "budget_exhausted_before_provider", this.clock());
      }
      const participantEvidence = evidence.find((item) => item.participantId === participant.participantId)!;
      const attemptId = `attempt.idea:${sha256Digest({ runId: run.runId, participantId: participant.participantId, round }).slice(7, 31)}`;
      const startedAt = this.clock(), markerDigest = sha256Digest({ runDigest: run.runDigest, attemptId,
        evidenceDigest: participantEvidence.evidenceDigest, startedAt });
      run = await this.ledger.markProvider(run.runId, { attemptId, participantId: participant.participantId,
        participantIdentityDigest: participant.identityDigest, round, state: "provider_marked", markerDigest,
        costUsd: 0, messagesUsed: 0, startedAt });
      let raw: unknown;
      try { raw = await this.driver.invoke({ session, participant, round, safePrompt: input.safePrompt,
        evidence: participantEvidence, markerDigest, ...(liveAdmission ? { liveAdmission } : {}) }); }
      catch { return this.ledger.markAmbiguous(run.runId, attemptId, "provider_outcome_unknown", this.clock()); }
      let result: IdeaLabBotDriverResultV1;
      try { result = parseExactIdeaLabV1(safeDriverResultSchema, raw); }
      catch { return this.ledger.markAmbiguous(run.runId, attemptId, "provider_receipt_invalid", this.clock()); }
      if (result.providerContacted !== participantEvidence.providerContacted) {
        return this.ledger.markAmbiguous(run.runId, attemptId, "provider_contact_evidence_mismatch", this.clock());
      }
      if (result.outcome === "failed_definite") {
        return this.ledger.settleDefiniteFailure(run.runId, attemptId, result.safeCode, result.providerReceiptDigest, this.clock());
      }
      if (timeMillisecondsV1(this.clock()) - timeMillisecondsV1(run.startedAt) >= session.maxDurationSeconds * 1000) {
        return this.ledger.settleDefiniteFailure(run.runId, attemptId, "duration_budget_exceeded", result.providerReceiptDigest, this.clock());
      }
      if (run.costUsd + result.costUsd > session.maxCostUsd) {
        return this.ledger.settleDefiniteFailure(run.runId, attemptId, "cost_budget_exceeded", result.providerReceiptDigest, this.clock());
      }
      const contribution: IdeaLabContributionV1 = buildIdeaLabContributionV1(session, { participantId: participant.participantId,
        round, safeOpinion: result.safeOpinion, opportunityCode: result.opportunityCode, primaryRiskCode: result.primaryRiskCode,
        suggestedExperiment: result.suggestedExperiment, confidencePercent: result.confidencePercent, contributedAt: this.clock() },
      this.driver.mode === "repository_fake"
        ? { sourceMode: "injected_only", liveBotContactAuthorized: false, providerContacted: false }
        : { sourceMode: "provider_filtered", liveBotContactAuthorized: true, providerContacted: true });
      await this.registry.recordContribution(contribution);
      run = await this.ledger.settleCompleted(run.runId, attemptId, result.providerReceiptDigest,
        contribution.contributionDigest, result.costUsd, result.providerContacted, this.clock());
      if (input.cancelRequested?.()) return this.ledger.cancel(run.runId, this.clock());
    }
    return this.ledger.complete(run.runId, this.clock());
  }
}

export const IDEA_LAB_BOT_RUNTIME_DISABLED_V1 = Object.freeze({
  state: "disabled_pending_filtered_provider_and_owner_authorization" as const, providerConfigured: false as const,
  credentialsAccessed: false as const, providerContacted: false as const, liveProviderAuthorized: false as const,
  automaticProjectCreationAllowed: false as const, grantsExecutionAuthority: false as const,
});
