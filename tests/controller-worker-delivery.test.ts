import assert from "node:assert/strict";
import test from "node:test";
import { controllerWorkerAdapterIdSchemaV1, createControllerWorkerDeliveryV1, deliverControllerWorkerPacketV1, type ControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const delivery = () => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local", runId: "run:local", nodeId: "node:marvin" },
  worker: { workerId: "worker:marvin", adapterId: "connector:hermes-021", adapterRevision: "00570550" },
  input: { prompt: "Summarize the change.", instructions: "Return a short plain-English result." },
  authorityDigest: digest("authority"), connectorProfileDigest: digest("profile"), acceptanceProfileId: "profile:result",
  acceptanceProfileDigest: digest("acceptance"), issuedAt: "2026-09-19T12:00:00.000Z", expiresAt: "2026-09-19T12:05:00.000Z",
});
function receipt(route: "local" | "remote"): ControllerWorkerDeliveryReceiptV1 {
  const d = delivery(), material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: d.deliveryId, deliveryDigest: d.deliveryDigest, workerId: d.worker.workerId,
    route: { kind: route, workerId: d.worker.workerId }, receivedAt: "2026-09-19T12:00:01.000Z",
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

test("one controller packet has the same identity over local and remote delivery routes", async () => {
  const d = delivery(), received: unknown[] = [];
  const port = { async receive(packet: typeof d, route: { kind: "local" | "remote" }) { received.push({ packet, route }); return receipt(route.kind); } };
  const local = await deliverControllerWorkerPacketV1(port, d, { kind: "local", workerId: d.worker.workerId });
  const remote = await deliverControllerWorkerPacketV1(port, d, { kind: "remote", workerId: d.worker.workerId });
  assert.equal(local.deliveryDigest, remote.deliveryDigest); assert.equal(local.deliveryId, remote.deliveryId);
  assert.equal((received[0] as { packet: typeof d }).packet.deliveryDigest, (received[1] as { packet: typeof d }).packet.deliveryDigest);
  assert.equal(local.startsWork, false); assert.equal(remote.grantsExecutionAuthority, false);
});

test("controller packet refuses changed contents, wrong worker routes, and mismatched receipts", async () => {
  const d = delivery();
  assert.throws(() => createControllerWorkerDeliveryV1({ ...d, input: { ...d.input, prompt: "Changed" } }));
  await assert.rejects(deliverControllerWorkerPacketV1({ async receive() { return receipt("local"); } }, d,
    { kind: "local", workerId: "worker:other" }), /controller_worker_delivery_unavailable/);
  const original = receipt("local");
  const { receiptDigest: _ignored, ...changed } = { ...original, deliveryId: "delivery:wrong" };
  const validButForeign = { ...changed, receiptDigest: sha256Digest(changed) };
  await assert.rejects(deliverControllerWorkerPacketV1({ async receive() { return validButForeign; } }, d,
    { kind: "local", workerId: d.worker.workerId }), /controller_worker_delivery_receipt_mismatch/);
});

test("adapter identifiers may use reviewed slash-separated names but never paths or empty segments", () => {
  assert.equal(controllerWorkerAdapterIdSchemaV1.parse("codex-app-server/v1"), "codex-app-server/v1");
  for (const unsafe of ["/codex-app-server/v1", "codex-app-server/", "codex-app-server//v1", "../codex", "codex/../v1", "codex/app server"])
    assert.equal(controllerWorkerAdapterIdSchemaV1.safeParse(unsafe).success, false, unsafe);
});
