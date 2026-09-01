import { z } from "zod";
import { sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import {
  IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  IDEA_LAB_HERMES_021_RELEASE_REVISION_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1,
  IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
  ideaLabHermes021PanelPacketV1,
} from "./hermes-021-panel-packet";
import { hermes021IdeaLabNativeQualificationPlanV1 } from "./hermes-021-native-qualification";
import { capturedIdeaTimeMillisecondsV1, capturedPatternMatchesV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_OWNER_READY_LIVE_PACKET_V1 = "control-room-idea-lab-owner-ready-live-packet/v1" as const;
export const IDEA_LAB_NATIVE_QUALIFICATION_CANDIDATE_V1 =
  "control-room-idea-lab-native-qualification-candidate/v1" as const;

export const IDEA_LAB_ADMISSION_IMPLEMENTATION_COMMIT_V1 = "2aa70fde1657b36a06303a744de736ec30624386" as const;
export const IDEA_LAB_FILTERED_DRIVER_IMPLEMENTATION_COMMIT_V1 = "0d61d8a2a2986c166885b5d7e97bcc7e2b5e09fc" as const;
export const IDEA_LAB_AUTHORITY_IMPLEMENTATION_COMMIT_V1 = "db4b2e470213cd96284cbc201cdfde21a16f09c1" as const;

const packetSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_OWNER_READY_LIVE_PACKET_V1),
  packetId: z.literal("idea-lab-owner-packet:hermes-021:first-live-v1"),
  platform: z.literal("macos"),
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  releaseRevision: z.literal(IDEA_LAB_HERMES_021_RELEASE_REVISION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  sourceCompatibilityCommit: z.literal(IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1),
  sourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1),
  sourcePreflightDigest: z.literal(IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1),
  sourcePreflightAccepted: z.literal(true),
  previousAuthorizationReusable: z.literal(false),
  sourcePanelPacketDigest: z.literal(ideaLabHermes021PanelPacketV1.packetDigest),
  nativeQualificationPlanDigest: z.literal(hermes021IdeaLabNativeQualificationPlanV1.planDigest),
  admissionImplementationCommit: z.literal(IDEA_LAB_ADMISSION_IMPLEMENTATION_COMMIT_V1),
  filteredDriverImplementationCommit: z.literal(IDEA_LAB_FILTERED_DRIVER_IMPLEMENTATION_COMMIT_V1),
  authorityImplementationCommit: z.literal(IDEA_LAB_AUTHORITY_IMPLEMENTATION_COMMIT_V1),
  stages: z.tuple([
    z.object({
      order: z.literal(1),
      stage: z.literal("native_qualification"),
      status: z.literal("ready_for_fresh_owner_authorization"),
      authorizationScope: z.literal("one_disposable_read_only_hermes_021_native_qualification"),
      ownerAttended: z.literal(true),
      ownerRunsAttachedTerminalCommand: z.literal(true),
      codexCannotTypeOwnerPhraseOrApproveKeychain: z.literal(true),
      repositoryNativePortRequired: z.literal(false),
      existingHermesAuthenticationOnly: z.literal(true),
      maximumNativeAttempts: z.literal(1),
      maximumProviderCalls: z.literal(1),
      maximumDurationSeconds: z.literal(300),
      maximumRetainedSanitizedEvidenceBytes: z.literal(262_144),
      toolsAllowed: z.literal(0),
      mcpServersAllowed: z.literal(0),
      pluginsAllowed: z.literal(0),
      repositoryWritesAllowed: z.literal(false),
      temporaryProfileRequired: z.literal(true),
      temporaryEmptyWorkspaceRequired: z.literal(true),
      cleanupRequired: z.literal(true),
      protectedValueCustody: z.literal("hermes_native"),
      controlRoomCanReadProtectedValue: z.literal(false),
      rawContentRetained: z.literal(false),
      automaticRetryAllowed: z.literal(false),
      unknownAfterMarker: z.literal("terminal_ambiguity"),
      output: z.literal("sanitized_unaccepted_candidate_only"),
    }).strict(),
    z.object({
      order: z.literal(2),
      stage: z.literal("independent_receipt_review"),
      status: z.literal("blocked_pending_native_candidate"),
      differentReviewerRequired: z.literal(true),
      exactCandidateDigestRequired: z.literal(true),
      architectDecisionRequired: z.literal(true),
      architectRegistryWriteRequired: z.literal(true),
      canSelfAccept: z.literal(false),
      grantsLivePanelAuthority: z.literal(false),
    }).strict(),
    z.object({
      order: z.literal(3),
      stage: z.literal("first_live_panel"),
      status: z.literal("blocked_pending_accepted_receipt_exact_session_and_separate_owner_window"),
      qualificationWindowReusable: z.literal(false),
      freshStrongFactorOwnerWindowRequired: z.literal(true),
      exactSessionAndParticipantBindingsRequired: z.literal(true),
      acceptedNativeReceiptRequired: z.literal(true),
      durableAuthorityHighWaterRequired: z.literal(true),
      oneAdmissionOneWindowOneRun: z.literal(true),
      providerCallsBoundBySession: z.literal(true),
      automaticRetryAllowed: z.literal(false),
      unknownAfterMarker: z.literal("terminal_ambiguity"),
      projectCreationRequiresSeparateOwnerDecision: z.literal(true),
    }).strict(),
  ]),
  currentStage: z.literal("awaiting_native_qualification_authorization"),
  acceptedNativeReceiptDigests: z.tuple([]),
  sealedAdmissionDigests: z.tuple([]),
  nativeAttemptsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  protectedValuesAccessed: z.literal(false),
  livePanelEligible: z.literal(false),
  blockerCodes: z.tuple([
    z.literal("fresh_native_qualification_authorization_missing"),
    z.literal("native_qualification_candidate_missing"),
    z.literal("independent_receipt_review_missing"),
    z.literal("architect_receipt_acceptance_missing"),
    z.literal("exact_live_session_missing"),
    z.literal("separate_owner_effect_window_missing"),
    z.literal("sealed_admission_missing"),
  ]),
  defaultComposition: z.literal("provider_disabled"),
  browserComposition: z.literal("provider_disabled"),
  localPilotComposition: z.literal("repository_fake_only"),
  productionComposition: z.literal("provider_disabled"),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsProjectCreationAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  packetDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabOwnerReadyLivePacketV1 = z.infer<typeof packetSchema>;

const candidateSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_NATIVE_QUALIFICATION_CANDIDATE_V1),
  packetDigest: ideaDigestSchemaV1,
  planDigest: z.literal(hermes021IdeaLabNativeQualificationPlanV1.planDigest),
  attemptId: ideaIdSchemaV1,
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  outcome: z.enum(["qualified_candidate", "failed_definite", "terminal_ambiguity"]),
  safeCode: z.string().refine((value) => capturedPatternMatchesV1(/^[a-z][a-z0-9_]{1,80}$/, value)),
  attemptedAt: ideaTimeSchemaV1,
  settledAt: ideaTimeSchemaV1,
  nativeAttemptsMade: z.literal(1),
  providerCallsMade: z.number().int().min(0).max(1),
  toolsObserved: z.literal(0),
  mcpServersObserved: z.literal(0),
  pluginsObserved: z.literal(0),
  disposableProfileCreated: z.boolean(),
  disposableWorkspaceCreated: z.boolean(),
  processStopped: z.boolean(),
  disposableProfileRemoved: z.boolean(),
  disposableWorkspaceRemoved: z.boolean(),
  protectedValueCustodyEvidenceDigest: ideaDigestSchemaV1.nullable(),
  sequenceReplayEvidenceDigest: ideaDigestSchemaV1.nullable(),
  usageEvidenceDigest: ideaDigestSchemaV1.nullable(),
  interruptReconciliationEvidenceDigest: ideaDigestSchemaV1.nullable(),
  cleanupEvidenceDigest: ideaDigestSchemaV1.nullable(),
  retainedSanitizedEvidenceBytes: z.number().int().min(0).max(262_144),
  rawContentRetained: z.literal(false),
  rawNativeIdentifiersRetained: z.literal(false),
  protectedValueMaterialRetained: z.literal(false),
  automaticRetryAllowed: z.literal(false),
  independentReviewed: z.literal(false),
  architectAccepted: z.literal(false),
  acceptedRegistryRecordDigest: z.null(),
  livePanelEligible: z.literal(false),
  grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  candidateDigest: ideaDigestSchemaV1,
}).strict();

const candidateInputSchema = candidateSchema.omit({
  contractVersion: true,
  packetDigest: true,
  planDigest: true,
  nativeAttemptsMade: true,
  toolsObserved: true,
  mcpServersObserved: true,
  pluginsObserved: true,
  rawContentRetained: true,
  rawNativeIdentifiersRetained: true,
  protectedValueMaterialRetained: true,
  automaticRetryAllowed: true,
  independentReviewed: true,
  architectAccepted: true,
  acceptedRegistryRecordDigest: true,
  livePanelEligible: true,
  grantsApproval: true,
  grantsExecutionAuthority: true,
  candidateDigest: true,
});

export type IdeaLabNativeQualificationCandidateV1 = z.infer<typeof candidateSchema>;

function without<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value }; delete result[key]; return result;
}

const packetMaterial = {
  contractVersion: IDEA_LAB_OWNER_READY_LIVE_PACKET_V1,
  packetId: "idea-lab-owner-packet:hermes-021:first-live-v1" as const,
  platform: "macos" as const,
  runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1,
  releaseRevision: IDEA_LAB_HERMES_021_RELEASE_REVISION_V1,
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  sourceCompatibilityCommit: IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  sourceManifestDigest: IDEA_LAB_HERMES_021_SOURCE_MANIFEST_DIGEST_V1,
  sourcePreflightDigest: IDEA_LAB_HERMES_021_SOURCE_PREFLIGHT_DIGEST_V1,
  sourcePreflightAccepted: true as const,
  previousAuthorizationReusable: false as const,
  sourcePanelPacketDigest: ideaLabHermes021PanelPacketV1.packetDigest,
  nativeQualificationPlanDigest: hermes021IdeaLabNativeQualificationPlanV1.planDigest,
  admissionImplementationCommit: IDEA_LAB_ADMISSION_IMPLEMENTATION_COMMIT_V1,
  filteredDriverImplementationCommit: IDEA_LAB_FILTERED_DRIVER_IMPLEMENTATION_COMMIT_V1,
  authorityImplementationCommit: IDEA_LAB_AUTHORITY_IMPLEMENTATION_COMMIT_V1,
  stages: [{
    order: 1 as const, stage: "native_qualification" as const, status: "ready_for_fresh_owner_authorization" as const,
    authorizationScope: "one_disposable_read_only_hermes_021_native_qualification" as const,
    ownerAttended: true as const, ownerRunsAttachedTerminalCommand: true as const,
    codexCannotTypeOwnerPhraseOrApproveKeychain: true as const, repositoryNativePortRequired: false as const,
    existingHermesAuthenticationOnly: true as const, maximumNativeAttempts: 1 as const, maximumProviderCalls: 1 as const,
    maximumDurationSeconds: 300 as const, maximumRetainedSanitizedEvidenceBytes: 262_144 as const,
    toolsAllowed: 0 as const, mcpServersAllowed: 0 as const, pluginsAllowed: 0 as const,
    repositoryWritesAllowed: false as const, temporaryProfileRequired: true as const,
    temporaryEmptyWorkspaceRequired: true as const, cleanupRequired: true as const,
    protectedValueCustody: "hermes_native" as const, controlRoomCanReadProtectedValue: false as const,
    rawContentRetained: false as const, automaticRetryAllowed: false as const,
    unknownAfterMarker: "terminal_ambiguity" as const, output: "sanitized_unaccepted_candidate_only" as const,
  }, {
    order: 2 as const, stage: "independent_receipt_review" as const, status: "blocked_pending_native_candidate" as const,
    differentReviewerRequired: true as const, exactCandidateDigestRequired: true as const,
    architectDecisionRequired: true as const, architectRegistryWriteRequired: true as const,
    canSelfAccept: false as const, grantsLivePanelAuthority: false as const,
  }, {
    order: 3 as const, stage: "first_live_panel" as const,
    status: "blocked_pending_accepted_receipt_exact_session_and_separate_owner_window" as const,
    qualificationWindowReusable: false as const, freshStrongFactorOwnerWindowRequired: true as const,
    exactSessionAndParticipantBindingsRequired: true as const, acceptedNativeReceiptRequired: true as const,
    durableAuthorityHighWaterRequired: true as const, oneAdmissionOneWindowOneRun: true as const,
    providerCallsBoundBySession: true as const, automaticRetryAllowed: false as const,
    unknownAfterMarker: "terminal_ambiguity" as const, projectCreationRequiresSeparateOwnerDecision: true as const,
  }] as const,
  currentStage: "awaiting_native_qualification_authorization" as const,
  acceptedNativeReceiptDigests: [] as const, sealedAdmissionDigests: [] as const,
  nativeAttemptsMade: 0 as const, providerCallsMade: 0 as const, protectedValuesAccessed: false as const,
  livePanelEligible: false as const,
  blockerCodes: ["fresh_native_qualification_authorization_missing", "native_qualification_candidate_missing",
    "independent_receipt_review_missing", "architect_receipt_acceptance_missing", "exact_live_session_missing",
    "separate_owner_effect_window_missing", "sealed_admission_missing"] as const,
  defaultComposition: "provider_disabled" as const, browserComposition: "provider_disabled" as const,
  localPilotComposition: "repository_fake_only" as const, productionComposition: "provider_disabled" as const,
  grantsApproval: false as const, grantsCommandAuthority: false as const, grantsLeaseAuthority: false as const,
  grantsProjectCreationAuthority: false as const, grantsExecutionAuthority: false as const,
};

export const ideaLabOwnerReadyLivePacketV1: IdeaLabOwnerReadyLivePacketV1 = Object.freeze(
  packetSchema.parse({ ...packetMaterial, packetDigest: sha256Digest(packetMaterial) }),
);

export function parseIdeaLabOwnerReadyLivePacketV1(value: unknown): IdeaLabOwnerReadyLivePacketV1 {
  const parsed = parseExactIdeaLabV1(packetSchema, value);
  if (sha256Digest(without(parsed, "packetDigest")) !== parsed.packetDigest) throw new IdeaLabErrorV1("integrity_failed");
  return parsed;
}

function validateCandidate(parsed: IdeaLabNativeQualificationCandidateV1): void {
  const completeEvidence = parsed.protectedValueCustodyEvidenceDigest !== null
    && parsed.sequenceReplayEvidenceDigest !== null && parsed.usageEvidenceDigest !== null
    && parsed.interruptReconciliationEvidenceDigest !== null && parsed.cleanupEvidenceDigest !== null;
  const attempted = capturedIdeaTimeMillisecondsV1(parsed.attemptedAt)!;
  const settled = capturedIdeaTimeMillisecondsV1(parsed.settledAt)!;
  if (settled < attempted || settled - attempted > 300_000
    || (parsed.outcome === "failed_definite" && ((parsed.disposableProfileCreated && !parsed.disposableProfileRemoved)
      || (parsed.disposableWorkspaceCreated && !parsed.disposableWorkspaceRemoved) || !parsed.processStopped))
    || (parsed.outcome === "terminal_ambiguity" && parsed.providerCallsMade !== 1)
    || (parsed.outcome === "qualified_candidate" && (parsed.providerCallsMade !== 1 || !completeEvidence
      || !parsed.disposableProfileCreated || !parsed.disposableWorkspaceCreated || !parsed.processStopped
      || !parsed.disposableProfileRemoved || !parsed.disposableWorkspaceRemoved
      || parsed.retainedSanitizedEvidenceBytes < 1))) throw new IdeaLabErrorV1("integrity_failed");
}

export function buildIdeaLabNativeQualificationCandidateV1(input: z.infer<typeof candidateInputSchema>):
  IdeaLabNativeQualificationCandidateV1 {
  const parsedInput = parseExactIdeaLabV1(candidateInputSchema, input);
  const material = {
    contractVersion: IDEA_LAB_NATIVE_QUALIFICATION_CANDIDATE_V1,
    packetDigest: ideaLabOwnerReadyLivePacketV1.packetDigest,
    planDigest: hermes021IdeaLabNativeQualificationPlanV1.planDigest,
    ...parsedInput,
    nativeAttemptsMade: 1 as const, toolsObserved: 0 as const, mcpServersObserved: 0 as const, pluginsObserved: 0 as const,
    rawContentRetained: false as const, rawNativeIdentifiersRetained: false as const,
    protectedValueMaterialRetained: false as const, automaticRetryAllowed: false as const,
    independentReviewed: false as const, architectAccepted: false as const, acceptedRegistryRecordDigest: null,
    livePanelEligible: false as const, grantsApproval: false as const, grantsExecutionAuthority: false as const,
  };
  const candidate = candidateSchema.parse({ ...material, candidateDigest: sha256Digest(material) });
  validateCandidate(candidate);
  return candidate;
}

export function parseIdeaLabNativeQualificationCandidateV1(value: unknown): IdeaLabNativeQualificationCandidateV1 {
  const parsed = parseExactIdeaLabV1(candidateSchema, value);
  if (parsed.packetDigest !== ideaLabOwnerReadyLivePacketV1.packetDigest
    || sha256Digest(without(parsed, "candidateDigest")) !== parsed.candidateDigest) throw new IdeaLabErrorV1("integrity_failed");
  validateCandidate(parsed);
  return parsed;
}
