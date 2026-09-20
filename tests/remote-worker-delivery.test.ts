import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { admitRemoteWorkerDeliveryV1, createRemoteWorkerEnrollmentV1,
  observeRemoteWorkerDeliveryV1 } from "../src/harness/v1/remote-worker-delivery";

const digest = (value: string) => sha256Digest(value);
const delivery = () => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
    runId: "run:test", nodeId: "node:remote" },
  worker: { workerId: "worker:remote", adapterId: "connector:hermes-021", adapterRevision: "00570550" },
  input: { prompt: "Summarize this.", instructions: "Return plain text." }, authorityDigest: digest("authority"),
  connectorProfileDigest: digest("profile"), acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("acceptance"),
  issuedAt: "2026-09-19T12:00:00.000Z", expiresAt: "2026-09-19T12:05:00.000Z",
});
const enrollment = (state: "enrolled" | "revoked" = "enrolled") => createRemoteWorkerEnrollmentV1({
  workerId: "worker:remote", adapterId: "connector:hermes-021", adapterRevision: "00570550", enrollmentId: "enrollment:remote",
  state, enrolledAt: "2026-09-19T11:00:00.000Z", revokedAt: state === "revoked" ? "2026-09-19T11:30:00.000Z" : null,
});

test("remote enrollment accepts the shared packet without creating a second task identity", () => {
  const packet = delivery();
  const admitted = admitRemoteWorkerDeliveryV1({ delivery: packet, route: { kind: "remote", workerId: "worker:remote" },
    enrollment: enrollment(), supportedAdapterRevisions: ["00570550"] });
  assert.equal(admitted.accepted, true);
  if (!admitted.accepted) throw new Error("expected admission");
  assert.equal(admitted.delivery.deliveryId, packet.deliveryId);
  assert.equal(admitted.route.kind, "remote");
  assert.equal(admitted.startsWork, false);
});

test("revocation, mismatch, and unsupported versions refuse before remote delivery", () => {
  const packet = delivery();
  for (const result of [
    admitRemoteWorkerDeliveryV1({ delivery: packet, route: { kind: "remote", workerId: "worker:remote" }, enrollment: enrollment("revoked"), supportedAdapterRevisions: ["00570550"] }),
    admitRemoteWorkerDeliveryV1({ delivery: packet, route: { kind: "remote", workerId: "worker:other" }, enrollment: enrollment(), supportedAdapterRevisions: ["00570550"] }),
    admitRemoteWorkerDeliveryV1({ delivery: packet, route: { kind: "remote", workerId: "worker:remote" }, enrollment: enrollment(), supportedAdapterRevisions: ["different"] }),
  ]) {
    assert.equal(result.accepted, false);
    assert.equal(result.grantsExecutionAuthority, false);
  }
});

test("a disconnect or timeout stays uncertain and never authorizes a retry", () => {
  assert.deepEqual(observeRemoteWorkerDeliveryV1({ result: null, failure: "disconnect" }),
    { kind: "uncertain", reason: "remote_disconnect", permitsRetry: false });
  assert.deepEqual(observeRemoteWorkerDeliveryV1({ result: null, failure: "timeout" }),
    { kind: "uncertain", reason: "remote_timeout", permitsRetry: false });
});
