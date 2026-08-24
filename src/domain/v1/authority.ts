import type { AuthorityEnvelope } from "./types";

const effectRank = { none: 0, approval_required: 1, preauthorized: 2 } as const;
const riskRank = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export interface AuthorityComparison {
  allowed: boolean;
  violations: string[];
}

export function compareDelegatedAuthority(parent: AuthorityEnvelope, child: AuthorityEnvelope): AuthorityComparison {
  const violations: string[] = [];
  const parentOperations = new Set(parent.allowedOperations);
  const parentCredentials = new Set(parent.credentialRefs);
  const parentFilesystemRoots = new Set(parent.filesystemRoots);
  const parentDestinations = new Set(parent.allowedNetworkDestinations);

  if (child.parentDigest !== parent.digest) violations.push("parent_digest_mismatch");
  if (child.projectId !== parent.projectId) violations.push("project_scope_expanded");
  if (child.allowedExecutor !== parent.allowedExecutor) violations.push("executor_changed");
  if (child.allowedOperations.some((operation) => !parentOperations.has(operation))) violations.push("operation_scope_expanded");
  if (child.credentialRefs.some((credential) => !parentCredentials.has(credential))) violations.push("credential_scope_expanded");
  if (child.filesystemRoots.some((root) => !parentFilesystemRoots.has(root))) violations.push("filesystem_scope_expanded");
  if (parent.networkPolicy === "none" && child.networkPolicy !== "none") violations.push("network_scope_expanded");
  if (child.allowedNetworkDestinations.some((destination) => !parentDestinations.has(destination))) violations.push("network_destination_expanded");
  if (effectRank[child.effectPolicy] > effectRank[parent.effectPolicy]) violations.push("effect_authority_expanded");
  if (riskRank[child.maxRisk] > riskRank[parent.maxRisk]) violations.push("risk_expanded");
  if (child.maxDurationSeconds > parent.maxDurationSeconds) violations.push("duration_expanded");
  if (child.maxConcurrentEffects > parent.maxConcurrentEffects) violations.push("concurrency_expanded");
  if (parent.maxCostUsd === undefined && child.maxCostUsd !== undefined && child.maxCostUsd > 0) violations.push("cost_authority_added");
  if (parent.maxCostUsd !== undefined && (child.maxCostUsd === undefined || child.maxCostUsd > parent.maxCostUsd)) violations.push("cost_authority_expanded");
  if (Date.parse(child.expiresAt) > Date.parse(parent.expiresAt)) violations.push("expiry_expanded");

  return { allowed: violations.length === 0, violations };
}

export function assertDelegatedAuthority(parent: AuthorityEnvelope, child: AuthorityEnvelope): void {
  const comparison = compareDelegatedAuthority(parent, child);
  if (!comparison.allowed) {
    throw new Error(`Delegated authority exceeds parent: ${comparison.violations.join(", ")}`);
  }
}
