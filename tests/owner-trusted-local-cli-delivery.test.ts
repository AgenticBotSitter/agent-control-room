import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { deliverOwnerTrustedLocalCliTaskV1 } from "../src/harness/v1/owner-trusted-local-cli-delivery";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(91);
const worker = { workerId: "worker:local-cli", adapterId: "connector:local-cli-v1", adapterRevision: "00570550" } as const;
const packet = (): ControllerWorkerDeliveryV1 => createControllerWorkerDeliveryV1({
  identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId }, worker,
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("local-cli-authority"),
  connectorProfileDigest: sha256Digest("local-cli-profile"), acceptanceProfileId: "profile:local-cli",
  acceptanceProfileDigest: sha256Digest("local-cli-acceptance"), issuedAt: at(1000), expiresAt: at(120_000),
});

function accepted(value: ControllerWorkerDeliveryV1) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: value.deliveryId, deliveryDigest: value.deliveryDigest, workerId: value.worker.workerId,
    route: { kind: "local" as const, workerId: value.worker.workerId }, receivedAt: at(2000), disposition: "accepted" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

function config(db: Awaited<ReturnType<typeof nativeTaskFixture>>["db"], state: { checks: number; executions: number; publishes: number; revoke?: boolean; fail?: boolean }) {
  return { db, integrityKey: key, binding: worker,
    receiptPort: { async receive(value: ControllerWorkerDeliveryV1) { return accepted(value); } },
    async assertCurrent() { state.checks++; if (state.revoke) throw new Error("lease_revoked"); },
    async execute() { state.executions++; return state.fail ? { kind: "failed" as const, reason: "cli_failed" } : { kind: "completed" as const, text: "bounded local result" }; },
    async publish() { state.publishes++; },
  };
}

test("one local CLI delivery publishes once and restart replay does not execute or publish again", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0 };
  const first = await deliverOwnerTrustedLocalCliTaskV1(config(f.db, state), packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "published"); assert.equal(state.executions, 1); assert.equal(state.publishes, 1);
  const replay = await deliverOwnerTrustedLocalCliTaskV1(config(f.db, state), packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered"); assert.equal(state.executions, 1); assert.equal(state.publishes, 1);
});

test("a post-receipt revocation cannot reach a local CLI and its replay stays fenced", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0, revoke: false };
  const value = config(f.db, state); value.assertCurrent = async () => { state.checks++; if (state.checks === 2) throw new Error("lease_revoked"); };
  const first = await deliverOwnerTrustedLocalCliTaskV1(value, packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "delivery_uncertain"); assert.equal(state.executions, 0);
  const replay = await deliverOwnerTrustedLocalCliTaskV1(value, packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered"); assert.equal(state.executions, 0);
});

test("a local CLI failure records no false result and a restart cannot rerun it", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0, fail: true };
  const first = await deliverOwnerTrustedLocalCliTaskV1(config(f.db, state), packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "execution_failed"); assert.equal(state.publishes, 0);
  const replay = await deliverOwnerTrustedLocalCliTaskV1(config(f.db, state), packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered"); assert.equal(state.executions, 1);
});

test("a lease revoked while a local CLI runs cannot publish its returned text", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0 };
  const value = config(f.db, state); value.assertCurrent = async () => {
    state.checks++; if (state.checks === 3) throw new Error("lease_revoked");
  };
  const first = await deliverOwnerTrustedLocalCliTaskV1(value, packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "delivery_uncertain"); assert.equal(state.executions, 1); assert.equal(state.publishes, 0);
  const replay = await deliverOwnerTrustedLocalCliTaskV1(value, packet(), { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered"); assert.equal(state.executions, 1);
});

test("cancellation during a local CLI cannot publish its returned text", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0 };
  const aborter = new AbortController(), value = config(f.db, state);
  value.execute = async () => { state.executions++; aborter.abort(); return { kind: "completed" as const, text: "late text" }; };
  const result = await deliverOwnerTrustedLocalCliTaskV1(value, packet(), { kind: "local", workerId: worker.workerId }, at(2000), aborter.signal);
  assert.equal(result.state, "delivery_cancelled"); assert.equal(state.executions, 1); assert.equal(state.publishes, 0);
});

test("a cancelled local delivery cannot start a CLI or publish a result", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const state = { checks: 0, executions: 0, publishes: 0 };
  const aborter = new AbortController(); aborter.abort();
  const result = await deliverOwnerTrustedLocalCliTaskV1(config(f.db, state), packet(), { kind: "local", workerId: worker.workerId }, at(2000), aborter.signal);
  assert.equal(result.state, "delivery_cancelled"); assert.equal(state.checks, 0); assert.equal(state.executions, 0); assert.equal(state.publishes, 0);
});
