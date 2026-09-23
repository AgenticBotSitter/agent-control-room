import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { deriveSeveralComputerDeliveryEvidenceV1, deriveSeveralComputerEnrollmentEvidenceV1,
  recordSeveralComputerProofReadinessV1, SEVERAL_COMPUTER_DELIVERY_PROOF_REPORT_V1,
  SEVERAL_COMPUTER_ENROLLMENT_PROOF_REPORT_V1 } from "../src/harness/v1/several-computer-proof-evidence";

const digest = (value: string) => sha256Digest(value);
const plan = {
  installationId: "installation:test", planDigest: digest("plan"),
  databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
  currentRouteDigest: digest("routes-before"), requestedRouteDigest: digest("routes-after"),
  planMode: "several_computers" as const,
};
const worker = {
  intendedWorkerId: "worker:remote", nonTargetWorkerIds: ["worker:other"],
  adapterId: "connector:remote/v1", adapterRevision: "00570550",
  enrollmentId: "enrollment:remote", enrollmentDigest: digest("enrollment"),
  enrollmentWorkerId: "worker:remote", certificateWorkerId: "worker:remote",
  certificateDigest: digest("certificate"), currentAuthorityDigest: digest("authority"),
};
const enrollmentReport = () => ({ schema: SEVERAL_COMPUTER_ENROLLMENT_PROOF_REPORT_V1, plan, worker,
  facts: { enrollmentState: "enrolled" as const, enrollmentCurrent: true as const,
    certificateIdentityMatched: true as const, adapterRevisionCompatible: true as const,
    protocolCompatible: true as const, authorityCurrent: true as const } });
const deliveryReport = () => ({ schema: SEVERAL_COMPUTER_DELIVERY_PROOF_REPORT_V1, plan, worker,
  facts: { dispatchCount: 1 as const, receiptCount: 1 as const, progressObservationCount: 2 as const,
    progressPhases: ["start", "running"] as const, completedResultCount: 1 as const,
    pendingReviewCount: 1 as const, nonTargetDispatchCount: 0 as const, disconnectOutcome: "uncertain" as const,
    disconnectRetryCount: 0 as const, reconnectOutcome: "receipt_only_reconciled" as const,
    reconnectDispatchCount: 0 as const, revokedWorkerOutcome: "refused_before_delivery" as const,
    revokedWorkerDispatchCount: 0 as const, incompatibleWorkerOutcome: "refused_before_delivery" as const,
    incompatibleWorkerDispatchCount: 0 as const, correctionRequestCount: 1 as const,
    revisedResultCount: 1 as const, revisedPendingReviewCount: 1 as const } });

test("derives deterministic inert enrollment and complete two-computer delivery evidence", () => {
  const enrollment = deriveSeveralComputerEnrollmentEvidenceV1(enrollmentReport());
  const delivery = deriveSeveralComputerDeliveryEvidenceV1(deliveryReport());
  assert.equal(enrollment.evidenceDigest, deriveSeveralComputerEnrollmentEvidenceV1(enrollmentReport()).evidenceDigest);
  assert.equal(delivery.evidenceDigest, deriveSeveralComputerDeliveryEvidenceV1(deliveryReport()).evidenceDigest);
  assert.notEqual(enrollment.evidenceDigest, delivery.evidenceDigest);
  assert.ok(Object.isFrozen(enrollment) && Object.isFrozen(enrollment.report.worker.nonTargetWorkerIds));
});

test("records the two proofs independently while preserving unrelated readiness", () => {
  const existing = createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: digest("backup") }] });
  const enrolled = recordSeveralComputerProofReadinessV1(existing,
    deriveSeveralComputerEnrollmentEvidenceV1(enrollmentReport()));
  assert.deepEqual(enrolled.proofs.map(item => item.proof), ["backup_restore", "remote_enrollment"]);
  const delivered = recordSeveralComputerProofReadinessV1(enrolled,
    deriveSeveralComputerDeliveryEvidenceV1(deliveryReport()));
  assert.deepEqual(delivered.proofs.map(item => item.proof), ["backup_restore", "remote_enrollment", "two_computer_delivery"]);
});

test("refuses partial, duplicate, contradictory, secret-bearing, callable, proxy and supplied-digest inputs", () => {
  const partial = deliveryReport() as Record<string, unknown>;
  partial.facts = { ...(partial.facts as object), revisedResultCount: 0 };
  assert.throws(() => deriveSeveralComputerDeliveryEvidenceV1(partial), /expected 1/);
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1({ ...enrollmentReport(), token: "secret" }), /unrecognized/i);
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1({ ...enrollmentReport(), worker: {
    ...worker, nonTargetWorkerIds: ["worker:other", "worker:other"] } }), /unavailable/);
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1({ ...enrollmentReport(), worker: {
    ...worker, certificateWorkerId: "worker:other" } }), /unavailable/);
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1({ ...enrollmentReport(), callable: () => undefined }), /unavailable/);
  let proxyTraps = 0;
  const trapped = new Proxy(enrollmentReport(), {
    ownKeys(target) { proxyTraps += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { proxyTraps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1(trapped), /unavailable/);
  assert.equal(proxyTraps, 0, "a rejected proxy must not execute reflection traps");
  let accessorCalls = 0;
  const accessor = enrollmentReport() as Record<string, unknown>;
  Object.defineProperty(accessor, "facts", { enumerable: true, get() {
    accessorCalls += 1; return enrollmentReport().facts;
  } });
  assert.throws(() => deriveSeveralComputerEnrollmentEvidenceV1(accessor), /unavailable/);
  assert.equal(accessorCalls, 0, "a rejected accessor must not execute its getter");
  const evidence = deriveSeveralComputerEnrollmentEvidenceV1(enrollmentReport());
  assert.throws(() => recordSeveralComputerProofReadinessV1(undefined, { ...evidence,
    evidenceDigest: digest("caller supplied") }), /unavailable/);
});

test("requires the exact progress observations as well as one completed result", () => {
  const missing = deliveryReport() as Record<string, unknown>;
  const { progressObservationCount: _count, ...missingFacts } = missing.facts as ReturnType<typeof deliveryReport>["facts"];
  missing.facts = missingFacts;
  assert.throws(() => deriveSeveralComputerDeliveryEvidenceV1(missing), /progressObservationCount/);

  const changed = deliveryReport();
  assert.throws(() => deriveSeveralComputerDeliveryEvidenceV1({ ...changed, facts: {
    ...changed.facts, progressObservationCount: 1,
  } }), /expected 2/);
  assert.throws(() => deriveSeveralComputerDeliveryEvidenceV1({ ...changed, facts: {
    ...changed.facts, progressPhases: ["running", "start"],
  } }), /expected.*start/);
});

test("refuses foreign-plan evidence without disturbing the prior record", () => {
  const existing = createInstallationReadinessV1({ planDigest: digest("foreign"),
    proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: digest("backup") }] });
  assert.throws(() => recordSeveralComputerProofReadinessV1(existing,
    deriveSeveralComputerEnrollmentEvidenceV1(enrollmentReport())), /unavailable/);
  assert.deepEqual(existing.proofs.map(item => item.proof), ["backup_restore"]);
});
