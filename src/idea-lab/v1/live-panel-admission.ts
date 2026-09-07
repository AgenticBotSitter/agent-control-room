import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { parseIdeaLabSessionV1 } from "./contracts";
import { capturedIdeaTimeMillisecondsV1, ideaCodeSchemaV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";
import type { IdeaLabProviderSessionEvidenceV1 } from "./coordinator";
import type { IdeaLabSessionV1 } from "./types";

export const IDEA_LAB_LIVE_PANEL_ADMISSION_V1 = "control-room-idea-lab-live-panel-admission/v1" as const;

const participantBindingSchema = z.object({
  participantId: ideaIdSchemaV1,
  participantIdentityDigest: ideaDigestSchemaV1,
  providerEvidenceDigest: ideaDigestSchemaV1,
  runtimeIdentityDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  conversationIdentityDigest: ideaDigestSchemaV1,
}).strict();

const runtimeSchema = z.object({
  providerId: ideaCodeSchemaV1,
  adapterId: ideaIdSchemaV1,
  adapterVersion: z.string().min(1).max(40),
  runtimeVersion: z.string().min(1).max(40),
  runtimeRevision: z.string().min(7).max(80),
  compatibilityEvidenceDigest: ideaDigestSchemaV1,
  nativeQualificationReceiptDigest: ideaDigestSchemaV1,
  runtimeManifestDigest: ideaDigestSchemaV1,
  protectedValueCustodyMode: z.enum(["harness_native", "host_broker"]),
  protectedValueCustodyEvidenceDigest: ideaDigestSchemaV1,
  controlRoomCanReadProtectedValue: z.literal(false),
  protectedValueMaterialPresent: z.literal(false),
  toolsDisabled: z.literal(true),
  mcpDisabled: z.literal(true),
  start: z.literal(true),
  filteredEvents: z.literal(true),
  usage: z.literal(true),
  cancel: z.literal(true),
  steer: z.literal(true),
  resume: z.literal(true),
}).strict();

const ownerWindowSchema = z.object({
  windowId: ideaIdSchemaV1,
  decisionDigest: ideaDigestSchemaV1,
  strongFactorEvidenceDigest: ideaDigestSchemaV1,
  authorizedAction: z.literal("idea_lab_live_panel"),
  singleUse: z.literal(true),
  ownerAttended: z.literal(true),
  openedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
}).strict();

const ceilingsSchema = z.object({
  maxRounds: z.number().int().min(1).max(3),
  maxMessages: z.number().int().min(3).max(18),
  maxProviderCalls: z.number().int().min(3).max(18),
  maxDurationSeconds: z.number().int().min(60).max(900),
  maxCostUsd: z.number().min(0).max(25),
}).strict();

const callPolicySchema = z.object({
  concurrency: z.literal(1),
  durablePreCallMarkerRequired: z.literal(true),
  automaticRetryAllowed: z.literal(false),
  unknownPostMarkerOutcome: z.literal("terminal_ambiguity"),
  cancelPolicy: z.literal("between_calls_only"),
  steerPolicy: z.literal("disabled_for_panel"),
  resumePolicy: z.literal("reconcile_only_never_resubmit"),
}).strict();

const retainedOutputSchema = z.object({
  schemaId: z.literal("control-room-idea-lab-filtered-contribution/v1"),
  safeOpinionMaximumCharacters: z.literal(800),
  suggestedExperimentMaximumCharacters: z.literal(500),
  rawConversationRetained: z.literal(false),
  inputInstructionRetained: z.literal(false),
  messageDeltasRetained: z.literal(false),
  toolArgumentsRetained: z.literal(false),
  providerConfigurationRetained: z.literal(false),
  providerIdentifiersRetainedRaw: z.literal(false),
}).strict();

export const ideaLabLivePanelAdmissionSchemaV1 = z.object({
  contractVersion: z.literal(IDEA_LAB_LIVE_PANEL_ADMISSION_V1),
  admissionId: ideaIdSchemaV1,
  runId: ideaIdSchemaV1,
  tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1,
  runtime: runtimeSchema,
  participantBindings: z.array(participantBindingSchema).min(3).max(6),
  ceilings: ceilingsSchema,
  callPolicy: callPolicySchema,
  retainedOutput: retainedOutputSchema,
  ownerWindow: ownerWindowSchema,
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  livePanelContactPermitted: z.literal(true),
  providerContactScope: z.literal("panel_contribution_only"),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsProjectCreationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  admissionDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabLivePanelAdmissionV1 = z.infer<typeof ideaLabLivePanelAdmissionSchemaV1>;
export type IdeaLabLivePanelParticipantBindingV1 = IdeaLabLivePanelAdmissionV1["participantBindings"][number];

function withoutDigest<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  const result = { ...value };
  delete result.admissionDigest;
  return result;
}

function sorted(values: readonly string[]): string[] { return [...values].sort(); }

/**
 * Parse an admission candidate and bind it to the exact session and provider evidence.
 * This proves internal consistency only. The returned document is still a claim until
 * a server-held IdeaLabLivePanelAdmissionAuthorityV1 accepts it.
 */
export function parseIdeaLabLivePanelAdmissionV1(
  value: unknown,
  sessionValue: unknown,
  evidence: readonly IdeaLabProviderSessionEvidenceV1[],
  runId: string,
  now: string,
): IdeaLabLivePanelAdmissionV1 {
  const session = parseIdeaLabSessionV1(sessionValue);
  const parsed = parseExactIdeaLabV1(ideaLabLivePanelAdmissionSchemaV1, value);
  const bindingParticipants = parsed.participantBindings.map((item) => item.participantId);
  const sessionParticipants = session.participants.map((item) => item.participantId);
  const evidenceParticipants = evidence.map((item) => item.participantId);
  const evidenceDigests = evidence.map((item) => item.evidenceDigest);
  const issued = capturedIdeaTimeMillisecondsV1(parsed.issuedAt)!;
  const expires = capturedIdeaTimeMillisecondsV1(parsed.expiresAt)!;
  const windowOpened = capturedIdeaTimeMillisecondsV1(parsed.ownerWindow.openedAt)!;
  const windowExpires = capturedIdeaTimeMillisecondsV1(parsed.ownerWindow.expiresAt)!;
  const current = capturedIdeaTimeMillisecondsV1(now);
  if (sha256Digest(withoutDigest(parsed)) !== parsed.admissionDigest
    || parsed.runId !== runId || parsed.tenantId !== session.tenantId || parsed.workspaceId !== session.workspaceId
    || parsed.sessionId !== session.sessionId || parsed.sessionDigest !== session.sessionDigest
    || parsed.participantBindings.length !== session.participants.length || evidence.length !== session.participants.length
    || new Set(bindingParticipants).size !== session.participants.length
    || new Set(evidenceParticipants).size !== session.participants.length
    || sorted(bindingParticipants).join("|") !== sorted(sessionParticipants).join("|")
    || sorted(evidenceParticipants).join("|") !== sorted(sessionParticipants).join("|")
    || sorted(parsed.participantBindings.map((item) => item.providerEvidenceDigest)).join("|") !== sorted(evidenceDigests).join("|")
    || evidence.some((item) => item.harnessVersion !== parsed.runtime.runtimeVersion
      || item.sourceRevision !== parsed.runtime.runtimeRevision)
    || parsed.participantBindings.some((binding) => {
      const participant = session.participants.find((item) => item.participantId === binding.participantId);
      const providerEvidence = evidence.find((item) => item.participantId === binding.participantId);
      return !participant || !providerEvidence || binding.participantIdentityDigest !== participant.identityDigest
        || binding.providerEvidenceDigest !== providerEvidence.evidenceDigest
        || binding.profileIdentityDigest !== providerEvidence.profileIdDigest
        || binding.conversationIdentityDigest !== providerEvidence.conversationIdDigest;
    })
    || parsed.ceilings.maxRounds !== session.maxRounds || parsed.ceilings.maxMessages !== session.maxMessages
    || parsed.ceilings.maxProviderCalls !== session.maxMessages
    || parsed.ceilings.maxDurationSeconds !== session.maxDurationSeconds || parsed.ceilings.maxCostUsd !== session.maxCostUsd
    || current === undefined
    || issued < windowOpened || expires > windowExpires || issued > current || expires <= current
    || windowExpires <= windowOpened) {
    throw new IdeaLabErrorV1("scope_mismatch");
  }
  return parsed;
}

export function buildIdeaLabLivePanelAdmissionCandidateV1(input: {
  admissionId: string;
  runId: string;
  session: IdeaLabSessionV1;
  evidence: readonly IdeaLabProviderSessionEvidenceV1[];
  runtime: IdeaLabLivePanelAdmissionV1["runtime"];
  runtimeIdentityDigests: Readonly<Record<string, string>>;
  ownerWindow: IdeaLabLivePanelAdmissionV1["ownerWindow"];
  issuedAt: string;
  expiresAt: string;
}): IdeaLabLivePanelAdmissionV1 {
  const session = parseIdeaLabSessionV1(input.session);
  const participantBindings = session.participants.map((participant) => {
    const providerEvidence = input.evidence.find((item) => item.participantId === participant.participantId);
    const runtimeIdentityDigest = input.runtimeIdentityDigests[participant.participantId];
    if (!providerEvidence || !runtimeIdentityDigest) throw new IdeaLabErrorV1("scope_mismatch");
    return {
      participantId: participant.participantId,
      participantIdentityDigest: participant.identityDigest,
      providerEvidenceDigest: providerEvidence.evidenceDigest,
      runtimeIdentityDigest,
      profileIdentityDigest: providerEvidence.profileIdDigest,
      conversationIdentityDigest: providerEvidence.conversationIdDigest,
    };
  });
  const material = {
    contractVersion: IDEA_LAB_LIVE_PANEL_ADMISSION_V1,
    admissionId: input.admissionId,
    runId: input.runId,
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    sessionDigest: session.sessionDigest,
    runtime: input.runtime,
    participantBindings,
    ceilings: {
      maxRounds: session.maxRounds,
      maxMessages: session.maxMessages,
      maxProviderCalls: session.maxMessages,
      maxDurationSeconds: session.maxDurationSeconds,
      maxCostUsd: session.maxCostUsd,
    },
    callPolicy: {
      concurrency: 1 as const,
      durablePreCallMarkerRequired: true as const,
      automaticRetryAllowed: false as const,
      unknownPostMarkerOutcome: "terminal_ambiguity" as const,
      cancelPolicy: "between_calls_only" as const,
      steerPolicy: "disabled_for_panel" as const,
      resumePolicy: "reconcile_only_never_resubmit" as const,
    },
    retainedOutput: {
      schemaId: "control-room-idea-lab-filtered-contribution/v1" as const,
      safeOpinionMaximumCharacters: 800 as const,
      suggestedExperimentMaximumCharacters: 500 as const,
      rawConversationRetained: false as const,
      inputInstructionRetained: false as const,
      messageDeltasRetained: false as const,
      toolArgumentsRetained: false as const,
      providerConfigurationRetained: false as const,
      providerIdentifiersRetainedRaw: false as const,
    },
    ownerWindow: input.ownerWindow,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    livePanelContactPermitted: true as const,
    providerContactScope: "panel_contribution_only" as const,
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsProjectCreationAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  return ideaLabLivePanelAdmissionSchemaV1.parse({ ...material, admissionDigest: sha256Digest(material) });
}

/** The verifier is installed only in an explicitly enabled server composition. */
export interface IdeaLabLivePanelAdmissionAuthorityV1 {
  /** Atomically consume first use; exact same-admission/same-run replay may be returned as already consumed. */
  consume(input: Readonly<{
    admission: IdeaLabLivePanelAdmissionV1;
    session: IdeaLabSessionV1;
    evidence: readonly IdeaLabProviderSessionEvidenceV1[];
    now: string;
  }>): Promise<boolean>;
}

export const IDEA_LAB_LIVE_PANEL_RUNTIME_DISABLED_V1 = Object.freeze({
  contractVersion: "control-room-idea-lab-live-panel-runtime-disposition/v1" as const,
  state: "disabled_pending_native_qualification_and_owner_effect_window" as const,
  acceptedAdmissionDigests: Object.freeze([]) as readonly string[],
  admissionAuthorityConfigured: false as const,
  providerEvidenceAuthorityConfigured: false as const,
  providerDriverConfigured: false as const,
  protectedValuesAccessed: false as const,
  providerContacted: false as const,
  liveProviderAuthorized: false as const,
  grantsExecutionAuthority: false as const,
});
