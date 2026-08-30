import { timingSafeEqual } from "node:crypto";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierReadyPolicySchemaV1 } from "./ready-policy-schemas";
import {
  READY_FRONTIER_READY_POLICY_V1,
  type ReadyFrontierReadyPolicyV1,
  type ReadyFrontierUnsignedReadyPolicyV1,
} from "./ready-policy-types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("invalid_input");
  return parsed;
}
function uniqueSorted(values: readonly string[]): boolean {
  return new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function ceiling(policy: Pick<ReadyFrontierReadyPolicyV1,
  "maximumMaterializationAgeSeconds" | "maximumActiveReadyGlobal" | "projectPolicies" | "handoffTransport">): unknown {
  return { maximumMaterializationAgeSeconds: policy.maximumMaterializationAgeSeconds,
    maximumActiveReadyGlobal: policy.maximumActiveReadyGlobal, projectPolicies: policy.projectPolicies,
    handoffTransport: policy.handoffTransport };
}
function unsigned(policy: ReadyFrontierReadyPolicyV1): Omit<ReadyFrontierReadyPolicyV1, "policyDigest" | "policyAuthTag"> {
  const { policyDigest: _digest, policyAuthTag: _tag, ...value } = policy; void _digest; void _tag; return value;
}
function canonical(input: ReadyFrontierUnsignedReadyPolicyV1): ReadyFrontierUnsignedReadyPolicyV1 {
  return { ...input, schema: READY_FRONTIER_READY_POLICY_V1,
    projectPolicies: [...input.projectPolicies].map((project) => ({ ...project,
      allowedRouteIds: [...project.allowedRouteIds].sort(), allowedPlatforms: [...project.allowedPlatforms].sort(),
      allowedCapabilities: [...project.allowedCapabilities].sort(),
    })).sort((a, b) => a.projectId.localeCompare(b.projectId)) };
}
function policyTag(key: Uint8Array, policy: ReadyFrontierReadyPolicyV1): string {
  return hmacSha256Tag(key, { schema: policy.schema, tenantId: policy.tenantId, workspaceId: policy.workspaceId,
    policyId: policy.policyId, revision: policy.revision, state: policy.state,
    parentStandingPolicyDigest: policy.parentStandingPolicyDigest, policyDigest: policy.policyDigest });
}
function validate(policy: ReadyFrontierReadyPolicyV1, key: Uint8Array): void {
  if (!same(policy.policyCeilingDigest, sha256Digest(ceiling(policy)))
    || !same(policy.policyDigest, sha256Digest(unsigned(policy)))
    || !same(policy.policyAuthTag, policyTag(key, policy))) fail("digest_mismatch");
  if (instant(policy.recordedAt) > instant(policy.effectiveAt) || instant(policy.effectiveAt) >= instant(policy.expiresAt)) fail("invalid_input");
  if (policy.revision === 1 && (policy.action !== "enroll" || policy.state !== "active" || policy.previousPolicyDigest !== null)) fail("invalid_input");
  if (policy.revision > 1 && (policy.action === "enroll" || policy.previousPolicyDigest === null)) fail("invalid_input");
  if ((policy.action === "suspend") !== (policy.state === "suspended")
    || (policy.action === "revoke") !== (policy.state === "revoked")
    || (["enroll", "revise"].includes(policy.action) && policy.state !== "active")) fail("invalid_input");
  const projects = policy.projectPolicies.map((project) => project.projectId);
  if (!uniqueSorted(projects)) fail("invalid_input");
  for (const project of policy.projectPolicies) {
    if (!uniqueSorted(project.allowedRouteIds) || !uniqueSorted(project.allowedPlatforms)
      || !uniqueSorted(project.allowedCapabilities)) fail("invalid_input");
  }
}

export function buildReadyFrontierReadyPolicyV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierReadyPolicyV1 {
  const snapshot = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy();
  try {
    const input = parseExactReadyFrontierV1(readyFrontierReadyPolicySchemaV1.omit({ policyCeilingDigest: true,
      policyDigest: true, policyAuthTag: true }), value) as ReadyFrontierUnsignedReadyPolicyV1;
    const normalized = canonical(input), policyCeilingDigest = sha256Digest(ceiling(normalized));
    const withoutAuth = { ...normalized, policyCeilingDigest };
    const withDigest = { ...withoutAuth, policyDigest: sha256Digest(withoutAuth), policyAuthTag: "hmac-sha256:" + "0".repeat(64) };
    const policy = parseExactReadyFrontierV1(readyFrontierReadyPolicySchemaV1,
      { ...withDigest, policyAuthTag: policyTag(key, withDigest) }) as ReadyFrontierReadyPolicyV1;
    validate(policy, key); return deepFreeze(policy);
  } finally { key.fill(0); }
}

export function parseReadyFrontierReadyPolicyV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierReadyPolicyV1 {
  const snapshot = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!snapshot || snapshot.byteLength < 32) fail("integrity_failed");
  const key = snapshot.copy();
  try {
    const policy = parseExactReadyFrontierV1(readyFrontierReadyPolicySchemaV1, value) as ReadyFrontierReadyPolicyV1;
    validate(policy, key); return deepFreeze(policy);
  } finally { key.fill(0); }
}
