import { createHash, timingSafeEqual } from "node:crypto";
import type { AuthorityEnvelope, EffectIntentRecord } from "../domain/v1/types";

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const child = record[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new Error(`Non-JSON value at ${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(child, `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`Non-JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
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
