import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sha256Digest } from "../src/security";
import {
  READY_FRONTIER_EVALUATION_V1,
  READY_FRONTIER_POLICY_V1,
  READY_FRONTIER_PROPOSAL_V1,
  READY_FRONTIER_SOURCE_V1,
  ReadyFrontierContractErrorV1,
  buildReadyFrontierFixtureV1,
  buildReadyFrontierPolicyV1,
  buildReadyFrontierSourceV1,
  evaluateReadyFrontierV1,
  parseReadyFrontierEvaluationV1,
  parseReadyFrontierPolicyV1,
  parseReadyFrontierSourceV1,
  projectReadyFrontierOperatorV1,
  type ReadyFrontierPolicyV1,
  type ReadyFrontierSourceSnapshotV1,
} from "../src/ready-frontier/v1";
import { observedProxy } from "./proxy-test-helper";

const key = () => new Uint8Array(32).fill(0x6b);
const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;

function sourceInput(source: ReadyFrontierSourceSnapshotV1) {
  const { sourceDigest: _digest, ...input } = source; void _digest; return input;
}
function policyInput(policy: ReadyFrontierPolicyV1) {
  const { policyDigest: _digest, ...input } = policy; void _digest; return input;
}

test("CR11B-AUTO-000 freezes canonical digest-bound source and owner policy snapshots", () => {
  const fixture = buildReadyFrontierFixtureV1();
  assert.equal(fixture.source.schema, READY_FRONTIER_SOURCE_V1);
  assert.equal(fixture.policy.schema, READY_FRONTIER_POLICY_V1);
  assert.deepEqual(parseReadyFrontierSourceV1(fixture.source), fixture.source);
  assert.deepEqual(parseReadyFrontierPolicyV1(fixture.policy), fixture.policy);
  assert.deepEqual(fixture.source.projects.map((item) => item.projectId), [...fixture.source.projects.map((item) => item.projectId)].sort());
  assert.deepEqual(fixture.policy.projectPolicies.map((item) => item.projectId), [...fixture.policy.projectPolicies.map((item) => item.projectId)].sort());
  assert.equal(fixture.source.retainsRawInputContent, false);
  assert.equal(fixture.source.retainsUsableAccessData, false);
  assert.equal(fixture.policy.permitsAutomaticApproval, false);
  assert.equal(fixture.policy.ownerPolicyVerified, false);
  assert.equal(fixture.policy.permitsReadyTransition, false);
  assert.equal(fixture.policy.permitsDispatchOrExecution, false);
});

test("CR11B-AUTO-000 deterministically proposes real work and promotes a starved candidate first", () => {
  const fixture = buildReadyFrontierFixtureV1(), first = evaluateReadyFrontierV1(fixture, key()), second = evaluateReadyFrontierV1(fixture, key());
  assert.deepEqual(first, second);
  assert.equal(first.schema, READY_FRONTIER_EVALUATION_V1);
  assert.deepEqual(first.proposals.map((item) => item.candidateId), [
    "candidate.wayfarer.starved", "candidate.abs.research", "candidate.content.article",
  ]);
  assert.deepEqual(first.proposals.map((item) => item.rank), [1, 2, 3]);
  assert.deepEqual(first.dispositions.find((item) => item.candidateId === "candidate.wayfarer.starved")?.reasonCodes,
    ["selected", "starvation_bound_reached"]);
});

test("CR11B-AUTO-000 proposals are authenticated owner-review candidates with no operational authority", () => {
  const evaluation = evaluateReadyFrontierV1(buildReadyFrontierFixtureV1(), key());
  for (const proposal of evaluation.proposals) {
    assert.equal(proposal.schema, READY_FRONTIER_PROPOSAL_V1);
    assert.equal(proposal.state, "proposal_only");
    assert.equal(proposal.ownerReviewState, "required_not_requested");
    assert.equal(proposal.ownerPolicyVerified, false);
    assert.equal(proposal.createsCanonicalWork, false);
    assert.equal(proposal.grantsApproval, false);
    assert.equal(proposal.grantsReadyTransition, false);
    assert.equal(proposal.grantsClaimOrLease, false);
    assert.equal(proposal.grantsDispatchOrExecution, false);
    assert.equal(proposal.grantsProviderAccess, false);
    assert.equal(proposal.grantsExternalEffect, false);
    assert.match(proposal.proposalDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(proposal.proposalAuthTag, /^hmac-sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual({ createdCanonicalWork: evaluation.createdCanonicalWork, createdAttempts: evaluation.createdAttempts,
    createdLeases: evaluation.createdLeases, createdDispatches: evaluation.createdDispatches,
    contactedProvider: evaluation.contactedProvider, performedExternalEffect: evaluation.performedExternalEffect }, {
    createdCanonicalWork: false, createdAttempts: false, createdLeases: false, createdDispatches: false,
    contactedProvider: false, performedExternalEffect: false,
  });
  assert.equal(Object.isFrozen(evaluation), true);
  assert.equal(Object.isFrozen(evaluation.proposals), true);
  assert.equal(Object.isFrozen(evaluation.proposals[0]), true);
});

test("CR11B-AUTO-000 preserves blocked, review, duplicate, and policy-deferred truth", () => {
  const evaluation = evaluateReadyFrontierV1(buildReadyFrontierFixtureV1(), key());
  const byId = new Map(evaluation.dispositions.map((item) => [item.candidateId, item]));
  assert.deepEqual([byId.get("candidate.abs.blocked-source")?.outcome, byId.get("candidate.abs.blocked-source")?.reasonCodes],
    ["blocked", ["dependency_unsatisfied"]]);
  assert.deepEqual([byId.get("candidate.content.needs-review")?.outcome, byId.get("candidate.content.needs-review")?.reasonCodes],
    ["needs_review", ["review_pending"]]);
  assert.equal(byId.get("candidate.abs.canonical-duplicate")?.outcome, "duplicate_suppressed");
  assert.equal(byId.get("candidate.wayfarer.duplicate-a")?.outcome, "duplicate_suppressed");
  assert.equal(byId.get("candidate.wayfarer.duplicate-b")?.outcome, "duplicate_suppressed");
  assert.equal(byId.get("candidate.abs.high-risk")?.outcome, "deferred_policy");
  assert.equal(byId.get("candidate.abs.over-cost")?.outcome, "deferred_policy");
  assert.equal(byId.get("candidate.wayfarer.missing-route")?.outcome, "blocked");
  assert.deepEqual({ proposals: evaluation.proposalCount, blocked: evaluation.blockedCount, review: evaluation.needsReviewCount,
    duplicates: evaluation.duplicateSuppressedCount, deferred: evaluation.deferredCount },
  { proposals: 3, blocked: 3, review: 1, duplicates: 3, deferred: 2 });
});

test("CR11B-AUTO-000 suppresses exact canonical intent even after a failed or cancelled record", () => {
  const fixture = buildReadyFrontierFixtureV1(), canonical = fixture.source.canonicalWork[0]!;
  for (const state of ["failed", "cancelled", "rejected"] as const) {
    const source = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source), canonicalWork: [{ ...canonical, state }] });
    const evaluation = evaluateReadyFrontierV1({ ...fixture, source }, key());
    assert.equal(evaluation.dispositions.find((item) => item.candidateId === "candidate.abs.canonical-duplicate")?.outcome,
      "duplicate_suppressed");
  }
});

test("CR11B-AUTO-000 suppresses an intent already present in authenticated frontier history", () => {
  const fixture = buildReadyFrontierFixtureV1(), candidate = fixture.source.candidates.find((item) => item.candidateId === "candidate.abs.research")!;
  const source = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source), historyRevision: 1, priorProposals: [{
    proposalId: "frontier.proposal.prior-abs-research", projectId: candidate.projectId, intentDigest: candidate.intentDigest,
    state: "open", observedAt: "2026-08-30T18:01:00.000Z", evidenceDigest: sha256Digest({ prior: candidate.intentDigest }),
  }] });
  const evaluation = evaluateReadyFrontierV1({ ...fixture, source }, key());
  const disposition = evaluation.dispositions.find((item) => item.candidateId === candidate.candidateId);
  assert.equal(disposition?.outcome, "duplicate_suppressed");
  assert.deepEqual(disposition?.reasonCodes, ["duplicate_prior_proposal_intent"]);
  assert.equal(evaluation.proposals.some((item) => item.candidateId === candidate.candidateId), false);
});

test("CR11B-AUTO-000 enforces global, project, route, outstanding, and cycle-cost ceilings", () => {
  const fixture = buildReadyFrontierFixtureV1();
  const oneGlobal = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), maxProposalsPerCycle: 1 });
  let evaluation = evaluateReadyFrontierV1({ ...fixture, policy: oneGlobal }, key());
  assert.equal(evaluation.proposalCount, 1);
  assert.equal(evaluation.dispositions.filter((item) => item.reasonCodes.includes("cycle_capacity_exhausted")).length, 2);

  const policies = fixture.policy.projectPolicies.map((item) => item.projectId === "project.wayfarer"
    ? { ...item, maxOutstandingProposals: 1 } : item);
  const outstanding = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), projectPolicies: policies });
  evaluation = evaluateReadyFrontierV1({ ...fixture, policy: outstanding }, key());
  assert.equal(evaluation.dispositions.find((item) => item.candidateId === "candidate.wayfarer.starved")?.reasonCodes[0],
    "project_capacity_exhausted");

  const cheapCycle = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), maximumCostMicrousdPerProposal: 500_000,
    maximumCycleCostMicrousd: 500_000 });
  evaluation = evaluateReadyFrontierV1({ ...fixture, policy: cheapCycle }, key());
  assert.equal(evaluation.proposalCount, 2);
  assert.equal(evaluation.dispositions.some((item) => item.reasonCodes.includes("cycle_cost_exhausted")), true);

  const routes = fixture.source.routes.map((item) => item.routeId === "route.repo.agent" ? { ...item, availableProposalSlots: 1 } : item);
  const routeBound = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source), routes });
  evaluation = evaluateReadyFrontierV1({ ...fixture, source: routeBound }, key());
  assert.equal(evaluation.dispositions.some((item) => item.reasonCodes.includes("route_capacity_exhausted")), true);
});

test("CR11B-AUTO-000 rejects stale, future, expired, and cross-tenant truth", () => {
  const fixture = buildReadyFrontierFixtureV1();
  assert.throws(() => evaluateReadyFrontierV1({ ...fixture, evaluatedAt: "2026-08-30T18:10:00.000Z" }, key()), code("scope_mismatch"));
  assert.throws(() => evaluateReadyFrontierV1({ ...fixture, evaluatedAt: "2026-08-30T17:59:59.000Z" }, key()), code("scope_mismatch"));
  const expired = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), expiresAt: "2026-08-30T18:01:00.000Z" });
  assert.throws(() => evaluateReadyFrontierV1({ ...fixture, policy: expired }, key()), code("scope_mismatch"));
  const foreign = buildReadyFrontierPolicyV1({ ...policyInput(fixture.policy), tenantId: "tenant.foreign" });
  assert.throws(() => evaluateReadyFrontierV1({ ...fixture, policy: foreign }, key()), code("scope_mismatch"));
});

test("CR11B-AUTO-000 treats stale route and dependency observations as blockers", () => {
  const fixture = buildReadyFrontierFixtureV1();
  const source = buildReadyFrontierSourceV1({ ...sourceInput(fixture.source),
    routes: fixture.source.routes.map((item) => item.routeId === "route.repo.agent"
      ? { ...item, observedAt: "2026-08-30T17:00:00.000Z" } : item),
    dependencyTruth: fixture.source.dependencyTruth.map((item) => item.candidateId === "dependency.wayfarer.contract"
      ? { ...item, observedAt: "2026-08-30T17:00:00.000Z" } : item) });
  const evaluation = evaluateReadyFrontierV1({ ...fixture, source }, key());
  assert.equal(evaluation.dispositions.find((item) => item.candidateId === "candidate.abs.research")?.reasonCodes.includes("route_stale"), true);
  assert.equal(evaluation.dispositions.find((item) => item.candidateId === "candidate.wayfarer.starved")?.reasonCodes.includes("dependency_stale"), true);
  assert.equal(evaluation.proposals.some((item) => ["candidate.abs.research", "candidate.wayfarer.starved"].includes(item.candidateId)), false);
});

test("CR11B-AUTO-000 rejects source, policy, proposal, and evaluation substitution", () => {
  const fixture = buildReadyFrontierFixtureV1(), evaluation = evaluateReadyFrontierV1(fixture, key());
  assert.throws(() => parseReadyFrontierSourceV1({ ...fixture.source, sourceRevision: 2 }), code("digest_mismatch"));
  assert.throws(() => parseReadyFrontierPolicyV1({ ...fixture.policy, revision: 2 }), code("digest_mismatch"));
  assert.throws(() => parseReadyFrontierEvaluationV1({ ...evaluation, createdCanonicalWork: true }, key()), code("invalid_input"));
  const changedProposal = { ...evaluation.proposals[0]!, title: "Substituted title" };
  assert.throws(() => parseReadyFrontierEvaluationV1({ ...evaluation, proposals: [changedProposal, ...evaluation.proposals.slice(1)] }, key()),
    code("integrity_failed"));
  assert.throws(() => parseReadyFrontierEvaluationV1(evaluation, new Uint8Array(32).fill(0x7a)), code("integrity_failed"));
  const { evaluationDigest: _digest, evaluationAuthTag, ...unsigned } = evaluation; void _digest;
  const redigested = { ...unsigned, sourceRevision: unsigned.sourceRevision + 1 };
  assert.throws(() => parseReadyFrontierEvaluationV1({ ...redigested, evaluationDigest: sha256Digest(redigested), evaluationAuthTag }, key()),
    code("integrity_failed"));
});

test("CR11B-AUTO-000 safe operator projection omits source evidence and every authority-bearing field", () => {
  const projection = projectReadyFrontierOperatorV1(evaluateReadyFrontierV1(buildReadyFrontierFixtureV1(), key()), key());
  const json = JSON.stringify(projection);
  assert.equal((projection.proposals[0] as unknown as Record<string, unknown>).candidateId, undefined);
  assert.equal(json.includes("objective"), false);
  assert.equal(json.includes("evidenceDigest"), false);
  assert.equal(json.includes("proposalAuthTag"), false);
  assert.equal(json.includes("ownerPolicyDigest"), false);
  assert.deepEqual({ approve: projection.canApprove, ready: projection.canReady, claim: projection.canClaimOrLease,
    dispatch: projection.canDispatchOrExecute }, { approve: false, ready: false, claim: false, dispatch: false });
  assert.match(projection.projectionDigest, /^sha256:[a-f0-9]{64}$/);
});

test("CR11B-AUTO-000 exact boundaries reject extra content, accessors, Proxies, and hostile keys without behavior", () => {
  const fixture = buildReadyFrontierFixtureV1();
  assert.throws(() => evaluateReadyFrontierV1({ ...fixture, rawPrompt: "do hidden work" }, key()), code("invalid_input"));
  let getters = 0; const accessor = { ...fixture };
  Object.defineProperty(accessor, "source", { enumerable: true, get() { getters += 1; return fixture.source; } });
  assert.throws(() => evaluateReadyFrontierV1(accessor, key()), code("invalid_input")); assert.equal(getters, 0);
  const proxied = observedProxy(fixture, "throwing");
  assert.throws(() => evaluateReadyFrontierV1(proxied.value, key()), code("invalid_input")); assert.equal(proxied.trapCount(), 0);
  const keyProxy = observedProxy(key(), "throwing");
  assert.throws(() => evaluateReadyFrontierV1(fixture, keyProxy.value), code("integrity_failed")); assert.equal(keyProxy.trapCount(), 0);
});

test("CR11B-AUTO-000 controller has no native, network, provider, job, approval, or execution client", () => {
  const source = readFileSync(new URL("../src/ready-frontier/v1/controller.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:fs", "node:net", "node:http", "node:https", "child_process", "fetch(", "DatabaseSync",
    "CanonicalStore", "ApprovalStore", "LeaseStore", "dispatch(", "execute(", "providerClient"]) assert.equal(source.includes(forbidden), false);
});
