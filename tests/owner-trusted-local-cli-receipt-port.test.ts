import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, deliverControllerWorkerPacketV1 } from "../src/harness/v1/controller-worker-delivery";
import { createOwnerTrustedLocalCliReceiptPortV1 } from "../src/harness/v1/owner-trusted-local-cli-receipt-port";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const delivery = () => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local", runId: "run:local", nodeId: "mac-1" },
  worker: { workerId: "worker:codex:mac-1", adapterId: "connector:codex-owner-trusted-local-v1", adapterRevision: "00570550" },
  input: { prompt: "Reply with exactly the single word: ok", instructions: "Return a short plain-English result." },
  authorityDigest: digest("authority"), connectorProfileDigest: digest("profile"), acceptanceProfileId: "profile:result",
  acceptanceProfileDigest: digest("acceptance"), issuedAt: "2026-09-25T12:00:00.000Z", expiresAt: "2026-09-25T12:05:00.000Z",
});

test("the loopback receipt port mints a valid, tamper-evident accepted receipt", async () => {
  const d = delivery();
  const port = createOwnerTrustedLocalCliReceiptPortV1(() => Date.parse("2026-09-25T12:00:01.000Z"));
  const receipt = await deliverControllerWorkerPacketV1(port, d, { kind: "local", workerId: d.worker.workerId });
  assert.equal(receipt.disposition, "accepted");
  assert.equal(receipt.receivedAt, "2026-09-25T12:00:01.000Z");
  assert.equal(receipt.startsWork, false);
  assert.equal(receipt.grantsExecutionAuthority, false);
});

test("the loopback receipt port refuses a remote route, a wrong worker, and an expired or not-yet-issued clock", async () => {
  const d = delivery();
  const onTime = createOwnerTrustedLocalCliReceiptPortV1(() => Date.parse("2026-09-25T12:00:01.000Z"));
  await assert.rejects(onTime.receive(d, { kind: "remote", workerId: d.worker.workerId }));
  await assert.rejects(onTime.receive(d, { kind: "local", workerId: "worker:other" }));
  const early = createOwnerTrustedLocalCliReceiptPortV1(() => Date.parse("2026-09-25T11:59:00.000Z"));
  await assert.rejects(early.receive(d, { kind: "local", workerId: d.worker.workerId }));
  const late = createOwnerTrustedLocalCliReceiptPortV1(() => Date.parse("2026-09-25T12:06:00.000Z"));
  await assert.rejects(late.receive(d, { kind: "local", workerId: d.worker.workerId }));
});

test("the loopback receipt port refuses an already-aborted signal", async () => {
  const d = delivery();
  const port = createOwnerTrustedLocalCliReceiptPortV1();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(port.receive(d, { kind: "local", workerId: d.worker.workerId }, controller.signal));
});
