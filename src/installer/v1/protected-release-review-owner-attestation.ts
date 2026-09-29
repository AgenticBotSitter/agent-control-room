import { types } from "node:util";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { consumeProtectedReleaseReviewInputCapabilityV1 } from "./protected-release-review-preparation";

export const PROTECTED_RELEASE_REVIEW_OWNER_ATTESTATION_V1 =
  "control-room.protected-release-review-owner-attestation/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const pendingSchema = z.object({ installationId, releaseDigest: digest, topologyPlanDigest: digest,
  bundleDigest: digest, preparationEvidenceDigest: digest, ownerReviewStillRequired: z.literal(true),
  performsEffect: z.literal(false) }).strict();
type Pending = Readonly<z.infer<typeof pendingSchema>>;
const plans = new WeakMap<object, Pending>();

function refused(): never {
  const error = new Error("protected_release_review_owner_attestation_refused"); error.stack = undefined; throw error;
}

/**
 * Consumes the exact one-use release-review handoff and describes the remaining
 * native trust boundary without pretending to implement it. The repository's
 * existing owner approval issuer accepts injected consent and signing ports;
 * that is appropriate for its bounded runtime composition, but it cannot prove
 * who reviewed this release. Until a non-injectable owner identity/signing host
 * exists, no reviewed-release identity capability is minted here.
 */
export function prepareProtectedReleaseReviewOwnerAttestationV1(
  ownerReviewInputCapability: unknown,
) {
  const pending = pendingSchema.parse(
    consumeProtectedReleaseReviewInputCapabilityV1(ownerReviewInputCapability),
  );
  const plan = Object.freeze({ schema: PROTECTED_RELEASE_REVIEW_OWNER_ATTESTATION_V1,
    status: "blocked" as const, blocker: "native_owner_release_review_host_missing" as const,
    installationId: pending.installationId, releaseDigest: pending.releaseDigest,
    topologyPlanDigest: pending.topologyPlanDigest, bundleDigest: pending.bundleDigest,
    preparationEvidenceDigest: pending.preparationEvidenceDigest,
    pendingReviewDigest: sha256Digest({ purpose: "protected-release-review-owner-attestation/v1",
      installationId: pending.installationId, releaseDigest: pending.releaseDigest,
      topologyPlanDigest: pending.topologyPlanDigest, bundleDigest: pending.bundleDigest,
      preparationEvidenceDigest: pending.preparationEvidenceDigest }),
    requiredNativeBoundary: "non_injectable_owner_identity_and_signed_review_outcome" as const,
    providesReviewedReleaseIdentity: false as const, acceptsCallerApproval: false as const,
    acceptsCallerDigest: false as const, acceptsCallback: false as const,
    containsCredentialValue: false as const, containsPrivatePath: false as const,
    performsEffect: false as const, publishesRelease: false as const, installsRelease: false as const,
    writesProtectedFiles: false as const, startsService: false as const });
  plans.set(plan, pending); return plan;
}

/** A structural clone is only display data and cannot become trusted input. */
export function verifyProtectedReleaseReviewOwnerAttestationV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const pending = plans.get(value); if (!pending) return refused(); return pending;
}
