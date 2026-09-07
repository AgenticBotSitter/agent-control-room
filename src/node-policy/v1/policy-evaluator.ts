import { authorityEnvelopeSchema, compareDelegatedAuthority, type AuthorityEnvelope } from "../../domain/v1";
import { computeAuthorityDigest, sha256Digest } from "../../security";
import { verifyArtifactSignature } from "./crypto";
import { requireCanonicalClockInstant, type Clock } from "./clock";
import {
  executorCapabilitySchema,
  canonicalFilesystemPathSchema,
  canonicalNetworkDestinationSchema,
  keyAvailabilitySchema,
  nodeAuthorityCeilingBodySchema,
  normalizedLocalPolicyRequestSchema,
  ownerApprovalAttestationSchema,
} from "./schemas";
import {
  NODE_POLICY_CONTRACT_V1,
  type ExternalEffectPolicy,
  type LocalDenialDetail,
  type LocalPolicyDecisionV1,
  type LocalPolicyEvaluationInputV1,
  type RiskClass,
  type WireDenialCategory,
} from "./types";

const riskRank: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const effectRank: Record<ExternalEffectPolicy, number> = { none: 0, approval_required: 1, preauthorized: 2 };

const wireCategory: Record<LocalDenialDetail, WireDenialCategory> = {
  ceiling_missing: "storage",
  ceiling_tampered: "storage",
  ceiling_rollback: "storage",
  authority_invalid: "policy",
  authority_expired: "expired",
  authority_not_yet_valid: "policy",
  executor_not_allowed: "policy",
  operation_not_allowed: "policy",
  credential_not_allowed: "policy",
  filesystem_target_not_allowed: "policy",
  network_destination_not_allowed: "policy",
  risk_exceeded: "policy",
  effect_policy_exceeded: "policy",
  approval_missing: "approval_required",
  approval_invalid: "approval_required",
  approval_expired: "approval_required",
  duration_exceeded: "policy",
  cost_unmeasurable: "policy",
  cost_exceeded: "policy",
  concurrency_exceeded: "effect_in_progress",
  keystore_unavailable: "maintenance",
  paused: "maintenance",
  effect_in_progress: "effect_in_progress",
  effect_ambiguous: "ambiguous",
  storage_unavailable: "storage",
};

interface DecisionContext {
  requestId: string;
  requestDigest: string;
  ceilingDigest: string;
  authorityDigest: string;
  decidedAt: string;
}

export function computeNormalizedOperationDigest(request: LocalPolicyEvaluationInputV1["request"]): string {
  return sha256Digest({
    tenantId: request.tenantId,
    nodeId: request.nodeId,
    projectId: request.projectId,
    jobId: request.jobId,
    attemptId: request.attemptId,
    executorId: request.executorId,
    operationId: request.operationId,
    credentialRefs: request.credentialRefs,
    target: request.target,
    risk: request.risk,
    externalEffect: request.externalEffect,
    estimatedDurationSeconds: request.estimatedDurationSeconds,
    ...(request.payloadDigest === undefined ? {} : { payloadDigest: request.payloadDigest }),
    ...(request.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: request.estimatedCostUsd }),
  });
}

function denial(context: DecisionContext, detail: LocalDenialDetail): LocalPolicyDecisionV1 {
  return { contractVersion: NODE_POLICY_CONTRACT_V1, ...context, accepted: false, detail, wireCategory: wireCategory[detail] };
}

function accepted(context: DecisionContext): LocalPolicyDecisionV1 {
  return { contractVersion: NODE_POLICY_CONTRACT_V1, ...context, accepted: true };
}

function isSortedUnique(values: string[]): boolean {
  return new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function validAuthority(authority: AuthorityEnvelope): boolean {
  if (!authorityEnvelopeSchema.safeParse(authority).success || computeAuthorityDigest(authority) !== authority.digest) return false;
  return [authority.allowedOperations, authority.credentialRefs, authority.filesystemRoots, authority.allowedNetworkDestinations].every(isSortedUnique)
    && authority.filesystemRoots.every((root) => canonicalFilesystemPathSchema.safeParse(root).success)
    && authority.allowedNetworkDestinations.every((destination) => canonicalNetworkDestinationSchema.safeParse(destination).success);
}

function subset(values: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

function pathWithin(path: string, root: string): boolean {
  if (path === root) return true;
  const separator = root.includes("\\") ? "\\" : "/";
  return path.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
}

function decimalUnits(value: string): number | undefined {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,5}))?$/.exec(value);
  if (!match) return undefined;
  const units = Number(match[1]) * 100_000 + Number((match[2] ?? "").padEnd(5, "0"));
  return Number.isSafeInteger(units) ? units : undefined;
}

function numericCostUnits(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return decimalUnits(String(value));
}

function validApproval(input: LocalPolicyEvaluationInputV1, nowMs: number, effectiveDeadlineMs: number): LocalDenialDetail | undefined {
  const approval = input.request.approval;
  if (!approval || !input.approvalKey) return "approval_missing";
  const parsed = ownerApprovalAttestationSchema.safeParse(approval);
  if (!parsed.success || input.approvalKey.keyId !== approval.body.approvalKeyId) return "approval_invalid";
  try {
    if (!verifyArtifactSignature(approval, input.approvalKey.publicKeySpki)) return "approval_invalid";
  } catch {
    return "approval_invalid";
  }
  const body = approval.body;
  if (Date.parse(body.issuedAt) > nowMs || Date.parse(body.expiresAt) <= nowMs || Date.parse(body.expiresAt) > effectiveDeadlineMs) return "approval_expired";
  if (body.tenantId !== input.request.tenantId
    || body.projectId !== input.request.projectId
    || body.jobId !== input.request.jobId
    || body.attemptId !== input.request.attemptId
    || body.operationDigest !== input.request.operationDigest
    || body.risk !== input.request.risk
    || (body.nodeId !== undefined && body.nodeId !== input.request.nodeId)
    || (body.nodeClass !== undefined && body.nodeClass !== input.request.nodeClass)) return "approval_invalid";
  return undefined;
}

function validAuthorityChain(lease: LocalPolicyEvaluationInputV1["lease"]): boolean {
  const chain = [...lease.parentAuthorities, lease.authority];
  if (chain.some((authority) => !validAuthority(authority))) return false;
  if (chain[0]?.parentDigest !== undefined) return false;
  for (let index = 1; index < chain.length; index += 1) {
    if (!compareDelegatedAuthority(chain[index - 1], chain[index]).allowed) return false;
  }
  return true;
}

export function evaluateLocalPolicy(input: LocalPolicyEvaluationInputV1, clock: Clock): LocalPolicyDecisionV1 {
  const decidedAt = requireCanonicalClockInstant(clock.now());
  const context: DecisionContext = {
    requestId: input.request.requestId,
    requestDigest: sha256Digest(input.request),
    ceilingDigest: input.ceiling.bodyDigest,
    authorityDigest: input.lease.authorityDigest,
    decidedAt,
  };
  if (!normalizedLocalPolicyRequestSchema.safeParse(input.request).success
    || !nodeAuthorityCeilingBodySchema.safeParse(input.ceiling).success
    || !executorCapabilitySchema.safeParse(input.executor).success
    || !keyAvailabilitySchema.safeParse(input.keyAvailability).success
    || !Number.isSafeInteger(input.activeExternalEffects)
    || input.activeExternalEffects < 0
    || !validAuthorityChain(input.lease)) return denial(context, "authority_invalid");

  const { request, ceiling, lease, executor } = input;
  const authority = lease.authority;
  if (lease.tenantId !== request.tenantId || ceiling.tenantId !== request.tenantId
    || lease.nodeId !== request.nodeId || ceiling.nodeId !== request.nodeId
    || lease.jobId !== request.jobId || lease.attemptId !== request.attemptId
    || lease.leaseId !== request.leaseId || lease.leaseEpoch !== request.leaseEpoch
    || authority.projectId !== request.projectId || !ceiling.projectIds.includes(request.projectId)) return denial(context, "authority_invalid");
  if (lease.authorityDigest !== authority.digest || request.authorityDigest !== authority.digest) return denial(context, "authority_invalid");
  if (request.operationDigest !== computeNormalizedOperationDigest(request)) return denial(context, "authority_invalid");

  const nowMs = Date.parse(decidedAt);
  const leaseValidFromMs = Date.parse(lease.validFrom);
  const leaseExpiryMs = Date.parse(lease.expiresAt);
  const authorityExpiryMs = Date.parse(authority.expiresAt);
  const ceilingIssuedMs = Date.parse(ceiling.issuedAt);
  if (!Number.isFinite(leaseValidFromMs) || !Number.isFinite(leaseExpiryMs) || !Number.isFinite(authorityExpiryMs) || !Number.isFinite(ceilingIssuedMs)
    || leaseValidFromMs >= leaseExpiryMs) return denial(context, "authority_invalid");
  if (nowMs < leaseValidFromMs || nowMs < ceilingIssuedMs || Date.parse(input.keyAvailability.observedAt) > nowMs) return denial(context, "authority_not_yet_valid");
  if (nowMs >= leaseExpiryMs || nowMs >= authorityExpiryMs) return denial(context, "authority_expired");

  if (request.executorId !== authority.allowedExecutor || !ceiling.executorIds.includes(request.executorId) || executor.executorId !== request.executorId) {
    return denial(context, "executor_not_allowed");
  }
  if (!authority.allowedOperations.includes(request.operationId) || !ceiling.operationIds.includes(request.operationId) || !executor.operationIds.includes(request.operationId)) {
    return denial(context, "operation_not_allowed");
  }
  if (executor.externalEffectOperationIds.includes(request.operationId) !== request.externalEffect) return denial(context, "authority_invalid");
  if (!subset(request.credentialRefs, authority.credentialRefs) || !subset(request.credentialRefs, ceiling.credentialRefs)) return denial(context, "credential_not_allowed");
  if (!executor.targetKinds.includes(request.target.kind)) return denial(context, "executor_not_allowed");
  if (request.target.kind === "filesystem") {
    const path = request.target.canonicalPath;
    if (!authority.filesystemRoots.some((root) => pathWithin(path, root))
      || !ceiling.filesystemRoots.some((root) => pathWithin(path, root))) return denial(context, "filesystem_target_not_allowed");
  }
  if (request.target.kind === "network"
    && (authority.networkPolicy !== "allowlist"
      || !authority.allowedNetworkDestinations.includes(request.target.canonicalDestination)
      || !ceiling.networkDestinations.includes(request.target.canonicalDestination)
      || !executor.supportsNetworkIdentityEnforcement)) return denial(context, "network_destination_not_allowed");
  if (riskRank[request.risk] > riskRank[authority.maxRisk] || riskRank[request.risk] > riskRank[ceiling.maxRisk]) return denial(context, "risk_exceeded");
  if (request.estimatedDurationSeconds > authority.maxDurationSeconds || request.estimatedDurationSeconds > ceiling.maxDurationSeconds) return denial(context, "duration_exceeded");
  if (request.estimatedDurationSeconds > 0 && !executor.supportsCancellation) return denial(context, "executor_not_allowed");

  const ceilingCost = ceiling.maxCostUsd === undefined ? undefined : decimalUnits(ceiling.maxCostUsd);
  const authorityCost = numericCostUnits(authority.maxCostUsd);
  const requestedCost = request.estimatedCostUsd === undefined ? undefined : decimalUnits(request.estimatedCostUsd);
  if ((ceiling.maxCostUsd !== undefined && ceilingCost === undefined) || (authority.maxCostUsd !== undefined && authorityCost === undefined)
    || (request.estimatedCostUsd !== undefined && requestedCost === undefined)) return denial(context, "cost_unmeasurable");
  if ((ceilingCost !== undefined || authorityCost !== undefined) && requestedCost === undefined) return denial(context, "cost_unmeasurable");
  if (requestedCost !== undefined && requestedCost > 0) {
    if (executor.costMeter !== "monotonic_reservable") return denial(context, "cost_unmeasurable");
    if (ceilingCost === undefined || authorityCost === undefined || requestedCost > ceilingCost || requestedCost > authorityCost) return denial(context, "cost_exceeded");
  }

  if (input.keyAvailability.state !== "available") return denial(context, "keystore_unavailable");
  if (request.externalEffect) {
    const effectiveEffectRank = Math.min(effectRank[ceiling.externalEffects], effectRank[authority.effectPolicy]);
    if (effectiveEffectRank === effectRank.none) return denial(context, "effect_policy_exceeded");
    if (input.activeExternalEffects >= Math.min(ceiling.maxConcurrentEffects, authority.maxConcurrentEffects)) return denial(context, "concurrency_exceeded");
    if (effectiveEffectRank === effectRank.approval_required) {
      const durationDeadlineMs = nowMs + Math.min(ceiling.maxDurationSeconds, authority.maxDurationSeconds) * 1_000;
      const approvalFailure = validApproval(input, nowMs, Math.min(leaseExpiryMs, authorityExpiryMs, durationDeadlineMs));
      if (approvalFailure) return denial(context, approvalFailure);
    }
  }
  return accepted(context);
}
