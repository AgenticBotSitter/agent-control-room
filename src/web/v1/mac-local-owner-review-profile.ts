import { completionAcceptanceProfileSchemaV1 } from "../../completion-gate/v1/schemas";
import type { AutomaticDocumentScenario } from "../../completion-gate/v1/native-result-verification";
import { sha256Digest } from "../../security";

const prefix = "profile:mac-local-owner-review:";
export const MAC_LOCAL_TEXT_SCENARIO_V1 = "scenario:mac-local-text" as const;

/** Stable per-project identity: unlike one tenant-wide id, this cannot collide
 * when the owner adds a second project. Long project IDs use a digest suffix. */
export function macLocalOwnerReviewProfileIdV1(projectId: string): string {
  const direct = `${prefix}${projectId}`;
  return direct.length <= 180 ? direct : `${prefix}${sha256Digest(projectId).slice(7, 39)}`;
}

export function createMacLocalOwnerReviewProfileV1(input: Readonly<{
  tenantId: string; projectId: string; ownerIdentityId: string; projectCreatedAt: string;
}>) {
  return completionAcceptanceProfileSchemaV1.parse({ schemaVersion: "control-room-completion-gate/v1",
    id: macLocalOwnerReviewProfileIdV1(input.projectId), tenantId: input.tenantId,
    projectId: input.projectId, name: "Owner review", targetKind: "document",
    requiredVerificationScenarioIds: [MAC_LOCAL_TEXT_SCENARIO_V1], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
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
