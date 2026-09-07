import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthorityEnvelope, EffectIntentRecord } from "../domain/v1/types";
import { hostUint8ArrayByteLengthV1 } from "./host-value";
import { canonicalJson, sha256Digest } from "./canonical-digest";

export { canonicalJson, sha256Digest } from "./canonical-digest";

const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const reflectApply = Reflect.apply;
const hmacProbe = createHmac("sha256", new Uint8Array(32));
const hmacPrototype = objectGetPrototypeOf(hmacProbe);
const hmacUpdateCandidate = objectGetOwnPropertyDescriptor(hmacPrototype, "update")?.value as unknown;
const hmacDigestCandidate = objectGetOwnPropertyDescriptor(hmacPrototype, "digest")?.value as unknown;
if (typeof hmacUpdateCandidate !== "function" || typeof hmacDigestCandidate !== "function") {
  throw new Error("HMAC runtime unavailable");
}
const hmacUpdate = hmacUpdateCandidate as (...args: unknown[]) => unknown;
const hmacDigest = hmacDigestCandidate as (...args: unknown[]) => unknown;
reflectApply(hmacUpdate, hmacProbe, ["", "utf8"]);
reflectApply(hmacDigest, hmacProbe, ["hex"]);

function assertHmacRuntime(): void {
  const updateDescriptor = objectGetOwnPropertyDescriptor(hmacPrototype, "update");
  const digestDescriptor = objectGetOwnPropertyDescriptor(hmacPrototype, "digest");
  if (!updateDescriptor || !("value" in updateDescriptor) || updateDescriptor.value !== hmacUpdate
    || !digestDescriptor || !("value" in digestDescriptor) || digestDescriptor.value !== hmacDigest) {
    throw new Error("HMAC runtime invalid");
  }
}

export function assertHmacSha256RuntimeV1(): void {
  assertHmacRuntime();
}

/** Authenticates mutable-store evidence with a key that must remain outside that store. */
export function hmacSha256Tag(key: Uint8Array, value: unknown): string {
  const byteLength = hostUint8ArrayByteLengthV1(key);
  if (byteLength === undefined || byteLength < 32) throw new Error("integrity key invalid");
  const material = canonicalJson(value);
  assertHmacRuntime();
  const hmac = createHmac("sha256", key);
  reflectApply(hmacUpdate, hmac, [material, "utf8"]);
  return `hmac-sha256:${reflectApply(hmacDigest, hmac, ["hex"]) as string}`;
}

export function digestMatches(value: unknown, expected: string): boolean {
  const actual = sha256Digest(value);
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function assertDigest(value: unknown, expected: string, label = "payload"): void {
  if (!digestMatches(value, expected)) throw new Error(`${label} digest mismatch`);
}

export function computeAuthorityDigest(authority: AuthorityEnvelope): string {
  return sha256Digest({
    projectId: authority.projectId,
    allowedExecutor: authority.allowedExecutor,
    allowedOperations: authority.allowedOperations,
    credentialRefs: authority.credentialRefs,
    filesystemRoots: authority.filesystemRoots,
    networkPolicy: authority.networkPolicy,
    allowedNetworkDestinations: authority.allowedNetworkDestinations,
    effectPolicy: authority.effectPolicy,
    maxRisk: authority.maxRisk,
    maxDurationSeconds: authority.maxDurationSeconds,
    maxConcurrentEffects: authority.maxConcurrentEffects,
    ...(authority.maxCostUsd === undefined ? {} : { maxCostUsd: authority.maxCostUsd }),
    expiresAt: authority.expiresAt,
    ...(authority.parentDigest === undefined ? {} : { parentDigest: authority.parentDigest }),
  });
}

export function assertAuthorityDigest(authority: AuthorityEnvelope): void {
  if (computeAuthorityDigest(authority) !== authority.digest) throw new Error("Authority digest mismatch");
}

export function computeEffectOperationDigest(effect: Pick<EffectIntentRecord,
  "tenantId" | "jobId" | "attemptId" | "operation" | "destination" | "idempotencyKey" | "risk"
>, projectId: string): string {
  return sha256Digest({
    tenantId: effect.tenantId,
    projectId,
    jobId: effect.jobId,
    attemptId: effect.attemptId,
    operation: effect.operation,
    destination: effect.destination,
    idempotencyKey: effect.idempotencyKey,
    risk: effect.risk,
  });
}
