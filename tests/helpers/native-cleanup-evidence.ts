import { createHash, generateKeyPairSync } from "node:crypto";
import { createNativeCleanupEvidence, type NativeCleanupAcceptanceBody, type NativeCleanupSnapshot } from "../../src/harness/hermes-native-v1/cleanup-evidence";
import { bindingSchema, enrollmentSchema } from "../../src/harness/hermes-native-v1/contracts";
import { PinnedApprovalTrustStore } from "../../src/node-policy/v1/pinned-approval-trust";
import { computeArtifactBodyDigest, signArtifact } from "../../src/node-policy/v1/crypto";
import { sha256Digest } from "../../src/security";

type Readers = Parameters<typeof createNativeCleanupEvidence>[1];
/** Synthetic acceptance only; never physical host qualification or owner signing. */
export function syntheticCleanupEvidence(input: Pick<Readers, "runs" | "effects"> & {
  enrollment: unknown; binding: unknown; clock: () => number;
  security: Readers["security"] & ConstructorParameters<typeof PinnedApprovalTrustStore>[1]["security"];
}) {
  const enrollment = enrollmentSchema.parse(input.enrollment), binding = bindingSchema.parse(input.binding);
  const keys = generateKeyPairSync("ed25519"), now = input.clock;
  const body: NativeCleanupAcceptanceBody = {
    schema: "control-room.native-cleanup-acceptance/v1", enrollmentDigest: sha256Digest(enrollment),
    producerDigest: sha256Digest("synthetic-cleanup-producer"), evidenceDigest: sha256Digest("synthetic-host-review-not-qualification"),
    nodeClass: "personal-compute", approvalKeyId: "owner-key:cleanup", issuedAt: now() - 1000, expiresAt: enrollment.validUntil,
    guarantees: { exactRunIsolation: true, descendantsStoppedVerified: true, nativeRequestsDrainedVerified: true,
      durableRevisionTracking: true }, bodyDigest: "" };
  body.bodyDigest = computeArtifactBodyDigest(body);
  const acceptance = signArtifact(body, keys.privateKey), spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pins = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1", tenantId: enrollment.tenantId,
    nodeId: enrollment.nodeId, nodeClass: body.nodeClass, validFrom: body.issuedAt, validUntil: body.expiresAt,
    keys: [{ keyId: body.approvalKeyId, algorithm: "ed25519", spki,
      fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` }] },
  { security: input.security, clock: now });
  try {
    const snapshot = input.runs.load(binding.runId), claim = input.effects.load(binding.effectClaimKey);
    if (!snapshot || snapshot.state !== "completed" || claim?.kind !== "full" || !claim.snapshot.markerDigest || !snapshot.nativeRunId)
      throw new Error("fixture missing exact retained evidence");
    const proof: NativeCleanupSnapshot = { enrollmentDigest: body.enrollmentDigest, producerDigest: body.producerDigest,
      bindingDigest: sha256Digest(binding), nativeRunId: snapshot.nativeRunId, snapshotDigest: sha256Digest(snapshot),
      markerDigest: claim.snapshot.markerDigest, revision: 1, observedAt: now(), validUntil: now() + 10_000,
      state: "quiescent", remainingDescendants: 0, pendingNativeRequests: 0 };
    const config = { enrollment, binding, acceptance };
    const deps = { approvals: pins, security: input.security, runs: input.runs, effects: input.effects,
      readSupervisedCleanup: () => proof, clock: now };
    return { config, deps, proof, snapshot, claim: claim.snapshot,
      create: () => createNativeCleanupEvidence(config, deps), close: () => pins.close() };
  } catch (error) { pins.close(); throw error; }
}
