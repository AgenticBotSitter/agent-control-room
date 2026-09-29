import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createAuthenticatedRemoteSessionDeliveryBridgeV1 } from "../src/harness/v1/remote-session-delivery-bridge";
import { admitRemoteWorkerDeliveryV1, createRemoteWorkerEnrollmentV1,
  deliverAdmittedRemoteWorkerPacketV1 } from "../src/harness/v1/remote-worker-delivery";

const digest = (value: string) => sha256Digest(value);
const packet = () => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
    runId: "run:test", nodeId: "node:remote" },
  worker: { workerId: "worker:remote", adapterId: "connector:remote", adapterRevision: "00570550" },
  input: { prompt: "Summarize this.", instructions: "Return plain text." }, authorityDigest: digest("authority"),
  connectorProfileDigest: digest("profile"), acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("acceptance"),
  issuedAt: "2026-09-19T12:00:00.000Z", expiresAt: "2026-09-19T12:05:00.000Z",
});
const enrolled = () => createRemoteWorkerEnrollmentV1({ workerId: "worker:remote", adapterId: "connector:remote",
  adapterRevision: "00570550", enrollmentId: "enrollment:remote", state: "enrolled",
  enrolledAt: "2026-09-19T11:00:00.000Z", revokedAt: null });
function accepted(packetValue: ReturnType<typeof packet>) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packetValue.deliveryId, deliveryDigest: packetValue.deliveryDigest, workerId: packetValue.worker.workerId,
    route: { kind: "remote" as const, workerId: packetValue.worker.workerId }, receivedAt: "2026-09-19T12:00:01.000Z",
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

test("an already-authenticated target session receives one admitted shared packet", async () => {
  const value = packet(), calls: unknown[] = [];
  const bridge = createAuthenticatedRemoteSessionDeliveryBridgeV1({ session: { workerId: "worker:remote",
    async receiveControllerWorkerDelivery(delivery, route, signal) {
      calls.push({ delivery, route, signal }); return accepted(delivery);
    } } });
  const admission = admitRemoteWorkerDeliveryV1({ delivery: value, route: { kind: "remote", workerId: "worker:remote" },
    enrollment: enrolled(), supportedAdapterRevisions: ["00570550"] });
  const receipt = await deliverAdmittedRemoteWorkerPacketV1(bridge, admission);
  assert.equal(receipt.deliveryDigest, value.deliveryDigest);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { delivery: value, route: { kind: "remote", workerId: "worker:remote" }, signal: undefined });
});

test("wrong placement, worker, malformed session, and cancellation fail before a session call", async () => {
  const value = packet(), calls: unknown[] = [];
  const bridge = createAuthenticatedRemoteSessionDeliveryBridgeV1({ session: { workerId: "worker:remote",
    async receiveControllerWorkerDelivery() { calls.push("called"); return accepted(value); } } });
  await assert.rejects(bridge.receive(value, { kind: "local", workerId: "worker:remote" }), /remote_worker_delivery_unavailable/);
  await assert.rejects(bridge.receive(value, { kind: "remote", workerId: "worker:other" }), /remote_worker_delivery_unavailable/);
  await assert.rejects(bridge.receive({ ...value, worker: { ...value.worker, workerId: "worker:other" } },
    { kind: "remote", workerId: "worker:other" }), /remote_worker_delivery_unavailable/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(bridge.receive(value, { kind: "remote", workerId: "worker:remote" }, aborted.signal), /remote_worker_delivery_unavailable/);
  assert.equal(calls.length, 0);
  assert.throws(() => createAuthenticatedRemoteSessionDeliveryBridgeV1({ session: { workerId: "worker:remote" } } as never),
    /remote_worker_delivery_unavailable/);
});

test("the common delivery helper rejects a forged remote receipt", async () => {
  const value = packet();
  const bridge = createAuthenticatedRemoteSessionDeliveryBridgeV1({ session: { workerId: "worker:remote",
    async receiveControllerWorkerDelivery(delivery) { return { ...accepted(delivery), deliveryDigest: digest("forged") }; } } });
  const admission = admitRemoteWorkerDeliveryV1({ delivery: value, route: { kind: "remote", workerId: "worker:remote" },
    enrollment: enrolled(), supportedAdapterRevisions: ["00570550"] });
  await assert.rejects(deliverAdmittedRemoteWorkerPacketV1(bridge, admission), /controller worker receipt mismatch/);
});
