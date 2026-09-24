import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyProtectedReleaseReviewOwnerAttestationV1 } from
  "./protected-release-review-owner-attestation";

export const PROTECTED_RELEASE_REVIEW_NATIVE_OWNER_SEAM_V1 =
  "control-room.protected-release-review-native-owner-seam/v1" as const;

type Captured = Readonly<{ installationId: string; releaseDigest: string; topologyPlanDigest: string;
  bundleDigest: string; preparationEvidenceDigest: string; reviewChallengeDigest: string }>;
const plans = new WeakMap<object, Captured>(), consumed = new WeakSet<object>();

function refused(): never {
  const error = new Error("protected_release_review_native_owner_seam_refused"); error.stack = undefined; throw error;
}

/**
 * Fail-closed bridge to the native capability that does not exist yet. It
 * accepts only the opaque plan produced from the one-use release-review
 * capability. In particular, it accepts no owner flag, claimed identity,
 * digest, signature, callback, signer, command runner or executable path.
 *
 * The required runtime primitive is a reviewed, pinned native helper backed by
 * a non-exportable per-installation key whose system policy requires fresh
 * owner presence for this exact review challenge. It must return an outcome
 * signed over the complete installation/release/topology/bundle binding plus a
 * one-use nonce. Current Keychain support retrieves exportable PKCS8 material
 * and current owner-review sessions inject consent/signing ports, so neither
 * can safely implement this boundary.
 */
export function prepareProtectedReleaseReviewNativeOwnerSeamV1(ownerAttestationPlan: unknown) {
  if (!ownerAttestationPlan || typeof ownerAttestationPlan !== "object" || types.isProxy(ownerAttestationPlan)
    || consumed.has(ownerAttestationPlan)) return refused();
  let pending: ReturnType<typeof verifyProtectedReleaseReviewOwnerAttestationV1>;
  try { pending = verifyProtectedReleaseReviewOwnerAttestationV1(ownerAttestationPlan); }
  catch { return refused(); }
  consumed.add(ownerAttestationPlan);
  const captured = Object.freeze({ ...pending,
    reviewChallengeDigest: sha256Digest({ purpose: "protected-release-review-native-owner-challenge/v1",
      installationId: pending.installationId, releaseDigest: pending.releaseDigest,
      topologyPlanDigest: pending.topologyPlanDigest, bundleDigest: pending.bundleDigest,
      preparationEvidenceDigest: pending.preparationEvidenceDigest }) });
  const plan = Object.freeze({ schema: PROTECTED_RELEASE_REVIEW_NATIVE_OWNER_SEAM_V1,
    status: "blocked" as const, blocker: "system_backed_owner_presence_signer_missing" as const,
    installationId: captured.installationId, releaseDigest: captured.releaseDigest,
    topologyPlanDigest: captured.topologyPlanDigest, bundleDigest: captured.bundleDigest,
    preparationEvidenceDigest: captured.preparationEvidenceDigest,
    reviewChallengeDigest: captured.reviewChallengeDigest,
    requiredRuntimePrimitive: Object.freeze({ platform: "darwin" as const,
      nativeHelper: "reviewed_and_pinned" as const,
      signingKey: "non_exportable_per_installation" as const,
      authorizationPolicy: "fresh_system_enforced_owner_presence" as const,
      outcome: "signed_approve_or_reject_bound_to_challenge_and_nonce" as const }),
    providesReviewedReleaseIdentity: false as const, acceptsCallerOwnerPresence: false as const,
    acceptsCallerIdentity: false as const, acceptsCallerDigest: false as const,
    acceptsCallerSignature: false as const, acceptsCallback: false as const,
    accessesKeychain: false as const, promptsOwner: false as const, performsEffect: false as const,
    publishesRelease: false as const, installsRelease: false as const, writesProtectedFiles: false as const });
  plans.set(plan, captured); return plan;
}

export function verifyProtectedReleaseReviewNativeOwnerSeamV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const captured = plans.get(value); if (!captured) return refused(); return captured;
}
