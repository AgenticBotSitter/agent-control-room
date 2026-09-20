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
