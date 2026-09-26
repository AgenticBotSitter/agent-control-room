import assert from "node:assert/strict";
import test from "node:test";
import { advanceRemoteWorkerEnrollmentRecordV1, createRemoteWorkerEnrollmentRecordV1,
  verifyRemoteWorkerEnrollmentRecordV1 } from "../src/harness/v1/remote-worker-enrollment-record";
import { createRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-delivery";

const now = "2026-09-24T12:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function enrollment(state: "enrolled" | "revoked" = "enrolled") {
  return createRemoteWorkerEnrollmentV1({ workerId: "worker:remote-one", adapterId: "connector:remote-reviewed",
    adapterRevision: "revision:remote-reviewed", enrollmentId: "enrollment:remote-one", state,
    enrolledAt: "2026-09-24T11:00:00.000Z", revokedAt: state === "revoked" ? now : null });
}

function initial() {
  return createRemoteWorkerEnrollmentRecordV1({ tenantId: "tenant:one", nodeId: "node:one", nodeKeyId: "key:one",
    enrollment: enrollment(), capabilityDigest: digest("a"), releaseBindingDigest: digest("b"), now });
}

test("canonical remote-worker enrollment record binds the exact safe delivery envelope without authorizing work", () => {
  const record = initial();
  assert.equal(record.workerId, "worker:remote-one");
  assert.equal(record.adapterRevision, "revision:remote-reviewed");
  assert.equal(record.state, "enrolled");
  assert.equal(record.previousRecordDigest, null);
  assert.deepEqual(verifyRemoteWorkerEnrollmentRecordV1(record), record);
  assert.equal("startsWork" in record, false);
  assert.equal("grantsExecutionAuthority" in record, false);
});

test("remote-worker lifecycle keeps every enrollment and release binding fixed", () => {
  const record = initial();
  const draining = advanceRemoteWorkerEnrollmentRecordV1(record, { expectedRevision: 0, state: "draining",
    evidenceDigest: digest("c"), now: "2026-09-24T12:01:00.000Z" });
  assert.equal(draining.revision, 1);
  assert.equal(draining.previousRecordDigest, record.recordDigest);
  assert.equal(draining.workerId, record.workerId);
  assert.equal(draining.enrollmentDigest, record.enrollmentDigest);
  assert.equal(draining.releaseBindingDigest, record.releaseBindingDigest);
  assert.equal(draining.state, "draining");
  assert.deepEqual(verifyRemoteWorkerEnrollmentRecordV1(draining), draining);
  assert.throws(() => advanceRemoteWorkerEnrollmentRecordV1(draining, { expectedRevision: 1, state: "enrolled",
    evidenceDigest: digest("d"), now: "2026-09-24T12:02:00.000Z" }), /remote_worker_enrollment_lifecycle_invalid/);
});

test("forged, changed, revoked, stale, or incomplete enrollment material refuses", () => {
  const record = initial();
  assert.throws(() => createRemoteWorkerEnrollmentRecordV1({ tenantId: "tenant:one", nodeId: "node:one", nodeKeyId: "key:one",
    enrollment: enrollment("revoked"), capabilityDigest: digest("a"), releaseBindingDigest: digest("b"), now }), /remote_worker_enrollment_record_invalid/);
  assert.throws(() => verifyRemoteWorkerEnrollmentRecordV1({ ...record, workerId: "worker:other" }), /remote_worker_enrollment_record_invalid/);
  assert.throws(() => verifyRemoteWorkerEnrollmentRecordV1({ ...record, revision: 1 }), /remote_worker_enrollment_record_invalid/);
  assert.throws(() => advanceRemoteWorkerEnrollmentRecordV1(record, { expectedRevision: 0, state: "revoked",
    evidenceDigest: digest("c"), now: "2026-09-24T11:59:59.000Z" }), /remote_worker_enrollment_conflict/);
});
