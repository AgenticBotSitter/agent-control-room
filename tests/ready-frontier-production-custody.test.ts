import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  READY_FRONTIER_ACTIVATION_PACKET_V1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  ReadyFrontierContractErrorV1,
  buildReadyFrontierProductionBoundaryAssessmentV1,
  buildReadyFrontierProductionBoundaryPlanV1,
  buildReadyFrontierProductionCustodyPlanV1,
  parseReadyFrontierActivationPacketV1,
  parseReadyFrontierProductionCustodyPlanV1,
  parseReadyFrontierProductionCustodyReportV1,
  projectReadyFrontierProductionCustodyReportV1,
  readyFrontierProductionCustodyFaultCodesV1,
  readyFrontierProductionCustodyScenarioCodesV1,
  readyFrontierRepositoryFixtureActivationPacketKeyV1,
  runReadyFrontierProductionCustodyFakeQualificationV1,
  type ReadyFrontierActivationPacketV1,
  type ReadyFrontierProductionBoundaryAssessmentV1,
  type ReadyFrontierProductionCustodyFaultCodeV1,
  type ReadyFrontierProductionCustodyPlanV1,
  type ReadyFrontierProductionCustodyReportV1,
} from "../src/ready-frontier/v1/index.ts";
import { hmacSha256Tag, sha256Digest } from "../src/security/index.ts";

const errorCode = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value }; delete copy[field]; return copy;
}

function activationPacketFixture(key: Uint8Array): ReadyFrontierActivationPacketV1 {
  const unsigned = {
    schema: READY_FRONTIER_ACTIVATION_PACKET_V1,
    packetId: "frontier.activation-packet.auto070.0001", tenantId: "tenant.owner",
    workspaceId: "workspace.control-room", simulationRunId: "frontier.no-relay-run.auto070.1",
    simulationRunDigest: sha256Digest({ fixture: "auto070-simulation-run" }),
    acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd" as const,
    acceptedAuto030ReviewSha256:
      "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2" as const,
    requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    state: "blocked_pending_production_proof" as const, createdAt: "2026-08-30T20:00:00.000Z",
    repositorySimulationOnly: true as const, productionOwnerApprovalPresent: false as const,
    productionPolicyEnrolled: false as const, productionConsumerQualified: false as const,
    productionDatabaseQualified: false as const, canActivateItself: false as const,
    permitsProtectedMaterial: false as const, permitsNetwork: false as const,
    permitsGitHubMutation: false as const, permitsAgentOrProviderContact: false as const,
    permitsDispatchOrExecution: false as const, permitsExternalEffects: false as const,
  };
  const packetDigest = sha256Digest(unsigned);
  return parseReadyFrontierActivationPacketV1({ ...unsigned, packetDigest,
    packetAuthTag: hmacSha256Tag(key, { packetId: unsigned.packetId,
      simulationRunDigest: unsigned.simulationRunDigest, packetDigest }) }, key);
}

interface Fixture {
  activationKey: Uint8Array;
  qualificationKey: Uint8Array;
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  plan: ReadyFrontierProductionCustodyPlanV1;
  report: ReadyFrontierProductionCustodyReportV1;
}
function fixture(): Fixture {
  const activationKey = readyFrontierRepositoryFixtureActivationPacketKeyV1();
  const qualificationKey = new Uint8Array(32).fill(70);
  const packet = activationPacketFixture(activationKey);
  const boundaryPlan = buildReadyFrontierProductionBoundaryPlanV1({
    planId: "frontier.production-boundary.auto070.0001", activationPacket: packet,
    plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:00:00.000Z",
  }, activationKey);
  const assessment = buildReadyFrontierProductionBoundaryAssessmentV1({
    assessmentId: "frontier.production-assessment.auto070.0001", plan: boundaryPlan,
    assessedAt: "2026-08-30T20:02:00.000Z",
  }, activationKey);
  const plan = buildReadyFrontierProductionCustodyPlanV1({
    planId: "frontier.production-custody.auto070.0001", assessment,
    plannedAt: "2026-08-30T20:03:00.000Z", expiresAt: "2026-08-30T20:59:00.000Z",
  }, activationKey, qualificationKey);
  const report = runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.auto070.0001", plan,
    startedAt: "2026-08-30T20:04:00.000Z", completedAt: "2026-08-30T20:05:00.000Z",
  }, activationKey, qualificationKey);
  return { activationKey, qualificationKey, assessment, plan, report };
}

test("CR11B-AUTO-070 binds the accepted proof ingress to a default-disabled custody plan", () => {
  const f = fixture();
  assert.equal(f.plan.productionBoundaryAssessmentDigest, f.assessment.assessmentDigest);
  assert.deepEqual(f.plan.scenarioCodes, [...readyFrontierProductionCustodyScenarioCodesV1]);
  assert.deepEqual(f.plan.requiredProductionGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
  assert.equal(f.plan.processCount, 3);
  assert.equal(new Set(f.plan.processIds).size, 3);
  assert.equal(new Set(f.plan.serviceRoles.map((item) => item.keyIdentityDigest)).size, 3);
  assert.equal(new Set(f.plan.serviceRoles.map((item) => item.independenceDomainDigest)).size, 3);
  assert.equal(f.plan.liveQualificationAuthorized, false);
  assert.equal(f.plan.hostedDatabaseContactAuthorized, false);
  assert.equal(f.plan.permitsExternalEffects, false);
  assert.ok(Object.isFrozen(f.plan));
  assert.ok(Object.isFrozen(f.plan.productionBoundaryAssessment));
});

test("CR11B-AUTO-070 runs eight deterministic fake scenarios without qualifying production", () => {
  const f = fixture();
  assert.equal(f.report.status, "simulated_pass");
  assert.equal(f.report.simulatedPassCount, 8);
  assert.equal(f.report.simulatedFailureCount, 0);
  assert.equal(new Set(f.report.scenarioResults.map((item) => item.evidenceDigest)).size, 8);
  assert.deepEqual(f.report.blockingGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
  assert.equal(f.report.qualifiedProofCount, 0);
  assert.equal(f.report.remainingQualifiedProofCount, 9);
  assert.equal(f.report.liveQualificationPerformed, false);
  assert.equal(f.report.productionDatabaseContacted, false);
  assert.equal(f.report.grantsActivationAuthority, false);
  assert.equal(f.report.externalEffectOccurred, false);
  const replay = runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: f.report.runId, plan: f.plan, startedAt: f.report.startedAt, completedAt: f.report.completedAt,
  }, f.activationKey, f.qualificationKey);
  assert.deepEqual(replay, f.report);
});

test("CR11B-AUTO-070 turns every modeled custody failure into a blocked simulated failure", () => {
  const f = fixture();
  const faults = readyFrontierProductionCustodyFaultCodesV1.filter((fault) => fault !== "none");
  assert.equal(faults.length, 8);
  for (const fault of faults) {
    const report = runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: `frontier.production-custody-run.${fault}`, plan: f.plan,
      startedAt: "2026-08-30T20:06:00.000Z", completedAt: "2026-08-30T20:07:00.000Z",
      injectedFault: fault as ReadyFrontierProductionCustodyFaultCodeV1,
    }, f.activationKey, f.qualificationKey);
    assert.equal(report.status, "simulated_failure", fault);
    assert.equal(report.simulatedFailureCount, 1, fault);
    assert.equal(report.qualifiedProofCount, 0, fault);
    assert.equal(report.grantsExternalEffects, false, fault);
  }
});

test("CR11B-AUTO-070 rejects plan drift even when a fixture caller recomputes public identity and HMAC", () => {
  const f = fixture();
  const changed = clone(f.plan);
  changed.serviceRoles[1]!.keyIdentityDigest = changed.serviceRoles[0]!.keyIdentityDigest;
  const unsigned = without(without(changed as unknown as Record<string, unknown>, "planAuthTag"), "planDigest");
  changed.planDigest = sha256Digest(unsigned);
  changed.planAuthTag = hmacSha256Tag(f.qualificationKey, { planId: changed.planId,
    planDigest: changed.planDigest, tenantId: changed.tenantId, workspaceId: changed.workspaceId,
    productionBoundaryAssessmentDigest: changed.productionBoundaryAssessmentDigest,
    plannedAt: changed.plannedAt, expiresAt: changed.expiresAt });
  assert.throws(() => parseReadyFrontierProductionCustodyPlanV1(changed, f.activationKey, f.qualificationKey),
    errorCode("digest_mismatch"));

  const sourceDrift = clone(f.plan);
  sourceDrift.productionBoundaryAssessment.assessmentId = "frontier.production-assessment.changed";
  assert.throws(() => parseReadyFrontierProductionCustodyPlanV1(sourceDrift, f.activationKey, f.qualificationKey),
    errorCode("digest_mismatch"));
});

test("CR11B-AUTO-070 re-derives fake evidence and rejects rewritten reports", () => {
  const f = fixture();
  const changed = clone(f.report);
  changed.scenarioResults[0]!.status = "simulated_failure";
  changed.scenarioResults[0]!.safeFindingCode = "service_identity_alias";
  changed.simulatedPassCount = 7; changed.simulatedFailureCount = 1; changed.status = "simulated_failure";
  const unsigned = without(without(changed as unknown as Record<string, unknown>, "reportAuthTag"), "reportDigest");
  changed.reportDigest = sha256Digest(unsigned);
  changed.reportAuthTag = hmacSha256Tag(f.qualificationKey, { reportId: changed.reportId,
    reportDigest: changed.reportDigest, runId: changed.runId, planId: changed.planId,
    planDigest: changed.planDigest, tenantId: changed.tenantId, workspaceId: changed.workspaceId,
    startedAt: changed.startedAt, completedAt: changed.completedAt });
  assert.throws(() => parseReadyFrontierProductionCustodyReportV1(changed, f.plan,
    f.activationKey, f.qualificationKey), errorCode("digest_mismatch"));
});

test("CR11B-AUTO-070 rejects wrong keys, cross-plan reports, reordered scenarios, and added fields", () => {
  const f = fixture(), wrongKey = new Uint8Array(32).fill(71);
  assert.throws(() => parseReadyFrontierProductionCustodyPlanV1(f.plan, f.activationKey, wrongKey),
    errorCode("digest_mismatch"));
  const otherPlan = buildReadyFrontierProductionCustodyPlanV1({
    planId: "frontier.production-custody.auto070.other", assessment: f.assessment,
    plannedAt: "2026-08-30T20:03:00.000Z", expiresAt: "2026-08-30T20:59:00.000Z",
  }, f.activationKey, f.qualificationKey);
  assert.throws(() => parseReadyFrontierProductionCustodyReportV1(f.report, otherPlan,
    f.activationKey, f.qualificationKey), errorCode("digest_mismatch"));

  const reordered = clone(f.plan);
  [reordered.scenarioCodes[0], reordered.scenarioCodes[1]] =
    [reordered.scenarioCodes[1]!, reordered.scenarioCodes[0]!];
  const unsigned = without(without(reordered as unknown as Record<string, unknown>, "planAuthTag"), "planDigest");
  reordered.planDigest = sha256Digest(unsigned);
  reordered.planAuthTag = hmacSha256Tag(f.qualificationKey, { planId: reordered.planId,
    planDigest: reordered.planDigest, tenantId: reordered.tenantId, workspaceId: reordered.workspaceId,
    productionBoundaryAssessmentDigest: reordered.productionBoundaryAssessmentDigest,
    plannedAt: reordered.plannedAt, expiresAt: reordered.expiresAt });
  assert.throws(() => parseReadyFrontierProductionCustodyPlanV1(reordered,
    f.activationKey, f.qualificationKey), errorCode("digest_mismatch"));
  assert.throws(() => parseReadyFrontierProductionCustodyReportV1({ ...f.report, credential: "forbidden" },
    f.plan, f.activationKey, f.qualificationKey), errorCode("invalid_input"));
});

test("CR11B-AUTO-070 enforces source, plan, run, and completion chronology", () => {
  const f = fixture();
  assert.throws(() => buildReadyFrontierProductionCustodyPlanV1({
    planId: "frontier.production-custody.before-assessment", assessment: f.assessment,
    plannedAt: "2026-08-30T20:01:59.000Z", expiresAt: "2026-08-30T20:59:00.000Z",
  }, f.activationKey, f.qualificationKey), errorCode("policy_denied"));
  assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.before-plan", plan: f.plan,
    startedAt: "2026-08-30T20:02:59.000Z", completedAt: "2026-08-30T20:05:00.000Z",
  }, f.activationKey, f.qualificationKey), errorCode("policy_denied"));
  assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.reverse", plan: f.plan,
    startedAt: "2026-08-30T20:05:00.000Z", completedAt: "2026-08-30T20:04:59.000Z",
  }, f.activationKey, f.qualificationKey), errorCode("policy_denied"));
  assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: "frontier.production-custody-run.expired", plan: f.plan,
    startedAt: "2026-08-30T20:58:00.000Z", completedAt: "2026-08-30T20:59:00.000Z",
  }, f.activationKey, f.qualificationKey), errorCode("policy_denied"));
});

test("CR11B-AUTO-070 rejects accessors and Proxies without executing caller behavior", () => {
  const f = fixture(); let accessorCalls = 0, proxyCalls = 0;
  const accessor = { planId: "frontier.production-custody.accessor", assessment: f.assessment,
    plannedAt: "2026-08-30T20:03:00.000Z", get expiresAt() { accessorCalls += 1;
      return "2026-08-30T20:59:00.000Z"; } };
  assert.throws(() => buildReadyFrontierProductionCustodyPlanV1(accessor,
    f.activationKey, f.qualificationKey), errorCode("invalid_input"));
  assert.equal(accessorCalls, 0);
  const proxy = new Proxy({ runId: "frontier.production-custody.proxy", plan: f.plan,
    startedAt: "2026-08-30T20:04:00.000Z", completedAt: "2026-08-30T20:05:00.000Z" }, {
    get(target, property, receiver) { proxyCalls += 1; return Reflect.get(target, property, receiver); },
    ownKeys(target) { proxyCalls += 1; return Reflect.ownKeys(target); },
  });
  assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1(proxy,
    f.activationKey, f.qualificationKey), errorCode("invalid_input"));
  assert.equal(proxyCalls, 0);
});

test("CR11B-AUTO-070 captured freeze and private duplicate logic ignore post-load shared-helper drift", () => {
  const f = fixture();
  const defineProperty = Object.defineProperty;
  const freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze")!;
  const valuesDescriptor = Object.getOwnPropertyDescriptor(Object, "values")!;
  const isFrozenDescriptor = Object.getOwnPropertyDescriptor(Object, "isFrozen")!;
  const setAddDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, "add")!;
  const originalIsFrozen = Object.isFrozen;
  const originalSetAdd = Set.prototype.add;
  let rewrittenDigestAdds = 0;
  let driftReport: ReadyFrontierProductionCustodyReportV1 | undefined;
  let driftPlan: ReadyFrontierProductionCustodyPlanV1 | undefined;
  try {
    defineProperty(Object, "freeze", { ...freezeDescriptor, value: <T>(value: T) => value });
    defineProperty(Object, "values", { ...valuesDescriptor, value: () => [] });
    defineProperty(Object, "isFrozen", { ...isFrozenDescriptor, value: () => false });
    defineProperty(Set.prototype, "add", { ...setAddDescriptor,
      value(this: Set<unknown>, value: unknown) {
        if (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)) {
          rewrittenDigestAdds += 1;
          return originalSetAdd.call(this, `${value}:${rewrittenDigestAdds}`);
        }
        return originalSetAdd.call(this, value);
      } });
    driftPlan = buildReadyFrontierProductionCustodyPlanV1({
      planId: "frontier.production-custody.shared-helper-drift", assessment: f.assessment,
      plannedAt: "2026-08-30T20:03:00.000Z", expiresAt: "2026-08-30T20:59:00.000Z",
    }, f.activationKey, f.qualificationKey);
    assert.equal(originalIsFrozen(driftPlan), true);
    assert.equal(originalIsFrozen(driftPlan.serviceRoles), true);
    assert.equal(originalIsFrozen(driftPlan.productionBoundaryAssessment), true);
    driftReport = runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: "frontier.production-custody-run.shared-helper-drift", plan: driftPlan,
      startedAt: "2026-08-30T20:04:00.000Z", completedAt: "2026-08-30T20:05:00.000Z",
      injectedFault: "service_identity_alias",
    }, f.activationKey, f.qualificationKey);
    assert.equal(driftReport.status, "simulated_failure");
    assert.equal(driftReport.simulatedFailureCount, 1);
    assert.equal(driftReport.scenarioResults[0]!.status, "simulated_failure");
    assert.equal(originalIsFrozen(driftReport), true);
    const projection = projectReadyFrontierProductionCustodyReportV1(driftReport, driftPlan,
      f.activationKey, f.qualificationKey);
    assert.equal(originalIsFrozen(projection), true);
    assert.equal(projection.canActivateProduction, false);
  } finally {
    defineProperty(Object, "freeze", freezeDescriptor);
    defineProperty(Object, "values", valuesDescriptor);
    defineProperty(Object, "isFrozen", isFrozenDescriptor);
    defineProperty(Set.prototype, "add", setAddDescriptor);
  }
  assert.ok(driftPlan); assert.ok(driftReport);
  assert.deepEqual(parseReadyFrontierProductionCustodyReportV1(driftReport, driftPlan,
    f.activationKey, f.qualificationKey), driftReport);
});

test("CR11B-AUTO-070 inherited numeric Array setters cannot change any authenticated fault result", () => {
  const f = fixture(), defineProperty = Object.defineProperty;
  const numericDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "1");
  const faults = readyFrontierProductionCustodyFaultCodesV1.filter((fault) => fault !== "none");
  const originalIsFrozen = Object.isFrozen;
  let digestRewriteCount = 0;
  let allFaultsFailedOnce = true, allArtifactsFrozen = true, allAuthorityNegative = true;
  let aliasReport: ReadyFrontierProductionCustodyReportV1 | undefined;
  const rewriteDigest = (value: string): string => {
    digestRewriteCount += 1;
    const replacement = (digestRewriteCount % 16).toString(16);
    return `${value.slice(0, -1)}${replacement}`;
  };
  try {
    defineProperty(Array.prototype, "1", { configurable: true,
      set(this: unknown[], value: unknown) {
        if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
          defineProperty(this, "1", { configurable: true, enumerable: true, writable: true, value });
          return;
        }
        let stored = rewriteDigest(value);
        defineProperty(this, "1", { configurable: true, enumerable: true,
          get: () => stored,
          set: (next: unknown) => { stored = typeof next === "string"
            && /^sha256:[a-f0-9]{64}$/.test(next) ? rewriteDigest(next) : String(next); } });
      } });
    for (const fault of faults) {
      const report = runReadyFrontierProductionCustodyFakeQualificationV1({
        runId: `frontier.production-custody-run.numeric-setter.${fault}`, plan: f.plan,
        startedAt: "2026-08-30T20:06:00.000Z", completedAt: "2026-08-30T20:07:00.000Z",
        injectedFault: fault,
      }, f.activationKey, f.qualificationKey);
      const projection = projectReadyFrontierProductionCustodyReportV1(report, f.plan,
        f.activationKey, f.qualificationKey);
      allFaultsFailedOnce = allFaultsFailedOnce && report.status === "simulated_failure"
        && report.simulatedPassCount === 7 && report.simulatedFailureCount === 1;
      allArtifactsFrozen = allArtifactsFrozen && originalIsFrozen(report)
        && originalIsFrozen(report.scenarioResults) && originalIsFrozen(projection)
        && originalIsFrozen(projection.scenarioStatuses);
      allAuthorityNegative = allAuthorityNegative && report.blockingGateCodes.length === 9
        && report.qualifiedProofCount === 0 && !report.grantsExternalEffects
        && !projection.canActivateProduction && !projection.canDispatchOrExecute;
      if (fault === "service_identity_alias") aliasReport = report;
    }
  } finally {
    if (numericDescriptor) defineProperty(Array.prototype, "1", numericDescriptor);
    else delete (Array.prototype as unknown as Record<string, unknown>)["1"];
  }
  assert.equal(allFaultsFailedOnce, true);
  assert.equal(allArtifactsFrozen, true);
  assert.equal(allAuthorityNegative, true);
  assert.ok(aliasReport);
  assert.equal(aliasReport.scenarioResults[0]!.status, "simulated_failure");
  assert.deepEqual(parseReadyFrontierProductionCustodyReportV1(aliasReport, f.plan,
    f.activationKey, f.qualificationKey), aliasReport);
});

test("CR11B-AUTO-070 captures Date instance methods and denies invalid, equal, and reversed chronology", () => {
  const f = fixture(), defineProperty = Object.defineProperty;
  const getTimeDescriptor = Object.getOwnPropertyDescriptor(Date.prototype, "getTime")!;
  const toISOStringDescriptor = Object.getOwnPropertyDescriptor(Date.prototype, "toISOString")!;
  const invalidInstant = "2026-13-01T20:03:00.000Z";
  try {
    defineProperty(Date.prototype, "getTime", { ...getTimeDescriptor, value: () => 0 });
    defineProperty(Date.prototype, "toISOString", { ...toISOStringDescriptor, value: () => invalidInstant });
    assert.throws(() => buildReadyFrontierProductionCustodyPlanV1({
      planId: "frontier.production-custody.invalid-date", assessment: f.assessment,
      plannedAt: invalidInstant, expiresAt: invalidInstant,
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => buildReadyFrontierProductionCustodyPlanV1({
      planId: "frontier.production-custody.equal-date", assessment: f.assessment,
      plannedAt: "2026-08-30T20:08:00.000Z", expiresAt: "2026-08-30T20:08:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => buildReadyFrontierProductionCustodyPlanV1({
      planId: "frontier.production-custody.reversed-date", assessment: f.assessment,
      plannedAt: "2026-08-30T20:09:00.000Z", expiresAt: "2026-08-30T20:08:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: "frontier.production-custody-run.equal-date", plan: f.plan,
      startedAt: "2026-08-30T20:09:00.000Z", completedAt: "2026-08-30T20:09:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: "frontier.production-custody-run.reversed-date", plan: f.plan,
      startedAt: "2026-08-30T20:10:00.000Z", completedAt: "2026-08-30T20:09:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => parseReadyFrontierProductionCustodyPlanV1(f.plan,
      f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
  } finally {
    defineProperty(Date.prototype, "getTime", getTimeDescriptor);
    defineProperty(Date.prototype, "toISOString", toISOStringDescriptor);
  }
  assert.deepEqual(parseReadyFrontierProductionCustodyPlanV1(f.plan,
    f.activationKey, f.qualificationKey), f.plan);
  assert.deepEqual(parseReadyFrontierProductionCustodyReportV1(f.report, f.plan,
    f.activationKey, f.qualificationKey), f.report);
});

test("CR11B-AUTO-070 fails closed when mutable string slicing could change authenticated identity", () => {
  const f = fixture(), defineProperty = Object.defineProperty;
  const sliceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "slice")!;
  try {
    defineProperty(String.prototype, "slice", { ...sliceDescriptor,
      value: () => "mutable-runtime-id" });
    assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: "frontier.production-custody-run.string-helper-drift", plan: f.plan,
      startedAt: "2026-08-30T20:09:00.000Z", completedAt: "2026-08-30T20:10:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
    assert.throws(() => parseReadyFrontierProductionCustodyReportV1(f.report, f.plan,
      f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
  } finally { defineProperty(String.prototype, "slice", sliceDescriptor); }
  const replay = runReadyFrontierProductionCustodyFakeQualificationV1({
    runId: f.report.runId, plan: f.plan, startedAt: f.report.startedAt, completedAt: f.report.completedAt,
  }, f.activationKey, f.qualificationKey);
  assert.deepEqual(replay, f.report);
  assert.deepEqual(parseReadyFrontierProductionCustodyReportV1(f.report, f.plan,
    f.activationKey, f.qualificationKey), f.report);
});

test("CR11B-AUTO-070 fails closed when canonical digest helpers drift after module load", () => {
  const f = fixture(), defineProperty = Object.defineProperty;
  const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "map")!;
  try {
    defineProperty(Array.prototype, "map", { ...mapDescriptor, value: () => [] });
    assert.throws(() => runReadyFrontierProductionCustodyFakeQualificationV1({
      runId: "frontier.production-custody-run.array-drift", plan: f.plan,
      startedAt: "2026-08-30T20:04:00.000Z", completedAt: "2026-08-30T20:05:00.000Z",
    }, f.activationKey, f.qualificationKey), errorCode("integrity_failed"));
  } finally { defineProperty(Array.prototype, "map", mapDescriptor); }
});

test("CR11B-AUTO-070 emits only a frozen non-authorizing safe projection", () => {
  const f = fixture();
  const projection = projectReadyFrontierProductionCustodyReportV1(f.report, f.plan,
    f.activationKey, f.qualificationKey);
  assert.deepEqual(projection.scenarioStatuses.map((item) => item.scenarioCode),
    [...readyFrontierProductionCustodyScenarioCodesV1]);
  assert.equal(projection.canRunLiveQualification, false);
  assert.equal(projection.canContactHostedDatabase, false);
  assert.equal(projection.canActivateProduction, false);
  assert.equal(projection.canDispatchOrExecute, false);
  assert.ok(Object.isFrozen(projection));
  assert.ok(Object.isFrozen(projection.scenarioStatuses));
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["AuthTag", "evidenceDigest", "serviceIdentityId", "keyIdentityDigest",
    "productionBoundaryAssessment", "injectedFault", "protectedMaterial"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("CR11B-AUTO-070 every exported artifact retains explicit negative authority", () => {
  const f = fixture();
  const projection = projectReadyFrontierProductionCustodyReportV1(f.report, f.plan,
    f.activationKey, f.qualificationKey);
  const forbiddenTrueFields = [
    "liveQualificationAuthorized", "hostedDatabaseContactAuthorized", "networkAuthorized",
    "consumerImplemented", "activationAuthorized", "permitsProtectedReferenceResolution",
    "permitsClaimOrLease", "permitsDispatchOrExecution", "permitsExternalEffects",
    "liveQualificationPerformed", "productionDatabaseContacted", "productionClockContacted",
    "productionKeyStoreContacted", "productionCheckpointContacted", "ownerPolicyRead",
    "ownerApprovalIssued", "protectedReferenceResolutionAttempted", "consumerConstructed",
    "claimOrLeaseAttempted", "dispatchOrExecutionAttempted", "networkContacted",
    "externalEffectOccurred", "grantsApproval", "grantsActivationAuthority", "grantsClaimOrLease",
    "grantsDispatchOrExecution", "grantsExternalEffects", "canRunLiveQualification",
    "canEnrollProductionKeys", "canEnrollOwnerPolicy", "canContactHostedDatabase",
    "canActivateProduction", "canConstructConsumer", "canResolveProtectedReferences",
    "canContactNetwork", "canClaimOrLease", "canDispatchOrExecute",
  ];
  const artifacts = [f.plan, f.report, projection] as unknown as Array<Record<string, unknown>>;
  for (const artifact of artifacts) {
    for (const field of forbiddenTrueFields) {
      if (field in artifact) assert.equal(artifact[field], false, field);
    }
  }
});

test("CR11B-AUTO-070 source has no live database, process, network, credential, or effect client", () => {
  const source = readFileSync(new URL("../src/ready-frontier/v1/production-custody.ts", import.meta.url), "utf8");
  for (const forbidden of ["from \"postgres\"", "@electric-sql/pglite", "node:net", "node:http",
    "node:https", "node:child_process", "node:worker_threads", "node:fs", "fetch(", "Bun.connect",
    "resolveProtectedReference", "dispatchReady", "executeReady"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
