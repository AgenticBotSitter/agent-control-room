import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import type { TrustBundleShrinkAuthorizationV1 } from "./types";

type ArtifactBody = { bodyDigest: string };
type SignedArtifact<TBody extends ArtifactBody> = {
  body: TBody;
  signatureAlgorithm: "Ed25519";
  signature: string;
};

export function artifactDigestMaterial<TBody extends object>(body: TBody): Omit<TBody, "bodyDigest"> {
  const { bodyDigest: _bodyDigest, ...material } = body as TBody & { bodyDigest?: string };
  void _bodyDigest;
  return material as Omit<TBody, "bodyDigest">;
}

export function computeArtifactBodyDigest<TBody extends object>(body: TBody): string {
  return sha256Digest(artifactDigestMaterial(body));
}

export function assertArtifactBodyDigest<TBody extends ArtifactBody>(body: TBody): void {
  if (computeArtifactBodyDigest(body) !== body.bodyDigest) throw new Error("Artifact body digest mismatch");
}

export function signArtifact<TBody extends ArtifactBody>(body: TBody, privateKey: KeyObject): SignedArtifact<TBody> {
  assertArtifactBodyDigest(body);
  return {
    body,
    signatureAlgorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

export function verifyArtifactSignature<TBody extends ArtifactBody>(artifact: SignedArtifact<TBody>, publicKeySpki: string): boolean {
  assertArtifactBodyDigest(artifact.body);
  const publicKey = createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 artifact keys are accepted");
  return verify(null, Buffer.from(canonicalJson(artifact.body)), publicKey, Buffer.from(artifact.signature, "base64url"));
}

export function trustBundleShrinkAuthorizationMaterial(keyId: string, bundleBodyDigest: string): Record<string, string> {
  return {
    schema: "control-room.trust-bundle-shrink-authorization/v1",
    keyId,
    bundleBodyDigest,
  };
}

export function signTrustBundleShrinkAuthorization(bundleBodyDigest: string, keyId: string, privateKey: KeyObject): TrustBundleShrinkAuthorizationV1 {
  const material = trustBundleShrinkAuthorizationMaterial(keyId, bundleBodyDigest);
  return {
    keyId,
    bundleBodyDigest,
    signatureAlgorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalJson(material)), privateKey).toString("base64url"),
  };
}

export function verifyTrustBundleShrinkAuthorization(authorization: TrustBundleShrinkAuthorizationV1, publicKeySpki: string): boolean {
  const publicKey = createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 artifact keys are accepted");
  return verify(
    null,
    Buffer.from(canonicalJson(trustBundleShrinkAuthorizationMaterial(authorization.keyId, authorization.bundleBodyDigest))),
    publicKey,
    Buffer.from(authorization.signature, "base64url"),
  );
}
