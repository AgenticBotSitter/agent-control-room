import { timingSafeEqual } from "node:crypto";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import {
  readyFrontierCycleInputSchemaV1,
  readyFrontierEvaluationSchemaV1,
  readyFrontierOperatorProjectionSchemaV1,
  readyFrontierPolicySchemaV1,
  readyFrontierProposalSchemaV1,
  readyFrontierSourceSchemaV1,
} from "./schemas";
import {
  READY_FRONTIER_EVALUATION_V1,
  READY_FRONTIER_OPERATOR_PROJECTION_V1,
  READY_FRONTIER_POLICY_V1,
  READY_FRONTIER_PROPOSAL_V1,
  READY_FRONTIER_SOURCE_V1,
  readyFrontierRiskClassesV1,
  type ReadyFrontierCandidateV1,
  type ReadyFrontierCycleInputV1,
  type ReadyFrontierDispositionOutcomeV1,
  type ReadyFrontierDispositionV1,
  type ReadyFrontierEvaluationV1,
  type ReadyFrontierOperatorProjectionV1,
  type ReadyFrontierPolicyV1,
  type ReadyFrontierProjectPolicyV1,
  type ReadyFrontierProposalV1,
  type ReadyFrontierReasonCodeV1,
  type ReadyFrontierSourceSnapshotV1,
} from "./types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("invalid_input");
  return parsed;
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function sorted(values: readonly string[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]! < value); }
function riskIndex(value: string): number { return readyFrontierRiskClassesV1.indexOf(value as never); }

type UnsignedSourceV1 = Omit<ReadyFrontierSourceSnapshotV1, "sourceDigest">;
type UnsignedPolicyV1 = Omit<ReadyFrontierPolicyV1, "policyDigest">;
type UnsignedProposalV1 = Omit<ReadyFrontierProposalV1, "proposalDigest" | "proposalAuthTag">;
type UnsignedEvaluationV1 = Omit<ReadyFrontierEvaluationV1, "evaluationDigest" | "evaluationAuthTag">;

function sourceUnsigned(value: ReadyFrontierSourceSnapshotV1): UnsignedSourceV1 {
  const { sourceDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
}
function policyUnsigned(value: ReadyFrontierPolicyV1): UnsignedPolicyV1 {
  const { policyDigest: _digest, ...unsigned } = value; void _digest; return unsigned;
}
function proposalUnsigned(value: ReadyFrontierProposalV1): UnsignedProposalV1 {
  const { proposalDigest: _digest, proposalAuthTag: _tag, ...unsigned } = value; void _digest; void _tag; return unsigned;
}
function evaluationUnsigned(value: ReadyFrontierEvaluationV1): UnsignedEvaluationV1 {
  const { evaluationDigest: _digest, evaluationAuthTag: _tag, ...unsigned } = value; void _digest; void _tag; return unsigned;
}

function canonicalSource(unsigned: UnsignedSourceV1): UnsignedSourceV1 {
  return {
    ...unsigned,
    projects: [...unsigned.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    routes: [...unsigned.routes].map((route) => ({ ...route, supportedPlatforms: [...route.supportedPlatforms].sort() }))
      .sort((a, b) => a.routeId.localeCompare(b.routeId)),
    dependencyTruth: [...unsigned.dependencyTruth].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    candidates: [...unsigned.candidates].map((candidate) => ({
      ...candidate,
      dependencyCandidateIds: [...candidate.dependencyCandidateIds].sort(),
      blockerCodes: [...candidate.blockerCodes].sort(),
      evidenceDigests: [...candidate.evidenceDigests].sort(),
    })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    canonicalWork: [...unsigned.canonicalWork].sort((a, b) => a.workItemId.localeCompare(b.workItemId)),
    priorProposals: [...unsigned.priorProposals].sort((a, b) => a.proposalId.localeCompare(b.proposalId)),
  };
}

function canonicalPolicy(unsigned: UnsignedPolicyV1): UnsignedPolicyV1 {
  return {
    ...unsigned,
    projectPolicies: [...unsigned.projectPolicies].map((policy) => ({ ...policy, allowedRouteIds: [...policy.allowedRouteIds].sort() }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
}

function validateSource(source: ReadyFrontierSourceSnapshotV1): void {
  if (!same(source.sourceDigest, sha256Digest(sourceUnsigned(source)))) fail("digest_mismatch");
  const projectIds = source.projects.map((item) => item.projectId), routeIds = source.routes.map((item) => item.routeId);
  const candidateIds = source.candidates.map((item) => item.candidateId), dependencyIds = source.dependencyTruth.map((item) => item.candidateId);
  const workIds = source.canonicalWork.map((item) => item.workItemId), proposalIds = source.priorProposals.map((item) => item.proposalId);
  if (![projectIds, routeIds, candidateIds, dependencyIds, workIds, proposalIds].every(unique)
    || !sorted(projectIds) || !sorted(routeIds) || !sorted(candidateIds) || !sorted(dependencyIds) || !sorted(workIds) || !sorted(proposalIds)
    || source.projects.reduce((sum, item) => sum + item.targetShareBps, 0) > 10_000) fail("invalid_input");
  const projects = new Set(projectIds), observedAt = instant(source.observedAt);
  for (const route of source.routes) {
    if (!unique(route.supportedPlatforms) || !sorted(route.supportedPlatforms) || instant(route.observedAt) > observedAt) fail("invalid_input");
  }
  for (const truth of source.dependencyTruth) {
    if (!projects.has(truth.projectId) || instant(truth.observedAt) > observedAt) fail("scope_mismatch");
  }
  for (const candidate of source.candidates) {
    if (!projects.has(candidate.projectId) || !unique(candidate.dependencyCandidateIds) || !sorted(candidate.dependencyCandidateIds)
      || candidate.dependencyCandidateIds.includes(candidate.candidateId)
      || !unique(candidate.blockerCodes) || !sorted(candidate.blockerCodes)
      || !unique(candidate.evidenceDigests) || !sorted(candidate.evidenceDigests)
      || instant(candidate.createdAt) > observedAt
      || (candidate.deadlineAt !== null && instant(candidate.deadlineAt) < instant(candidate.createdAt))) fail("invalid_input");
  }
  for (const work of source.canonicalWork) {
    if (!projects.has(work.projectId) || instant(work.observedAt) > observedAt) fail("scope_mismatch");
  }
  for (const proposal of source.priorProposals) {
    if (!projects.has(proposal.projectId)) fail("scope_mismatch");
    instant(proposal.observedAt);
  }
}

function validatePolicy(policy: ReadyFrontierPolicyV1): void {
  if (!same(policy.policyDigest, sha256Digest(policyUnsigned(policy)))) fail("digest_mismatch");
  if (instant(policy.effectiveAt) >= instant(policy.expiresAt)
    || policy.maximumCostMicrousdPerProposal > policy.maximumCycleCostMicrousd) fail("invalid_input");
  const projects = policy.projectPolicies.map((item) => item.projectId);
  if (!unique(projects) || !sorted(projects)) fail("invalid_input");
  for (const item of policy.projectPolicies) {
    if (!unique(item.allowedRouteIds) || !sorted(item.allowedRouteIds)
      || item.maximumCostMicrousdPerProposal > item.maximumCycleCostMicrousd) fail("invalid_input");
  }
}

export function buildReadyFrontierSourceV1(value: UnsignedSourceV1): ReadyFrontierSourceSnapshotV1 {
  const parsed = parseExactReadyFrontierV1(readyFrontierSourceSchemaV1.omit({ sourceDigest: true }), value) as UnsignedSourceV1;
  const unsigned = canonicalSource(parsed);
  const source = parseExactReadyFrontierV1(readyFrontierSourceSchemaV1, {
    ...unsigned, schema: READY_FRONTIER_SOURCE_V1, sourceDigest: sha256Digest(unsigned),
  }) as ReadyFrontierSourceSnapshotV1;
  validateSource(source); return deepFreeze(source);
}

export function parseReadyFrontierSourceV1(value: unknown): ReadyFrontierSourceSnapshotV1 {
  const source = parseExactReadyFrontierV1(readyFrontierSourceSchemaV1, value) as ReadyFrontierSourceSnapshotV1;
  validateSource(source); return deepFreeze(source);
}

export function buildReadyFrontierPolicyV1(value: UnsignedPolicyV1): ReadyFrontierPolicyV1 {
  const parsed = parseExactReadyFrontierV1(readyFrontierPolicySchemaV1.omit({ policyDigest: true }), value) as UnsignedPolicyV1;
  const unsigned = canonicalPolicy(parsed);
  const policy = parseExactReadyFrontierV1(readyFrontierPolicySchemaV1, {
    ...unsigned, schema: READY_FRONTIER_POLICY_V1, policyDigest: sha256Digest(unsigned),
  }) as ReadyFrontierPolicyV1;
  validatePolicy(policy); return deepFreeze(policy);
}

export function parseReadyFrontierPolicyV1(value: unknown): ReadyFrontierPolicyV1 {
  const policy = parseExactReadyFrontierV1(readyFrontierPolicySchemaV1, value) as ReadyFrontierPolicyV1;
  validatePolicy(policy); return deepFreeze(policy);
}

function proposalTag(key: Uint8Array, proposal: ReadyFrontierProposalV1): string {
  return hmacSha256Tag(key, { schema: proposal.schema, proposalId: proposal.proposalId, cycleId: proposal.cycleId,
    tenantId: proposal.tenantId, projectId: proposal.projectId, candidateId: proposal.candidateId, proposalDigest: proposal.proposalDigest });
}
function evaluationTag(key: Uint8Array, evaluation: ReadyFrontierEvaluationV1): string {
  return hmacSha256Tag(key, { schema: evaluation.schema, cycleId: evaluation.cycleId, tenantId: evaluation.tenantId,
    sourceDigest: evaluation.sourceDigest, policyDigest: evaluation.policyDigest, evaluationDigest: evaluation.evaluationDigest });
}

function buildProposal(input: {
  key: Uint8Array; cycleId: string; evaluatedAt: string; source: ReadyFrontierSourceSnapshotV1; policy: ReadyFrontierPolicyV1;
  project: ReadyFrontierSourceSnapshotV1["projects"][number]; projectPolicy: ReadyFrontierProjectPolicyV1;
  candidate: ReadyFrontierCandidateV1; rank: number;
}): ReadyFrontierProposalV1 {
  const proposalId = `frontier.proposal.${sha256Digest({ cycleId: input.cycleId, candidateId: input.candidate.candidateId,
    intentDigest: input.candidate.intentDigest }).slice(7, 39)}`;
  const unsigned: UnsignedProposalV1 = {
    schema: READY_FRONTIER_PROPOSAL_V1, proposalId, cycleId: input.cycleId, tenantId: input.source.tenantId,
    projectId: input.candidate.projectId, candidateId: input.candidate.candidateId, intentDigest: input.candidate.intentDigest,
    goalDigest: input.project.goalDigest, sourceDigest: input.source.sourceDigest, policyDigest: input.policy.policyDigest,
    ownerPolicyDigest: input.projectPolicy.ownerPolicyDigest, ownerPolicyVerified: false,
    title: input.candidate.title, objective: input.candidate.objective,
    routeId: input.candidate.routeId, platform: input.candidate.platform, requiredCapability: input.candidate.requiredCapability,
    risk: input.candidate.risk, estimatedCostMicrousd: input.candidate.estimatedCostMicrousd, priority: input.candidate.priority,
    rank: input.rank, proposedAt: input.evaluatedAt,
    expiresAt: new Date(instant(input.evaluatedAt) + input.policy.proposalTtlSeconds * 1_000).toISOString(),
    state: "proposal_only", ownerReviewState: "required_not_requested", createsCanonicalWork: false, grantsApproval: false,
    grantsReadyTransition: false, grantsClaimOrLease: false, grantsDispatchOrExecution: false, grantsProviderAccess: false,
    grantsExternalEffect: false,
  };
  const withDigest = { ...unsigned, proposalDigest: sha256Digest(unsigned), proposalAuthTag: "hmac-sha256:" + "0".repeat(64) };
  const proposal = { ...withDigest, proposalAuthTag: proposalTag(input.key, withDigest) };
  return parseExactReadyFrontierV1(readyFrontierProposalSchemaV1, proposal) as ReadyFrontierProposalV1;
}

interface RankedCandidateV1 {
  candidate: ReadyFrontierCandidateV1;
  project: ReadyFrontierSourceSnapshotV1["projects"][number];
  projectPolicy: ReadyFrontierProjectPolicyV1;
  ageMinutes: number;
  starved: boolean;
  score: number;
}

function outcomeFor(reasons: ReadyFrontierReasonCodeV1[]): ReadyFrontierDispositionOutcomeV1 {
  if (reasons.some((reason) => reason.startsWith("duplicate_"))) return "duplicate_suppressed";
  if (reasons.some((reason) => ["project_inactive", "dependency_unsatisfied", "dependency_unknown", "dependency_stale", "candidate_blocked",
    "route_missing", "route_unavailable", "route_stale", "platform_unsupported", "deadline_expired"].includes(reason))) return "blocked";
  if (reasons.includes("review_pending") || reasons.includes("review_rejected")) return "needs_review";
  if (reasons.some((reason) => ["project_policy_missing", "project_policy_disabled", "route_disallowed", "risk_limit_exceeded",
    "proposal_cost_limit_exceeded"].includes(reason))) return "deferred_policy";
  return "blocked";
}

function hardReasons(input: {
  candidate: ReadyFrontierCandidateV1; source: ReadyFrontierSourceSnapshotV1; policy: ReadyFrontierPolicyV1;
  evaluatedAtMs: number; duplicateSourceIntents: Set<string>; canonicalIntents: Set<string>; priorProposalIntents: Set<string>;
}): { reasons: ReadyFrontierReasonCodeV1[]; projectPolicy?: ReadyFrontierProjectPolicyV1 } {
  const { candidate, source, policy } = input, reasons: ReadyFrontierReasonCodeV1[] = [];
  const project = source.projects.find((item) => item.projectId === candidate.projectId)!;
  const projectPolicy = policy.projectPolicies.find((item) => item.projectId === candidate.projectId);
  const route = source.routes.find((item) => item.routeId === candidate.routeId);
  if (project.state !== "active") reasons.push("project_inactive");
  if (!projectPolicy) reasons.push("project_policy_missing");
  else if (!projectPolicy.enabled) reasons.push("project_policy_disabled");
  if (input.duplicateSourceIntents.has(candidate.intentDigest)) reasons.push("duplicate_source_intent");
  if (input.canonicalIntents.has(candidate.intentDigest)) reasons.push("duplicate_canonical_intent");
  if (input.priorProposalIntents.has(candidate.intentDigest)) reasons.push("duplicate_prior_proposal_intent");
  if (candidate.blockerCodes.length) reasons.push("candidate_blocked");
  if (candidate.reviewTruth === "pending") reasons.push("review_pending");
  if (candidate.reviewTruth === "rejected") reasons.push("review_rejected");
  for (const dependencyId of candidate.dependencyCandidateIds) {
    const truth = source.dependencyTruth.find((item) => item.candidateId === dependencyId && item.projectId === candidate.projectId);
    if (!truth || truth.state === "unknown") reasons.push("dependency_unknown");
    else if (input.evaluatedAtMs - instant(truth.observedAt) > policy.maxSourceAgeSeconds * 1_000) reasons.push("dependency_stale");
    else if (truth.state === "blocked") reasons.push("dependency_unsatisfied");
  }
  if (!route) reasons.push("route_missing");
  else {
    if (route.state === "unavailable") reasons.push("route_unavailable");
    if (input.evaluatedAtMs - instant(route.observedAt) > policy.maxSourceAgeSeconds * 1_000) reasons.push("route_stale");
    if (!route.supportedPlatforms.includes(candidate.platform) && !route.supportedPlatforms.includes("any")) reasons.push("platform_unsupported");
    if (riskIndex(candidate.risk) > riskIndex(route.maximumRisk) || candidate.estimatedCostMicrousd > route.maximumCostMicrousd) {
      reasons.push(candidate.estimatedCostMicrousd > route.maximumCostMicrousd ? "proposal_cost_limit_exceeded" : "risk_limit_exceeded");
    }
  }
  if (projectPolicy) {
    if (!projectPolicy.allowedRouteIds.includes(candidate.routeId)) reasons.push("route_disallowed");
    if (riskIndex(candidate.risk) > riskIndex(projectPolicy.maximumRisk)) reasons.push("risk_limit_exceeded");
    if (candidate.estimatedCostMicrousd > projectPolicy.maximumCostMicrousdPerProposal) reasons.push("proposal_cost_limit_exceeded");
  }
  if (riskIndex(candidate.risk) > riskIndex(policy.maximumRisk)) reasons.push("risk_limit_exceeded");
  if (candidate.estimatedCostMicrousd > policy.maximumCostMicrousdPerProposal) reasons.push("proposal_cost_limit_exceeded");
  if (candidate.deadlineAt !== null && instant(candidate.deadlineAt) <= input.evaluatedAtMs) reasons.push("deadline_expired");
  return { reasons: [...new Set(reasons)].sort(), projectPolicy };
}

export function evaluateReadyFrontierV1(inputValue: unknown, integrityKeyValue: unknown): ReadyFrontierEvaluationV1 {
  const hostKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!hostKey || hostKey.byteLength < 32) fail("integrity_failed");
  const key = hostKey.copy();
  try {
    const input = parseExactReadyFrontierV1(readyFrontierCycleInputSchemaV1, inputValue) as ReadyFrontierCycleInputV1;
    const source = parseReadyFrontierSourceV1(input.source), policy = parseReadyFrontierPolicyV1(input.policy);
    const evaluatedAtMs = instant(input.evaluatedAt), sourceAt = instant(source.observedAt);
    if (source.tenantId !== policy.tenantId || source.tenantId !== input.source.tenantId
      || evaluatedAtMs < sourceAt || evaluatedAtMs - sourceAt > policy.maxSourceAgeSeconds * 1_000
      || source.priorProposals.some((item) => instant(item.observedAt) > evaluatedAtMs)
      || evaluatedAtMs < instant(policy.effectiveAt) || evaluatedAtMs >= instant(policy.expiresAt)) fail("scope_mismatch");
    const sourceProjectIds = new Set(source.projects.map((item) => item.projectId));
    if (policy.projectPolicies.some((item) => !sourceProjectIds.has(item.projectId))) fail("scope_mismatch");

    const intentCounts = new Map<string, number>();
    for (const candidate of source.candidates) intentCounts.set(candidate.intentDigest, (intentCounts.get(candidate.intentDigest) ?? 0) + 1);
    const duplicateSourceIntents = new Set([...intentCounts].filter(([, count]) => count > 1).map(([digest]) => digest));
    const canonicalIntents = new Set(source.canonicalWork.map((item) => item.intentDigest));
    const priorProposalIntents = new Set(source.priorProposals.map((item) => item.intentDigest));
    const dispositions = new Map<string, ReadyFrontierDispositionV1>(), eligible: RankedCandidateV1[] = [];
    for (const candidate of source.candidates) {
      const project = source.projects.find((item) => item.projectId === candidate.projectId)!;
      const checked = hardReasons({ candidate, source, policy, evaluatedAtMs, duplicateSourceIntents, canonicalIntents, priorProposalIntents });
      if (checked.reasons.length || !checked.projectPolicy) {
        dispositions.set(candidate.candidateId, { candidateId: candidate.candidateId, projectId: candidate.projectId,
          outcome: outcomeFor(checked.reasons), reasonCodes: checked.reasons, score: null, proposalId: null });
        continue;
      }
      const ageMinutes = Math.floor((evaluatedAtMs - instant(candidate.createdAt)) / 60_000);
      const fairShareDebt = Math.max(0, project.targetShareBps - project.recentProposalShareBps);
      const score = Math.round((candidate.priority * 1_000 + candidate.downstreamUnlockCount * 100
        + Math.min(ageMinutes, policy.starvationBoundMinutes) * 5 + fairShareDebt / 10
        - candidate.estimatedCostMicrousd / 10_000) * 100) / 100;
      eligible.push({ candidate, project, projectPolicy: checked.projectPolicy, ageMinutes,
        starved: ageMinutes >= policy.starvationBoundMinutes, score });
    }
    eligible.sort((a, b) => Number(b.starved) - Number(a.starved)
      || (a.starved ? b.ageMinutes - a.ageMinutes : b.score - a.score)
      || b.candidate.downstreamUnlockCount - a.candidate.downstreamUnlockCount
      || b.candidate.priority - a.candidate.priority
      || a.candidate.projectId.localeCompare(b.candidate.projectId)
      || a.candidate.candidateId.localeCompare(b.candidate.candidateId));

    const proposals: ReadyFrontierProposalV1[] = [], projectCounts = new Map<string, number>(), projectCosts = new Map<string, number>();
    const routeCounts = new Map<string, number>(); let totalCost = 0;
    for (const item of eligible) {
      const route = source.routes.find((candidateRoute) => candidateRoute.routeId === item.candidate.routeId)!;
      const projectCount = projectCounts.get(item.candidate.projectId) ?? 0, projectCost = projectCosts.get(item.candidate.projectId) ?? 0;
      let reason: ReadyFrontierReasonCodeV1 | undefined;
      if (proposals.length >= policy.maxProposalsPerCycle) reason = "cycle_capacity_exhausted";
      else if (item.project.outstandingProposalCount + projectCount >= item.projectPolicy.maxOutstandingProposals
        || projectCount >= item.projectPolicy.maxProposalsPerCycle) reason = "project_capacity_exhausted";
      else if ((routeCounts.get(item.candidate.routeId) ?? 0) >= Math.min(route.availableProposalSlots, policy.maxProposalsPerRoute)) {
        reason = "route_capacity_exhausted";
      } else if (totalCost + item.candidate.estimatedCostMicrousd > policy.maximumCycleCostMicrousd
        || projectCost + item.candidate.estimatedCostMicrousd > item.projectPolicy.maximumCycleCostMicrousd) reason = "cycle_cost_exhausted";
      if (reason) {
        dispositions.set(item.candidate.candidateId, { candidateId: item.candidate.candidateId, projectId: item.candidate.projectId,
          outcome: "deferred_capacity", reasonCodes: [reason], score: item.score, proposalId: null });
        continue;
      }
      const proposal = buildProposal({ key, cycleId: input.cycleId, evaluatedAt: input.evaluatedAt, source, policy,
        project: item.project, projectPolicy: item.projectPolicy, candidate: item.candidate, rank: proposals.length + 1 });
      proposals.push(proposal); projectCounts.set(item.candidate.projectId, projectCount + 1);
      projectCosts.set(item.candidate.projectId, projectCost + item.candidate.estimatedCostMicrousd);
      routeCounts.set(item.candidate.routeId, (routeCounts.get(item.candidate.routeId) ?? 0) + 1);
      totalCost += item.candidate.estimatedCostMicrousd;
      dispositions.set(item.candidate.candidateId, { candidateId: item.candidate.candidateId, projectId: item.candidate.projectId,
        outcome: "proposed", reasonCodes: item.starved ? ["selected", "starvation_bound_reached"] : ["selected"],
        score: item.score, proposalId: proposal.proposalId });
    }
    const orderedDispositions = [...dispositions.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    const unsigned: UnsignedEvaluationV1 = {
      schema: READY_FRONTIER_EVALUATION_V1, cycleId: input.cycleId, tenantId: source.tenantId,
      sourceSnapshotId: source.snapshotId, sourceRevision: source.sourceRevision, sourceDigest: source.sourceDigest,
      sourceHistoryRevision: source.historyRevision,
      policyId: policy.policyId, policyRevision: policy.revision, policyDigest: policy.policyDigest, evaluatedAt: input.evaluatedAt,
      proposals, dispositions: orderedDispositions, proposalCount: proposals.length,
      blockedCount: orderedDispositions.filter((item) => item.outcome === "blocked").length,
      needsReviewCount: orderedDispositions.filter((item) => item.outcome === "needs_review").length,
      duplicateSuppressedCount: orderedDispositions.filter((item) => item.outcome === "duplicate_suppressed").length,
      deferredCount: orderedDispositions.filter((item) => item.outcome === "deferred_capacity" || item.outcome === "deferred_policy").length,
      totalEstimatedCostMicrousd: totalCost, proposalOnly: true, createdCanonicalWork: false, createdAttempts: false,
      createdLeases: false, createdDispatches: false, contactedProvider: false, performedExternalEffect: false,
    };
    const withDigest = { ...unsigned, evaluationDigest: sha256Digest(unsigned), evaluationAuthTag: "hmac-sha256:" + "0".repeat(64) };
    return deepFreeze(parseExactReadyFrontierV1(readyFrontierEvaluationSchemaV1, {
      ...withDigest, evaluationAuthTag: evaluationTag(key, withDigest),
    }) as ReadyFrontierEvaluationV1);
  } finally { key.fill(0); }
}

export function parseReadyFrontierEvaluationV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierEvaluationV1 {
  const hostKey = exactHostUint8ArrayV1(integrityKeyValue, 128);
  if (!hostKey || hostKey.byteLength < 32) fail("integrity_failed");
  const key = hostKey.copy();
  try {
    const evaluation = parseExactReadyFrontierV1(readyFrontierEvaluationSchemaV1, value) as ReadyFrontierEvaluationV1;
    if (!same(evaluation.evaluationDigest, sha256Digest(evaluationUnsigned(evaluation)))
      || !same(evaluation.evaluationAuthTag, evaluationTag(key, evaluation))
      || evaluation.proposalCount !== evaluation.proposals.length
      || evaluation.totalEstimatedCostMicrousd !== evaluation.proposals.reduce((sum, item) => sum + item.estimatedCostMicrousd, 0)
      || evaluation.dispositions.length !== new Set(evaluation.dispositions.map((item) => item.candidateId)).size
      || evaluation.proposals.some((proposal, index) => proposal.rank !== index + 1
        || !same(proposal.proposalDigest, sha256Digest(proposalUnsigned(proposal)))
        || !same(proposal.proposalAuthTag, proposalTag(key, proposal))
        || proposal.cycleId !== evaluation.cycleId || proposal.tenantId !== evaluation.tenantId
        || proposal.sourceDigest !== evaluation.sourceDigest || proposal.policyDigest !== evaluation.policyDigest)
      || evaluation.dispositions.filter((item) => item.outcome === "proposed").length !== evaluation.proposalCount
      || evaluation.blockedCount !== evaluation.dispositions.filter((item) => item.outcome === "blocked").length
      || evaluation.needsReviewCount !== evaluation.dispositions.filter((item) => item.outcome === "needs_review").length
      || evaluation.duplicateSuppressedCount !== evaluation.dispositions.filter((item) => item.outcome === "duplicate_suppressed").length
      || evaluation.deferredCount !== evaluation.dispositions.filter((item) => item.outcome.startsWith("deferred_")).length) fail("integrity_failed");
    const proposalIds = new Set(evaluation.proposals.map((item) => item.proposalId));
    const proposedDispositions = evaluation.dispositions.filter((item) => item.outcome === "proposed");
    const dispositionProposalIds = new Set(proposedDispositions.map((item) => item.proposalId));
    if (proposalIds.size !== evaluation.proposals.length || dispositionProposalIds.size !== evaluation.proposals.length
      || evaluation.dispositions.some((item) => item.outcome === "proposed"
        ? item.proposalId === null || !proposalIds.has(item.proposalId) : item.proposalId !== null)
      || evaluation.proposals.some((proposal) => !proposedDispositions.some((item) => item.proposalId === proposal.proposalId
        && item.candidateId === proposal.candidateId && item.projectId === proposal.projectId))) fail("integrity_failed");
    return deepFreeze(evaluation);
  } finally { key.fill(0); }
}

export function projectReadyFrontierOperatorV1(value: unknown, integrityKeyValue: unknown): ReadyFrontierOperatorProjectionV1 {
  const evaluation = parseReadyFrontierEvaluationV1(value, integrityKeyValue);
  const projectIds = [...new Set(evaluation.dispositions.map((item) => item.projectId))].sort();
  const reasonCounts = new Map<ReadyFrontierReasonCodeV1, number>();
  for (const disposition of evaluation.dispositions) for (const reason of disposition.reasonCodes) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  const unsigned: Omit<ReadyFrontierOperatorProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_OPERATOR_PROJECTION_V1, cycleId: evaluation.cycleId, tenantId: evaluation.tenantId,
    sourceSnapshotId: evaluation.sourceSnapshotId, evaluatedAt: evaluation.evaluatedAt,
    proposals: evaluation.proposals.map((proposal) => ({ proposalId: proposal.proposalId, projectId: proposal.projectId,
      title: proposal.title, routeId: proposal.routeId, platform: proposal.platform, risk: proposal.risk,
      estimatedCostMicrousd: proposal.estimatedCostMicrousd, priority: proposal.priority, rank: proposal.rank,
      ownerReviewState: proposal.ownerReviewState })),
    projects: projectIds.map((projectId) => { const items = evaluation.dispositions.filter((item) => item.projectId === projectId); return {
      projectId, proposalCount: items.filter((item) => item.outcome === "proposed").length,
      blockedCount: items.filter((item) => item.outcome === "blocked").length,
      needsReviewCount: items.filter((item) => item.outcome === "needs_review").length,
      deferredCount: items.filter((item) => item.outcome.startsWith("deferred_")).length,
    }; }),
    reasonCounts: [...reasonCounts].map(([reasonCode, count]) => ({ reasonCode, count })).sort((a, b) => a.reasonCode.localeCompare(b.reasonCode)),
    proposalOnly: true, ownerReviewRequired: true, canApprove: false, canReady: false, canClaimOrLease: false,
    canDispatchOrExecute: false,
  };
  return deepFreeze(parseExactReadyFrontierV1(readyFrontierOperatorProjectionSchemaV1, {
    ...unsigned, projectionDigest: sha256Digest(unsigned),
  }) as ReadyFrontierOperatorProjectionV1);
}
