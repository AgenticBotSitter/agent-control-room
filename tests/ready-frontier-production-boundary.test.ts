import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1,
  READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1,
  READY_FRONTIER_ACTIVATION_PACKET_V1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  ReadyFrontierContractErrorV1,
  buildReadyFrontierProductionBoundaryAssessmentV1,
  buildReadyFrontierProductionBoundaryPlanV1,
  buildReadyFrontierProductionDisabledDispositionV1,
  buildReadyFrontierProductionGateRequirementsV1,
  evaluateReadyFrontierProductionReconciliationV1,
  parseReadyFrontierActivationPacketV1,
  parseReadyFrontierProductionBoundaryAssessmentV1,
  parseReadyFrontierProductionBoundaryPlanV1,
  parseReadyFrontierProductionBoundaryProjectionV1,
  parseReadyFrontierProductionDisabledDispositionV1,
  parseReadyFrontierProductionGateRequirementV1,
  parseReadyFrontierProductionReconciliationDecisionV1,
  projectReadyFrontierProductionBoundaryV1,
  readyFrontierRepositoryFixtureActivationPacketKeyV1,
  type ReadyFrontierActivationPacketV1,
} from "../src/ready-frontier/v1/index.ts";
import { hmacSha256Tag, sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const errorCode = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function recomputeDigest(value: Record<string, unknown>, digestField: string,
  excludedFields: string[] = []): string {
  const material = clone(value);
  delete material[digestField];
  for (const field of excludedFields) delete material[field];
  return sha256Digest(material);
}

function activationPacketFixture(key = readyFrontierRepositoryFixtureActivationPacketKeyV1()):
  ReadyFrontierActivationPacketV1 {
  const unsigned = {
    schema: READY_FRONTIER_ACTIVATION_PACKET_V1,
    packetId: "frontier.activation-packet.auto050.0001",
    tenantId: "tenant.owner",
    workspaceId: "workspace.control-room",
    simulationRunId: "frontier.no-relay-run.1",
    simulationRunDigest: sha256Digest({ fixture: "auto050-simulation-run" }),
    acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd" as const,
    acceptedAuto030ReviewSha256:
      "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2" as const,
    requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    state: "blocked_pending_production_proof" as const,
    createdAt: "2026-08-30T20:00:00.000Z",
    repositorySimulationOnly: true as const,
    productionOwnerApprovalPresent: false as const,
    productionPolicyEnrolled: false as const,
    productionConsumerQualified: false as const,
    productionDatabaseQualified: false as const,
    canActivateItself: false as const,
    permitsProtectedMaterial: false as const,
    permitsNetwork: false as const,
    permitsGitHubMutation: false as const,
    permitsAgentOrProviderContact: false as const,
    permitsDispatchOrExecution: false as const,
    permitsExternalEffects: false as const,
  };
  const packetDigest = sha256Digest(unsigned);
  return parseReadyFrontierActivationPacketV1({ ...unsigned, packetDigest,
    packetAuthTag: hmacSha256Tag(key, { packetId: unsigned.packetId,
      simulationRunDigest: unsigned.simulationRunDigest, packetDigest }) }, key);
}

function fixture() {
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
    const packet = activationPacketFixture(key);
    const plan = buildReadyFrontierProductionBoundaryPlanV1({
      planId: "frontier.production-boundary.auto050.0001",
      activationPacket: packet,
      plannedAt: "2026-08-30T20:01:00.000Z",
      expiresAt: "2026-08-30T21:01:00.000Z",
    }, key);
    const assessment = buildReadyFrontierProductionBoundaryAssessmentV1({
      assessmentId: "frontier.production-assessment.auto050.0001",
      plan,
      assessedAt: "2026-08-30T20:02:00.000Z",
    }, key);
    const disposition = buildReadyFrontierProductionDisabledDispositionV1({
      assessment,
      recordedAt: "2026-08-30T20:03:00.000Z",
    }, key);
    const projection = projectReadyFrontierProductionBoundaryV1(assessment, disposition, key);
    return { packet, plan, assessment, disposition, projection };
  } finally { key.fill(0); }
}

test("CR11B-AUTO-050 binds the accepted packet to an exact default-disabled production plan", () => {
  const { packet, plan } = fixture();
  assert.equal(plan.activationPacketDigest, packet.packetDigest);
  assert.equal(plan.acceptedAuto040Commit, READY_FRONTIER_ACCEPTED_AUTO040_COMMIT_V1);
  assert.equal(plan.acceptedAuto040ReviewSha256, READY_FRONTIER_ACCEPTED_AUTO040_REVIEW_SHA256_V1);
  assert.deepEqual(plan.requiredProductionGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
  assert.deepEqual({ disabled: plan.defaultDisabled, configuration: plan.productionConfigurationPresent,
    consumer: plan.consumerImplemented, policy: plan.policyEnrolled, authorized: plan.activationAuthorized,
    protectedReferences: plan.permitsProtectedReferenceResolution, network: plan.permitsNetwork,
    contact: plan.permitsAgentOrProviderContact, claims: plan.permitsClaimOrLease,
    execution: plan.permitsDispatchOrExecution, effects: plan.permitsExternalEffects }, {
    disabled: true, configuration: false, consumer: false, policy: false, authorized: false,
    protectedReferences: false, network: false, contact: false, claims: false, execution: false, effects: false,
  });
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try { assert.deepEqual(parseReadyFrontierProductionBoundaryPlanV1(plan, key), plan); }
  finally { key.fill(0); }
});

test("CR11B-AUTO-050 turns all nine production blockers into immutable proof requirements", () => {
  const requirements = buildReadyFrontierProductionGateRequirementsV1();
  assert.equal(requirements.length, 9);
  assert.deepEqual(requirements.map((item) => item.gateCode), [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
  assert.equal(new Set(requirements.map((item) => item.evidenceClass)).size, 9);
  assert.equal(new Set(requirements.map((item) => item.proofAuthority)).size, 9);
  for (const requirement of requirements) {
    assert.equal(requirement.status, "unobserved");
    assert.equal(requirement.evidenceDigest, null);
    assert.equal(requirement.repositoryCanSatisfy, false);
    assert.equal(requirement.grantsApproval, false);
    assert.equal(requirement.grantsActivationAuthority, false);
    assert.equal(requirement.grantsDispatchOrExecution, false);
    assert.equal(requirement.grantsExternalEffects, false);
    assert.deepEqual(parseReadyFrontierProductionGateRequirementV1(requirement), requirement);
  }
});

test("CR11B-AUTO-050 assessment and disposition remain blocked before consumer construction", () => {
  const { assessment, disposition, projection } = fixture();
  assert.deepEqual({ state: assessment.state, blockers: assessment.blockingGateCodes,
    remaining: assessment.remainingProofCount, owner: assessment.eligibleForOwnerApproval,
    activation: assessment.eligibleForActivation }, {
    state: "blocked_design_only", blockers: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    remaining: 9, owner: false, activation: false,
  });
  assert.deepEqual({ status: disposition.status, config: disposition.productionConfigurationRead,
    database: disposition.databaseContacted, protectedReferences: disposition.protectedReferenceResolutionAttempted,
    consumer: disposition.consumerConstructed, handoff: disposition.handoffConsumed,
    contact: disposition.agentOrProviderContacted, network: disposition.networkContacted,
    deploy: disposition.deploymentAttempted, effect: disposition.externalEffectOccurred }, {
    status: "disabled_before_consumer_construction", config: false, database: false, protectedReferences: false,
    consumer: false, handoff: false, contact: false, network: false, deploy: false, effect: false,
  });
  assert.equal(projection.canActivateProduction, false);
  assert.equal(projection.canConstructConsumer, false);
  assert.equal(projection.canResolveProtectedReferences, false);
  assert.equal(projection.canContactNetwork, false);
  assert.equal(projection.canClaimOrLease, false);
  assert.equal(projection.canDispatchOrExecute, false);
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try { assert.deepEqual(parseReadyFrontierProductionBoundaryAssessmentV1(assessment, key), assessment); }
  finally { key.fill(0); }
  assert.deepEqual(parseReadyFrontierProductionDisabledDispositionV1(disposition), disposition);
  assert.deepEqual(parseReadyFrontierProductionBoundaryProjectionV1(projection), projection);
});

test("CR11B-AUTO-050 cannot convert caller-declared qualified evidence into readiness", () => {
  const { assessment } = fixture();
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
  const forged = clone(assessment);
  Object.assign(forged.requirements[0]!, { status: "qualified", evidenceDigest: sha256Digest({ forged: true }),
    repositoryCanSatisfy: true });
  assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(forged, key), errorCode("invalid_input"));
  const dropped = clone(assessment); dropped.requirements.pop();
  assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(dropped, key), errorCode("invalid_input"));
  const reordered = clone(assessment); reordered.requirements.reverse();
  assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(reordered, key), errorCode("digest_mismatch"));
  } finally { key.fill(0); }
});

test("CR11B-AUTO-050 rejects packet, plan, assessment, and projection drift", () => {
  const { plan, assessment, disposition, projection } = fixture();
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
  const planDrift = clone(plan); planDrift.consumerImplemented = true as false;
  assert.throws(() => parseReadyFrontierProductionBoundaryPlanV1(planDrift, key), errorCode("invalid_input"));
  const assessmentDrift = clone(assessment); assessmentDrift.blockingGateCodes.pop();
  assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(assessmentDrift, key), errorCode("invalid_input"));
  const dispositionDrift = clone(disposition); dispositionDrift.databaseContacted = true as false;
  assert.throws(() => parseReadyFrontierProductionDisabledDispositionV1(dispositionDrift), errorCode("invalid_input"));
  const projectionDrift = clone(projection); projectionDrift.planId = "frontier.production-boundary.alias";
  assert.throws(() => parseReadyFrontierProductionBoundaryProjectionV1(projectionDrift), errorCode("digest_mismatch"));
  } finally { key.fill(0); }
});

test("CR11B-AUTO-050 rejects wrong packet keys, chronology drift, accessors, and Proxies without callbacks", () => {
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
    const packet = activationPacketFixture(key);
    const wrong = new Uint8Array(32).fill(0x99);
    assert.throws(() => buildReadyFrontierProductionBoundaryPlanV1({
      planId: "frontier.production-boundary.wrong-key", activationPacket: packet,
      plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:01:00.000Z",
    }, wrong), errorCode("digest_mismatch"));
    wrong.fill(0);
    assert.throws(() => buildReadyFrontierProductionBoundaryPlanV1({
      planId: "frontier.production-boundary.early", activationPacket: packet,
      plannedAt: "2026-08-30T19:59:00.000Z", expiresAt: "2026-08-30T21:01:00.000Z",
    }, key), errorCode("policy_denied"));
    assert.throws(() => buildReadyFrontierProductionBoundaryPlanV1({
      planId: "frontier.production-boundary.too-long", activationPacket: packet,
      plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:01:00.001Z",
    }, key), errorCode("policy_denied"));
    let accesses = 0;
    const accessor: Record<string, unknown> = { planId: "frontier.production-boundary.accessor",
      plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:01:00.000Z" };
    Object.defineProperty(accessor, "activationPacket", { enumerable: true,
      get: () => { accesses += 1; return packet; } });
    assert.throws(() => buildReadyFrontierProductionBoundaryPlanV1(accessor, key), errorCode("invalid_input"));
    assert.equal(accesses, 0);
    const proxied = observedProxy({ planId: "frontier.production-boundary.proxy", activationPacket: packet,
      plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:01:00.000Z" }, "throwing");
    assert.throws(() => buildReadyFrontierProductionBoundaryPlanV1(proxied.value, key), errorCode("invalid_input"));
    assert.equal(proxied.trapCount(), 0);
  } finally { key.fill(0); }
});

test("CR11B-AUTO-050 rejects re-digested plan provenance and assessment chronology", () => {
  const { plan, assessment } = fixture();
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
    const shifted = clone(plan) as unknown as Record<string, unknown>;
    shifted.plannedAt = "2025-01-01T00:00:00.000Z";
    shifted.expiresAt = "2025-01-01T01:00:00.000Z";
    shifted.planDigest = recomputeDigest(shifted, "planDigest", ["planAuthTag"]);
    assert.throws(() => parseReadyFrontierProductionBoundaryPlanV1(shifted, key),
      errorCode("digest_mismatch"));

    for (const [field, replacement] of [
      ["activationPacketId", "frontier.activation-packet.alias"],
      ["activationPacketDigest", sha256Digest({ packet: "alias" })],
      ["simulationRunId", "frontier.no-relay-run.alias"],
      ["simulationRunDigest", sha256Digest({ run: "alias" })],
    ] as const) {
      const substituted = clone(plan) as unknown as Record<string, unknown>;
      substituted[field] = replacement;
      substituted.planDigest = recomputeDigest(substituted, "planDigest", ["planAuthTag"]);
      assert.throws(() => parseReadyFrontierProductionBoundaryPlanV1(substituted, key),
        errorCode("digest_mismatch"), field);
    }

    for (const assessedAt of ["2026-08-30T20:00:59.999Z", "2026-08-30T21:01:00.000Z"]) {
      const outsideWindow = clone(assessment) as unknown as Record<string, unknown>;
      outsideWindow.assessedAt = assessedAt;
      outsideWindow.assessmentDigest = recomputeDigest(outsideWindow, "assessmentDigest");
      assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(outsideWindow, key),
        errorCode("digest_mismatch"));
    }

    for (const [field, replacement] of [
      ["planId", "frontier.production-boundary.alias"],
      ["planDigest", sha256Digest({ plan: "alias" })],
      ["tenantId", "tenant.alias"],
      ["workspaceId", "workspace.alias"],
      ["activationPacketId", "frontier.activation-packet.alias"],
      ["activationPacketDigest", sha256Digest({ packet: "alias" })],
      ["activationPacketCreatedAt", "2026-08-30T19:59:00.000Z"],
      ["simulationRunId", "frontier.no-relay-run.alias"],
      ["simulationRunDigest", sha256Digest({ run: "alias" })],
      ["plannedAt", "2026-08-30T20:00:30.000Z"],
      ["planExpiresAt", "2026-08-30T20:30:00.000Z"],
      ["planAuthTag", `hmac-sha256:${"0".repeat(64)}`],
    ] as const) {
      const substituted = clone(assessment) as unknown as Record<string, unknown>;
      substituted[field] = replacement;
      substituted.assessmentDigest = recomputeDigest(substituted, "assessmentDigest");
      assert.throws(() => parseReadyFrontierProductionBoundaryAssessmentV1(substituted, key),
        ReadyFrontierContractErrorV1, field);
    }
  } finally { key.fill(0); }
});

test("CR11B-AUTO-050 rejects every re-digested cross-artifact disposition substitution", () => {
  const { assessment, disposition } = fixture();
  const key = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  try {
    for (const [field, replacement] of [
      ["planId", "frontier.production-boundary.alias"],
      ["planDigest", sha256Digest({ plan: "alias" })],
      ["assessmentId", "frontier.production-assessment.alias"],
      ["assessmentDigest", sha256Digest({ assessment: "alias" })],
      ["tenantId", "tenant.alias"],
      ["workspaceId", "workspace.alias"],
      ["recordedAt", "2026-08-30T20:01:59.999Z"],
    ] as const) {
      const substituted = clone(disposition) as unknown as Record<string, unknown>;
      substituted[field] = replacement;
      if (field === "assessmentDigest") {
        substituted.dispositionId = `frontier.production-disabled.${replacement.slice(7, 31)}`;
      }
      substituted.dispositionDigest = recomputeDigest(substituted, "dispositionDigest");
      assert.throws(() => projectReadyFrontierProductionBoundaryV1(assessment, substituted, key),
        errorCode("scope_mismatch"), field);
    }

    const aliasedId = clone(disposition) as unknown as Record<string, unknown>;
    aliasedId.dispositionId = "frontier.production-disabled.alias";
    aliasedId.dispositionDigest = recomputeDigest(aliasedId, "dispositionDigest");
    assert.throws(() => parseReadyFrontierProductionDisabledDispositionV1(aliasedId),
      errorCode("digest_mismatch"));
  } finally { key.fill(0); }
});

test("CR11B-AUTO-050 reconciliation makes every post-marker unknown terminally non-retriable", () => {
  const marker = evaluateReadyFrontierProductionReconciliationV1("claimed", "delivery_marker_written");
  const unknown = evaluateReadyFrontierProductionReconciliationV1("delivery_started", "post_marker_unknown");
  const firstAbsence = evaluateReadyFrontierProductionReconciliationV1("delivery_started",
    "qualified_destination_absence_observed");
  const absence = evaluateReadyFrontierProductionReconciliationV1("ambiguous",
    "independent_destination_absence_confirmed");
  const confirmed = evaluateReadyFrontierProductionReconciliationV1("ambiguous", "qualified_destination_confirmed");
  assert.equal(marker.toState, "delivery_started");
  assert.equal(unknown.toState, "ambiguous");
  assert.equal(unknown.requiresNewOwnerAuthorizedActionBeforeRetry, true);
  assert.equal(firstAbsence.toState, "ambiguous");
  assert.equal(firstAbsence.requiresQualifiedDestinationEvidence, true);
  assert.equal(absence.toState, "reconciled_not_delivered");
  assert.equal(absence.requiresQualifiedDestinationEvidence, true);
  assert.equal(absence.requiresNewOwnerAuthorizedActionBeforeRetry, true);
  assert.equal(confirmed.toState, "confirmed");
  for (const decision of [marker, unknown, firstAbsence, absence, confirmed]) {
    assert.equal(decision.automaticRetryAllowed, false);
    assert.equal(decision.performsConsumerAction, false);
    assert.equal(decision.contactsDestination, false);
    assert.equal(decision.grantsClaimOrLease, false);
    assert.equal(decision.grantsDispatchOrExecution, false);
    assert.equal(decision.grantsExternalEffects, false);
    assert.deepEqual(parseReadyFrontierProductionReconciliationDecisionV1(decision), decision);
  }
});

test("CR11B-AUTO-050 reconciliation rejects impossible and terminal-state transitions", () => {
  const beforeMarker = evaluateReadyFrontierProductionReconciliationV1("claimed", "post_marker_unknown");
  const terminal = evaluateReadyFrontierProductionReconciliationV1("confirmed", "claim_acquired");
  assert.deepEqual({ permitted: beforeMarker.permittedByStateMachine, to: beforeMarker.toState,
    transaction: beforeMarker.requiresProtectedDatabaseTransaction }, { permitted: false, to: null, transaction: false });
  assert.deepEqual({ permitted: terminal.permittedByStateMachine, to: terminal.toState,
    retry: terminal.automaticRetryAllowed }, { permitted: false, to: null, retry: false });
});

test("CR11B-AUTO-050 safe projection rejects added protected or credential-shaped material", () => {
  const { projection } = fixture();
  const added = { ...projection, credentialReference: "credential:production:unsafe" };
  assert.throws(() => parseReadyFrontierProductionBoundaryProjectionV1(added), errorCode("invalid_input"));
  const secret = clone(projection) as unknown as Record<string, unknown>;
  secret.safeReason = "Bearer abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => parseReadyFrontierProductionBoundaryProjectionV1(secret), ReadyFrontierContractErrorV1);
});

test("CR11B-AUTO-050 implementation contains no runtime consumer, network, process, or persistence client", () => {
  const source = readFileSync(new URL("../src/ready-frontier/v1/production-boundary.ts", import.meta.url), "utf8");
  for (const forbidden of [
    /from ["']postgres["']/,
    /from ["']node:(?:child_process|net|http|https|tls|dns|fs)["']/,
    /\bfetch\s*\(/,
    /\.query\s*\(/,
    /\.exec\s*\(/,
    /\.connect\s*\(/,
    /\.deliver\s*\(/,
    /\.dispatch\s*\(/,
  ]) assert.doesNotMatch(source, forbidden);
});
