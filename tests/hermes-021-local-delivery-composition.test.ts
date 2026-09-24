import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { deliverHermes021MacosLocalTaskV1, type Hermes021MacosLocalPrivatePortV1 } from "../src/harness/hermes-021-v1";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const receiptKey = new Uint8Array(32).fill(64);
const localBinding = { localServiceId: "service:marvin-hermes", workerId: "worker:marvin",
  expectedVersion: "0.21.3", sourceRevision: "00570550" } as const;
const result = { type: "result" as const, session_id: "session:marvin", exit_code: 0,
  text: "Marvin completed the controlled task.", tokens: { input: 9, output: 6, total: 15, cache_read: 0, cache_write: 0 },
  duration_ms: 120, timestamp: 1 };

function delivery() {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId },
    worker: { workerId: localBinding.workerId, adapterId: "connector:hermes-021-macos-local-v1",
      adapterRevision: localBinding.sourceRevision },
    input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("marvin-authority"),
    connectorProfileDigest: sha256Digest("marvin-profile"), acceptanceProfileId: "profile:marvin",
    acceptanceProfileDigest: sha256Digest("marvin-acceptance"), issuedAt: at(1000), expiresAt: at(120_000),
  });
}

test("Marvin's local delivery is recorded before one controlled invocation and never auto-runs again after restart", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(); let policyCalls = 0, runs = 0, stages = 0;
  const terminalResultStorage = new InMemoryArtifactStorage();
  const config = { db: f.db, integrityKey: receiptKey, binding: localBinding,
    policy: { assertAdmitted(value: { delivery: typeof packet }) {
      policyCalls++; assert.equal(value.delivery.deliveryDigest, packet.deliveryDigest);
    } }, privatePort: { async run(input: Parameters<Hermes021MacosLocalPrivatePortV1["run"]>[0]) { runs++; await input.terminalStage?.capture(result); stages++; return [result]; } }, terminalResultStorage };
  const first = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(first.state, "completed_delivery");
  assert.equal(first.outcome?.kind, "completed");
  assert.equal(runs, 1);
  assert.equal(stages, 1, "the private runner stages the terminal line before it returns");

  // A fresh composition over the same database models a controller restart.
  const restarted = await deliverHermes021MacosLocalTaskV1({ ...config, privatePort: { async run() {
    runs++; return [result]; } } }, packet, { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(restarted.state, "recovered_terminal_result");
  assert.equal(restarted.outcome?.kind, "completed");
  assert.equal(restarted.outcome?.text, result.text);
  assert.equal(runs, 1);
  // The first delivery is checked on receipt and immediately before launch;
  // the restart replay is checked once but never invokes Hermes twice.
  assert.equal(policyCalls, 3);
});

test("a local policy refusal records no receipt and never invokes Marvin", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(); let runs = 0;
  await assert.rejects(deliverHermes021MacosLocalTaskV1({ db: f.db, integrityKey: receiptKey, binding: localBinding,
    policy: { assertAdmitted() { throw new Error("policy_refused"); } }, privatePort: { async run() { runs++; return [result]; } } },
  packet, { kind: "local", workerId: localBinding.workerId }, at(2000)), /policy_refused/);
  assert.equal(runs, 0);
  const rows = await f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_worker_delivery_receipts");
  assert.equal(rows.rows[0]?.count, "0");
});

test("a task-bound port is minted after the durable receipt and final authority recheck", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(); let receiptVisible = false, rechecked = false, factoryCalls = 0, runs = 0, checks = 0;
  const config = { db: f.db, integrityKey: receiptKey, binding: localBinding,
    policy: { assertAdmitted() {} },
    async recheckBeforeLaunch() {
      checks++;
      const rows = await f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_worker_delivery_receipts");
      receiptVisible = rows.rows[0]?.count === "1"; rechecked = true;
    },
    privatePortFactory: { create(task: { projectId: string; jobId: string }, beforeSpawn?: () => Promise<void>) {
      factoryCalls++; assert.equal(receiptVisible, true); assert.equal(rechecked, true);
      assert.equal(task.projectId, packet.identity.projectId); assert.equal(task.jobId, packet.identity.jobId);
      return { async run() { await beforeSpawn?.(); runs++; return [result]; } };
    } } };
  const delivered = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(delivered.state, "completed_delivery");
  assert.equal(delivered.outcome?.kind, "completed");
  assert.equal(factoryCalls, 1); assert.equal(runs, 1); assert.equal(checks, 2,
    "the final check is repeated by the task-bound port immediately before spawning Hermes");
});

test("a task revoked while local launch preparation is in progress never reaches Hermes", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(); let checks = 0, runs = 0;
  const config = { db: f.db, integrityKey: receiptKey, binding: localBinding,
    policy: { assertAdmitted() {} },
    async recheckBeforeLaunch() {
      checks++;
      // The first check admits construction after the receipt is durable. The
      // second is the task-bound check after preparation and models a revoked
      // lease immediately before the process boundary.
      if (checks === 2) throw new Error("delivery_revoked");
    },
    privatePortFactory: { create(_task: unknown, beforeSpawn?: () => Promise<void>) {
      return { async run() { await beforeSpawn?.(); runs++; return [result]; } };
    } } };
  const first = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(first.state, "completed_delivery");
  assert.deepEqual(first.outcome, { kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  assert.equal(checks, 2); assert.equal(runs, 0);
  const replay = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered", "a revoked pre-spawn attempt is not retried automatically");
  assert.equal(runs, 0);
});

test("a task-port factory failure after the receipt is uncertainty, not a retry", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const packet = delivery(); let factoryCalls = 0;
  const config = { db: f.db, integrityKey: receiptKey, binding: localBinding,
    policy: { assertAdmitted() {} },
    privatePortFactory: { create() { factoryCalls++; throw new Error("runner_unavailable"); } } };
  const first = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(first.state, "completed_delivery");
  assert.deepEqual(first.outcome, { kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  const replay = await deliverHermes021MacosLocalTaskV1(config, packet,
    { kind: "local", workerId: localBinding.workerId }, at(2000));
  assert.equal(replay.state, "already_delivered");
  assert.equal(factoryCalls, 1, "the durable receipt prevents another runner-mint attempt");
});
