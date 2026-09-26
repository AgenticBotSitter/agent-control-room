import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Digest } from "../src/security/canonical-digest";
import { prepareLocalInstallationReleaseV1 } from "../src/installer/v1/local-installation-release.mjs";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";
import { prepareProtectedReleaseReviewV1 } from
  "../src/installer/v1/protected-release-review-preparation";
import { prepareProtectedReleaseReviewOwnerAttestationV1 } from
  "../src/installer/v1/protected-release-review-owner-attestation";
import { prepareProtectedReleaseReviewNativeOwnerSeamV1,
  verifyProtectedReleaseReviewNativeOwnerSeamV1 } from
  "../src/installer/v1/protected-release-review-native-owner-seam";

const d = (value: string) => sha256Digest(value);

async function releaseSource() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-owner-review-seam-")));
  const releaseDirectory = join(root, "release"), installRoot = join(root, "install");
  await mkdir(installRoot, { mode: 0o700 });
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
  const placement = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot });
  const releaseRoot = join(installRoot, "versions", placement.version);
  const fingerprint = await prepareLocalInstallationReleaseV1({ releaseRoot });
  const preparation = await prepareLocalInstallationReleaseV1({ releaseRoot,
    expectedDigest: fingerprint.bundle.digest });
  return { root, preparation };
}

test("native owner seam stays blocked and rejects fake owner authority", async t => {
  const source = await releaseSource(); t.after(() => rm(source.root, { recursive: true, force: true }));
  const binding = { installationId: "control-room-one",
    releaseDigest: source.preparation.releaseManifestDigest, topologyPlanDigest: d("topology-one") };
  const review = prepareProtectedReleaseReviewV1({ ...binding, releasePreparation: source.preparation });
  const ownerPlan = prepareProtectedReleaseReviewOwnerAttestationV1(review.ownerReviewInputCapability);
  let callbacks = 0;
  for (const forged of [{ ownerAttestationPlan: ownerPlan, ownerAttended: true },
    { ownerAttestationPlan: ownerPlan, ownerIdentity: "owner" },
    { ownerAttestationPlan: ownerPlan, approve() { callbacks += 1; } }, structuredClone(ownerPlan),
    new Proxy(ownerPlan, {})]) {
    assert.throws(() => prepareProtectedReleaseReviewNativeOwnerSeamV1(forged),
      /protected_release_review_native_owner_seam_refused/u);
  }
  assert.equal(callbacks, 0);
  const seam = prepareProtectedReleaseReviewNativeOwnerSeamV1(ownerPlan);
  assert.equal(seam.status, "blocked");
  assert.equal(seam.blocker, "system_backed_owner_presence_signer_missing");
  assert.equal(seam.requiredRuntimePrimitive.authorizationPolicy, "fresh_system_enforced_owner_presence");
  assert.equal(seam.requiredRuntimePrimitive.signingKey, "non_exportable_per_installation");
  assert.equal(seam.providesReviewedReleaseIdentity, false);
  assert.equal(seam.acceptsCallerOwnerPresence, false); assert.equal(seam.acceptsCallerSignature, false);
  assert.equal(seam.acceptsCallback, false); assert.equal(seam.accessesKeychain, false);
  assert.equal(seam.promptsOwner, false); assert.equal(seam.performsEffect, false);
  assert.equal(verifyProtectedReleaseReviewNativeOwnerSeamV1(seam).topologyPlanDigest,
    binding.topologyPlanDigest);
  assert.throws(() => verifyProtectedReleaseReviewNativeOwnerSeamV1(structuredClone(seam)),
    /protected_release_review_native_owner_seam_refused/u);
  assert.throws(() => prepareProtectedReleaseReviewNativeOwnerSeamV1(ownerPlan),
    /protected_release_review_native_owner_seam_refused/u);
});

test("cross-plan challenges remain distinct and neither plan can mint readiness", async t => {
  const source = await releaseSource(); t.after(() => rm(source.root, { recursive: true, force: true }));
  const common = { installationId: "control-room-one", releaseDigest: source.preparation.releaseManifestDigest };
  const local = prepareProtectedReleaseReviewV1({ ...common, topologyPlanDigest: d("local-topology"),
    releasePreparation: source.preparation });
  const foreign = prepareProtectedReleaseReviewV1({ ...common, topologyPlanDigest: d("foreign-topology"),
    releasePreparation: source.preparation });
  const localSeam = prepareProtectedReleaseReviewNativeOwnerSeamV1(
    prepareProtectedReleaseReviewOwnerAttestationV1(local.ownerReviewInputCapability));
  const foreignSeam = prepareProtectedReleaseReviewNativeOwnerSeamV1(
    prepareProtectedReleaseReviewOwnerAttestationV1(foreign.ownerReviewInputCapability));
  assert.notEqual(localSeam.reviewChallengeDigest, foreignSeam.reviewChallengeDigest);
  assert.notEqual(localSeam.topologyPlanDigest, foreignSeam.topologyPlanDigest);
  assert.equal(localSeam.providesReviewedReleaseIdentity, false);
  assert.equal(foreignSeam.providesReviewedReleaseIdentity, false);
  assert.equal(localSeam.performsEffect, false); assert.equal(foreignSeam.performsEffect, false);
});
