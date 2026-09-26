import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createOwnerTrustedLocalClaudeDeliveryV1, createOwnerTrustedLocalCodexDeliveryV1 } from "../src/harness/v1/owner-trusted-local-cli-composition";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(92);
const baseConfiguration = { executablePath: "/Applications/Control Room/bin/agent", workingDirectory: "/private/tmp/acr-empty-task", deadlineMs: 60_000 };
function packet(workerId: string, adapterId: string): ControllerWorkerDeliveryV1 { return createControllerWorkerDeliveryV1({
  identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId,
    runId: registration.id, nodeId: binding.nodeId }, worker: { workerId, adapterId, adapterRevision: "00570550" },
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:local", acceptanceProfileDigest: sha256Digest("acceptance"),
  issuedAt: at(1000), expiresAt: at(120_000),
}); }
function receipt(value: ControllerWorkerDeliveryV1) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const, deliveryId: value.deliveryId,
    deliveryDigest: value.deliveryDigest, workerId: value.worker.workerId, route: { kind: "local" as const, workerId: value.worker.workerId },
    receivedAt: at(2000), disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}
function base(f: Awaited<ReturnType<typeof nativeTaskFixture>>, workerId: string, adapterId: string, state: { published: number }) {
  return { db: f.db, integrityKey: key, binding: { workerId, adapterId, adapterRevision: "00570550" },
    receiptPort: { async receive(value: ControllerWorkerDeliveryV1) { return receipt(value); } },
    async assertCurrent() {}, async publish() { state.published++; }, async recordFailure() {} };
}

test("the composed Codex delivery reaches the common receipt and publisher exactly once", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { published: 0 }, workerId = "worker:codex-local", adapterId = "connector:codex-local-v1";
  let calls = 0;
  const delivery = createOwnerTrustedLocalCodexDeliveryV1(base(f, workerId, adapterId, state), { async execute() {
    calls++; return { status: "completed" as const, text: "codex finished" };
  } }, baseConfiguration);
  const first = await delivery.deliver(packet(workerId, adapterId), { kind: "local", workerId }, at(2000));
  assert.equal(first.state, "published"); assert.equal(calls, 1); assert.equal(state.published, 1);
  const replay = await delivery.deliver(packet(workerId, adapterId), { kind: "local", workerId }, at(2000));
  assert.equal(replay.state, "already_delivered"); assert.equal(calls, 1); assert.equal(state.published, 1);
});

test("the composed Claude delivery keeps a nonzero CLI outcome out of publication", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { published: 0 }, workerId = "worker:claude-local", adapterId = "connector:claude-local-v1";
  const delivery = createOwnerTrustedLocalClaudeDeliveryV1(base(f, workerId, adapterId, state), { async execute() {
    return { status: "timed_out" as const, reason: "deadline_exceeded" };
  } }, baseConfiguration);
  const result = await delivery.deliver(packet(workerId, adapterId), { kind: "local", workerId }, at(2000));
  assert.equal(result.state, "execution_failed"); assert.equal(state.published, 0);
});

test("a composed delivery snapshots its host-owned binding before future calls", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { published: 0 }, workerId = "worker:codex-snapshot", adapterId = "connector:codex-snapshot-v1";
  const mutable = base(f, workerId, adapterId, state);
  const delivery = createOwnerTrustedLocalCodexDeliveryV1(mutable, { async execute() {
    return { status: "completed" as const, text: "snapshot result" };
  } }, baseConfiguration);
  mutable.binding = { workerId: "worker:other", adapterId, adapterRevision: "00570550" };
  const result = await delivery.deliver(packet(workerId, adapterId), { kind: "local", workerId }, at(2000));
  assert.equal(result.state, "published"); assert.equal(state.published, 1);
});
