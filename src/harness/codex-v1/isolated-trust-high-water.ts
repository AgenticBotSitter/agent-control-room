import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import { fingerprintCodexExecutorTrustKeyV1, type CodexExecutorTrustPinRegistryEvidenceV1 } from "./isolated-trust-pins";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
const MAX_CLOCK_SKEW_MS = 5_000;

export interface CodexOwnerTrustHighWaterCheckpointV1 {
  schema: "control-room.codex-owner-trust-high-water/v1";
  checkpointId: string; qualificationId: string; registryIdentityDigest: string;
  revision: number; manifestDigest: string; resolvedPinsDigest: string | null; manifestState: "active" | "revoked";
  recordedAt: string; supersedesCheckpointDigest: string | null; ownerSignature: string;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ownerKey(spki: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spki, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Codex trust high-water owner key invalid");
  return key;
}

export function signCodexOwnerTrustHighWaterCheckpointV1(
  material: Omit<CodexOwnerTrustHighWaterCheckpointV1, "ownerSignature">, ownerPrivateKey: KeyObject,
): CodexOwnerTrustHighWaterCheckpointV1 {
  return { ...material, ownerSignature: sign(null, Buffer.from(canonicalJson(material)), ownerPrivateKey).toString("base64url") };
}

export function assertCodexOwnerTrustHighWaterTransitionV1(prior: CodexOwnerTrustHighWaterCheckpointV1 | undefined,
  checkpoint: CodexOwnerTrustHighWaterCheckpointV1): void {
  if (!prior) {
    if (checkpoint.revision !== 1 || checkpoint.supersedesCheckpointDigest !== null) throw new Error("Codex trust high-water revision invalid");
    return;
  }
  if (prior.manifestState === "revoked" || checkpoint.revision !== prior.revision + 1
    || checkpoint.supersedesCheckpointDigest !== sha256Digest(prior)
    || checkpoint.qualificationId !== prior.qualificationId
    || checkpoint.registryIdentityDigest !== prior.registryIdentityDigest) throw new Error("Codex trust high-water revision invalid");
}

export function verifyCodexOwnerTrustHighWaterCheckpointV1(input: {
  checkpoint: CodexOwnerTrustHighWaterCheckpointV1; registryEvidence: CodexExecutorTrustPinRegistryEvidenceV1;
  ownerPublicKeySpki: string; expectedRegistryIdentityDigest: string; now: string;
}): { anchored: true; checkpointDigest: string; revision: number; manifestDigest: string } {
  const checkpoint = input.checkpoint;
  const keys = ["schema", "checkpointId", "qualificationId", "registryIdentityDigest", "revision", "manifestDigest", "resolvedPinsDigest",
    "manifestState", "recordedAt", "supersedesCheckpointDigest", "ownerSignature"];
  const observed = Date.parse(input.now); const recorded = Date.parse(checkpoint?.recordedAt);
  if (!exactKeys(checkpoint, keys) || checkpoint.schema !== "control-room.codex-owner-trust-high-water/v1"
    || !IDENTIFIER.test(checkpoint.checkpointId) || !IDENTIFIER.test(checkpoint.qualificationId)
    || !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 1
    || !DIGEST.test(checkpoint.registryIdentityDigest) || !DIGEST.test(checkpoint.manifestDigest)
    || (checkpoint.resolvedPinsDigest !== null && !DIGEST.test(checkpoint.resolvedPinsDigest))
    || (checkpoint.manifestState === "active") !== (checkpoint.resolvedPinsDigest !== null)
    || !(checkpoint.manifestState === "active" || checkpoint.manifestState === "revoked")
    || (checkpoint.supersedesCheckpointDigest !== null && !DIGEST.test(checkpoint.supersedesCheckpointDigest))
    || !Number.isFinite(observed) || !Number.isFinite(recorded) || recorded > observed + MAX_CLOCK_SKEW_MS
    || checkpoint.registryIdentityDigest !== input.expectedRegistryIdentityDigest
    || checkpoint.qualificationId !== input.registryEvidence.qualificationId
    || checkpoint.revision !== input.registryEvidence.currentRevision
    || checkpoint.manifestDigest !== input.registryEvidence.currentManifestDigest
    || checkpoint.resolvedPinsDigest !== input.registryEvidence.resolvedPinsDigest
    || checkpoint.manifestState !== input.registryEvidence.state
    || input.registryEvidence.manifestCount < checkpoint.revision
    || input.registryEvidence.ownerKeyFingerprint !== fingerprintCodexExecutorTrustKeyV1(input.ownerPublicKeySpki)) {
    throw new Error("Codex trust high-water mismatch");
  }
  const { ownerSignature, ...material } = checkpoint;
  let valid = false;
  try { valid = verify(null, Buffer.from(canonicalJson(material)), ownerKey(input.ownerPublicKeySpki), Buffer.from(ownerSignature, "base64url")); }
  catch { valid = false; }
  if (!valid) throw new Error("Codex trust high-water owner signature invalid");
  return { anchored: true, checkpointDigest: sha256Digest(checkpoint), revision: checkpoint.revision,
    manifestDigest: checkpoint.manifestDigest };
}
