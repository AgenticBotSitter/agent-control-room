import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { deliverClaudeCodeLocalTaskV1 } from "../src/harness/claude-code-v1/local-delivery-composition";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";
import { CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "../src/harness/claude-code-v1/result-publication";
import type { ClaudeCodeProcessBytePortV1, OwnedClaudeCodeProcessV1 } from "../src/harness/claude-code-v1/owned-process-session";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const integrityKey = new Uint8Array(32).fill(86);
const worker = { workerId: "worker:claude-local", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "source-123" } as const;
const authorityDigest = sha256Digest("claude-controller-authority");
const acceptanceProfileDigest = sha256Digest("claude-acceptance-profile");

function delivery(patch: Partial<Parameters<typeof createControllerWorkerDeliveryV1>[0]> = {}): ControllerWorkerDeliveryV1 {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId }, worker,
    input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest,
    connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, acceptanceProfileId: "profile:claude", acceptanceProfileDigest,
    issuedAt: at(1000), expiresAt: at(120_000), ...patch,
  });
}

function accepted(packet: ControllerWorkerDeliveryV1, receivedAt = at(2000)) {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: packet.deliveryId, deliveryDigest: packet.deliveryDigest, workerId: packet.worker.workerId,
    route: { kind: "local" as const, workerId: packet.worker.workerId }, receivedAt,
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
}

function fakePort(state?: { writes: Uint8Array[]; events: string[] }): ClaudeCodeProcessBytePortV1 {
  let ended = false;
  const exit = new Promise<Readonly<{ code: number | null; signal: string | null }>>(resolve => {
    queueMicrotask(() => { if (!ended) { ended = true; resolve({ code: 0, signal: null }); } });
  });
  return { writeStdin: async bytes => { state?.events.push("write"); state?.writes.push(Uint8Array.from(bytes)); },
    readStdout: async () => { state?.events.push("read"); return undefined; }, readStderr: async () => undefined,
    closeStdin: async () => { state?.events.push("close-stdin"); }, terminate: async () => { ended = true; }, exited: exit };
}

function composition(f: Awaited<ReturnType<typeof nativeTaskFixture>>, packet: ControllerWorkerDeliveryV1,
  state: { revoked: boolean; receives: number; acquires: number; rechecks?: number; now?: number;
    writes?: Uint8Array[]; events?: string[] }) {
  return { db: f.db, integrityKey, binding: { ...worker, authorityDigest, acceptanceProfileId: "profile:claude", acceptanceProfileDigest },
    authority: { currentAdmissionDigest: () => authorityDigest, assertCurrent() { if (state.revoked) throw new Error("revoked"); } },
    receiptPort: { async receive(value: ControllerWorkerDeliveryV1) { state.receives++; return accepted(value); } },
    acquire: (): OwnedClaudeCodeProcessV1 => { state.acquires++; return { ready: Promise.resolve(fakePort(
      state.writes && state.events ? { writes: state.writes, events: state.events } : undefined)), close: async () => {} }; }, cleanupMs: 200,
    async recheckBeforeAcquire(value: ControllerWorkerDeliveryV1, route: { kind: "local"; workerId: string }, signal: AbortSignal) {
      if (signal.aborted || value.deliveryDigest !== packet.deliveryDigest || route.workerId !== worker.workerId || state.revoked)
        throw new Error("canonical_delivery_changed");
      state.rechecks = (state.rechecks ?? 0) + 1;
    },
    clock: () => state.now ?? Date.parse(at(2000)) };
}

test("Claude local delivery reserves the exact shared receipt before fake acquisition, and duplicate/restart never acquires again", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0, rechecks: 0,
    writes: [] as Uint8Array[], events: [] as string[] }, config = composition(f, packet, state);
  const first = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "reserved_session_open"); assert.equal(state.acquires, 1);
  if (first.state === "reserved_session_open") { await first.session.ready; await first.session.close(); }
  assert.equal(state.writes.length, 1);
  assert.match(new TextDecoder().decode(state.writes[0]), /Task:\nSummarize the supplied synthetic text\./);
  assert.deepEqual(state.events.slice(0, 3), ["write", "close-stdin", "read"]);
  state.revoked = true;
  const replay = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_reserved"); assert.deepEqual({ receives: state.receives, acquires: state.acquires, rechecks: state.rechecks }, { receives: 1, acquires: 1, rechecks: 1 });
});

test("a changed canonical task or lease after durable receipt cannot acquire Claude", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0, rechecks: 0 };
  const config = composition(f, packet, state);
  config.recheckBeforeAcquire = async () => { state.rechecks++; throw new Error("lease_changed_after_receipt"); };
  const result = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(result.state, "delivery_uncertain");
  assert.deepEqual({ receives: state.receives, rechecks: state.rechecks, acquires: state.acquires },
    { receives: 1, rechecks: 1, acquires: 0 });
  const replay = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_reserved");
  assert.equal(state.acquires, 0, "the saved receipt never causes a second acquisition");
});

test("an observed caller cancellation after receipt is distinct from uncertain delivery", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0 };
  const controller = new AbortController(), config = composition(f, packet, state);
  config.receiptPort = { async receive(value: ControllerWorkerDeliveryV1) {
    state.receives++; controller.abort(); return accepted(value);
  } };
  const result = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000), controller.signal);
  assert.equal(result.state, "delivery_cancelled");
  assert.deepEqual({ receives: state.receives, acquires: state.acquires }, { receives: 1, acquires: 0 });
});

test("wrong worker and authority loss across the receipt await never reach acquisition", async t => {
  const wrongFixture = await nativeTaskFixture(); t.after(wrongFixture.close);
  const wrong = delivery({ worker: { ...worker, workerId: "worker:wrong" } });
  const wrongState = { revoked: false, receives: 0, acquires: 0 };
  await assert.rejects(deliverClaudeCodeLocalTaskV1(composition(wrongFixture, wrong, wrongState), wrong,
    { kind: "local", workerId: wrong.worker.workerId }, at(2000)), /claude_code_local_delivery_unavailable/);
  assert.deepEqual(wrongState, { revoked: false, receives: 0, acquires: 0 });

  const f = await nativeTaskFixture(); t.after(f.close); const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0 };
  const config = composition(f, packet, state);
  config.receiptPort = { async receive(value: ControllerWorkerDeliveryV1) { state.receives++; state.revoked = true; return accepted(value); } };
  const result = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(result.state, "delivery_uncertain"); assert.equal(state.acquires, 0);
});

test("a delivery claiming a different connector profile never reaches receipt or acquisition", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery({ connectorProfileDigest: sha256Digest("other-connector-profile") });
  const state = { revoked: false, receives: 0, acquires: 0 };
  await assert.rejects(deliverClaudeCodeLocalTaskV1(composition(f, packet, state), packet,
    { kind: "local", workerId: worker.workerId }, at(2000)), /claude_code_local_delivery_unavailable/);
  assert.deepEqual(state, { revoked: false, receives: 0, acquires: 0 });
});

test("a durable-commit crash boundary remains explicit uncertainty and replay cannot reacquire", async t => {
  const f = await nativeTaskFixture(); t.after(f.close); const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0 };
  let transactions = 0;
  const db = { ...f.db, async transaction<T>(callback: Parameters<typeof f.db.transaction<T>>[0]) {
    const result = await f.db.transaction(callback); transactions++;
    if (transactions === 2) throw new Error("simulated crash after durable commit");
    return result;
  } };
  const config = { ...composition(f, packet, state), db };
  const first = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(first.state, "delivery_uncertain"); assert.equal(state.acquires, 0);
  const replay = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(replay.state, "already_reserved"); assert.equal(state.acquires, 0);
});

test("a delivery that expires while its receipt is being saved never acquires Claude", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(), state = { revoked: false, receives: 0, acquires: 0, now: Date.parse(at(2000)) };
  const config = composition(f, packet, state);
  config.receiptPort = { async receive(value: ControllerWorkerDeliveryV1) {
    state.receives++; state.now = Date.parse(packet.expiresAt); return accepted(value);
  } };
  const result = await deliverClaudeCodeLocalTaskV1(config, packet, { kind: "local", workerId: worker.workerId }, at(2000));
  assert.equal(result.state, "delivery_uncertain");
  assert.equal(state.acquires, 0);
});
