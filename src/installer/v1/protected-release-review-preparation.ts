import { types } from "node:util";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyLocalInstallationReleasePreparationV1 } from "./local-installation-release.mjs";

export const PROTECTED_RELEASE_REVIEW_PREPARATION_V1 =
  "control-room.protected-release-review-preparation/v1" as const;
export const PROTECTED_RELEASE_REVIEW_INPUT_CAPABILITY_V1 =
  "control-room.protected-release-review-input-capability/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
type Captured = Readonly<{ installationId: string; releaseDigest: string; topologyPlanDigest: string;
  bundleDigest: string; preparationEvidenceDigest: string }>;
const plans = new WeakMap<object, Captured>(), capabilities = new WeakMap<object, Captured>();

function refused(): never {
  const error = new Error("protected_release_review_preparation_refused"); error.stack = undefined; throw error;
}
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) return refused();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refused(); }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Binds the exact filesystem-produced inventory to one installation choice.
 * This is only the input to a future owner review: it deliberately cannot
 * attest that an owner selected or approved the release.
 */
export function prepareProtectedReleaseReviewV1(value: unknown) {
  const input = exact(value, ["installationId", "releaseDigest", "topologyPlanDigest", "releasePreparation"]);
  const selectedInstallationId = installationId.parse(input.installationId);
  const selectedReleaseDigest = digest.parse(input.releaseDigest);
  const selectedTopologyPlanDigest = digest.parse(input.topologyPlanDigest);
  const release = verifyLocalInstallationReleasePreparationV1(input.releasePreparation);
  if (release.bundle.state !== "matched_expected_digest"
    || release.releaseManifestDigest !== selectedReleaseDigest) return refused();
  const captured = Object.freeze({ installationId: selectedInstallationId, releaseDigest: selectedReleaseDigest,
    topologyPlanDigest: selectedTopologyPlanDigest, bundleDigest: release.bundle.digest,
    preparationEvidenceDigest: sha256Digest({ purpose: "protected-release-review-preparation/v1",
      installationId: selectedInstallationId, releaseDigest: selectedReleaseDigest,
      topologyPlanDigest: selectedTopologyPlanDigest, bundleDigest: release.bundle.digest,
      version: release.bundle.version, fileCount: release.bundle.fileCount, byteCount: release.bundle.byteCount }) });
  const ownerReviewInputCapability = Object.freeze({ schema: PROTECTED_RELEASE_REVIEW_INPUT_CAPABILITY_V1 });
  capabilities.set(ownerReviewInputCapability, captured);
  const plan = Object.freeze({ schema: PROTECTED_RELEASE_REVIEW_PREPARATION_V1,
    status: "awaiting_explicit_owner_review" as const, installationId: captured.installationId,
    releaseDigest: captured.releaseDigest, topologyPlanDigest: captured.topologyPlanDigest,
    bundleDigest: captured.bundleDigest, preparationEvidenceDigest: captured.preparationEvidenceDigest,
    ownerReviewInputCapability, containsPath: false as const, containsCredentialValue: false as const,
    performsEffect: false as const, publishesRelease: false as const, installsRelease: false as const,
    startsService: false as const });
  plans.set(plan, captured); return plan;
}

/** Re-authenticates the exact pending plan; a clone cannot become evidence. */
export function verifyProtectedReleaseReviewPreparationV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const captured = plans.get(value); if (!captured) return refused(); return captured;
}

/**
 * One-use handoff reserved for the future owner-attestation host. Consuming it
 * does not approve anything and no reviewed-release issuer exists here.
 */
export function consumeProtectedReleaseReviewInputCapabilityV1(value: unknown) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const captured = capabilities.get(value);
  if (!captured || !capabilities.delete(value)) return refused();
  return Object.freeze({ ...captured, ownerReviewStillRequired: true as const, performsEffect: false as const });
}
