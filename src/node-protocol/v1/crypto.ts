import { createHash, createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import { enrollmentProofSchema, signedNodeFrameSchema } from "./schemas";
import type { EnrollmentProof, NodeMessageType, SignedNodeFrame, UnsignedNodeFrame } from "./types";

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function publicKeyFromSpki(spki: string): KeyObject {
  const key = createPublicKey({ key: decodeBase64Url(spki), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Only Ed25519 node keys are accepted");
  return key;
}

export function publicKeyFingerprint(spki: string): string {
  publicKeyFromSpki(spki);
  return `sha256:${createHash("sha256").update(decodeBase64Url(spki)).digest("hex")}`;
}

export function enrollmentProofMaterial(proof: EnrollmentProof): Omit<EnrollmentProof, "signature"> {
  const validated = enrollmentProofSchema.parse(proof);
  const { signature, ...material } = validated;
  void signature;
  return material;
}

export function signEnrollmentProof(proof: Omit<EnrollmentProof, "signature">, privateKey: KeyObject): EnrollmentProof {
  const material = enrollmentProofSchema.omit({ signature: true }).parse(proof);
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), privateKey).toString("base64url") };
}

export function verifyEnrollmentProof(proof: EnrollmentProof): boolean {
  const validated = enrollmentProofSchema.parse(proof);
  return verify(null, Buffer.from(canonicalJson(enrollmentProofMaterial(validated))), publicKeyFromSpki(validated.publicKey.spki), decodeBase64Url(validated.signature));
}

export function frameSigningMaterial(frame: SignedNodeFrame): Omit<SignedNodeFrame, "signature"> {
  const validated = signedNodeFrameSchema.parse(frame) as SignedNodeFrame;
  const { signature, ...material } = validated;
  void signature;
  return material;
}

export function signNodeFrame<TType extends NodeMessageType>(frame: UnsignedNodeFrame<TType>, privateKey: KeyObject): SignedNodeFrame<TType> {
  const withDigest = {
    ...frame,
    bodyDigest: sha256Digest(frame.body),
    signature: Buffer.alloc(64).toString("base64url"),
  } as SignedNodeFrame<TType>;
  const material = frameSigningMaterial(withDigest);
  return signedNodeFrameSchema.parse({
    ...material,
    signature: sign(null, Buffer.from(canonicalJson(material)), privateKey).toString("base64url"),
  }) as unknown as SignedNodeFrame<TType>;
}

export function verifyNodeFrameSignature(frame: SignedNodeFrame, publicKeySpki: string): boolean {
  const material = frameSigningMaterial(frame);
  return verify(null, Buffer.from(canonicalJson(material)), publicKeyFromSpki(publicKeySpki), decodeBase64Url(frame.signature));
}

export function opaqueTokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function opaqueTokenMatches(token: string, expectedDigest: string): boolean {
  const actual = Buffer.from(opaqueTokenDigest(token));
  const expected = Buffer.from(expectedDigest);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
