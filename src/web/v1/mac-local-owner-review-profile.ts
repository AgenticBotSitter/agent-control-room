import { completionAcceptanceProfileSchemaV1 } from "../../completion-gate/v1/schemas";
import type { AutomaticDocumentScenario } from "../../completion-gate/v1/native-result-verification";
import { sha256Digest } from "../../security";
import { reviewerSeparationForPolicyV1, type ReviewerIndependencePolicyV1 } from "../../completion-gate/v1/reviewer-independence";
import type { ManualVerificationScenario, ManualVerificationScenarioSource } from "./task-verification-service";

export const MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1 = "profile:mac-local-owner-review:v2:" as const;
export const MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1 = 32 as const;
export const MAC_LOCAL_TEXT_SCENARIO_V1 = "scenario:mac-local-text" as const;
export const MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1 = "scenario:mac-local-human-verification" as const;

/** Stable per-project identity: unlike one tenant-wide id, this cannot collide
 * when the owner adds a second project. Long project IDs use a digest suffix. */
export function macLocalOwnerReviewProfileIdV1(projectId: string): string {
  const direct = `${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}${projectId}`;
  const start = "sha256:".length;
  return direct.length <= 180 ? direct : `${MAC_LOCAL_OWNER_REVIEW_PROFILE_PREFIX_V1}`
    + sha256Digest(projectId).slice(start, start + MAC_LOCAL_OWNER_REVIEW_PROFILE_DIGEST_HEX_LENGTH_V1);
}

export function createMacLocalOwnerReviewProfileV1(input: Readonly<{
  tenantId: string; projectId: string; ownerIdentityId: string; projectCreatedAt: string;
  reviewerIndependence?: ReviewerIndependencePolicyV1;
}>) {
  return completionAcceptanceProfileSchemaV1.parse({ schemaVersion: "control-room-completion-gate/v1",
    id: macLocalOwnerReviewProfileIdV1(input.projectId), tenantId: input.tenantId,
    projectId: input.projectId, name: "Owner review", targetKind: "document",
    requiredVerificationScenarioIds: [MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1, MAC_LOCAL_TEXT_SCENARIO_V1], minimumIndependentReviews: 1,
    reviewerSeparation: reviewerSeparationForPolicyV1(input.reviewerIndependence ?? "different_model_family"),
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 3,
    automaticLowRiskDisposition: false,
    createdBy: { actorId: input.ownerIdentityId, actorType: "human" }, createdAt: input.projectCreatedAt,
  });
}

/** Deterministic structure check only. It does not claim semantic quality or
 * replace the owner's independent accept/correct decision. */
export function createMacLocalTextScenarioV1(profile: ReturnType<typeof createMacLocalOwnerReviewProfileV1>): AutomaticDocumentScenario {
  return Object.freeze({ scenarioId: MAC_LOCAL_TEXT_SCENARIO_V1, acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), rules: { version: "document-structure/v1" as const,
      minUtf8Bytes: 1, maxUtf8Bytes: 65_536, requiredHeadings: [], forbiddenTerms: [] } });
}

/** Human observation is a separate scenario and record from the automatic
 * structure check. No automatic operation can create this descriptor's result. */
export function createMacLocalHumanVerificationScenarioV1(
  profile: ReturnType<typeof createMacLocalOwnerReviewProfileV1>,
): ManualVerificationScenario {
  return Object.freeze({ scenarioId: MAC_LOCAL_HUMAN_VERIFICATION_SCENARIO_V1,
    label: "Owner human verification", instructions: "Read the protected text result and record whether it satisfies the task instructions based on your own observation.",
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile) });
}

/** Controlled live-project registry. The verification service revalidates its
 * snapshot on every read, so registering a project cannot alter prior entries. */
export function createMacLocalHumanVerificationRegistryV1(
  profiles: readonly ReturnType<typeof createMacLocalOwnerReviewProfileV1>[],
): ManualVerificationScenarioSource & Readonly<{ register(profile: ReturnType<typeof createMacLocalOwnerReviewProfileV1>): void }> {
  let values = Object.freeze(profiles.map(createMacLocalHumanVerificationScenarioV1));
  return Object.freeze({ list: () => values, register(profile: ReturnType<typeof createMacLocalOwnerReviewProfileV1>) {
    const descriptor = createMacLocalHumanVerificationScenarioV1(profile);
    const existing = values.find(value => value.acceptanceProfileId === descriptor.acceptanceProfileId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error("mac_local_human_verification_conflict");
      return;
    }
    values = Object.freeze([...values, descriptor]);
  } });
}
