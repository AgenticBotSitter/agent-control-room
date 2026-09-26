import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateRemoteControllerWorkerCompositionV1, capturePrivateRemoteControllerWorkerQueueCapabilityV1,
  capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1,
  capturePrivateRemoteControllerWorkerResultIngressCapabilityV1,
  PrivateRemoteControllerWorkerEnrollmentStateV1 } from
  "../src/harness/v1/private-remote-controller-worker-composition";
import { CONTROLLER_WORKER_REMOTE_ADAPTER_V1, createRemoteWorkerEnrollmentV1 } from "../src/harness/v1/remote-worker-delivery";
import { createControllerWorkerProgressReturnV1, createControllerWorkerTerminalReturnV1 } from
  "../src/harness/v1/controller-worker-result-return";
import { advanceRemoteWorkerEnrollmentInStoreV1 } from "../src/harness/v1/remote-worker-enrollment-store";
import { binding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";
import { signedNodeFrameSchema } from "../src/node-protocol/v1";
import { controllerWorkerDeliveryReceiptSchemaV1 } from "../src/harness/v1/controller-worker-delivery";
import { canonicalCapabilityDigest, canonicalReleaseBindingDigest, canonicalRemoteWorkerFixture,
  enrollCanonicalRemoteWorker, realInstalledConnection } from "./helpers/canonical-remote-worker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected_record");
  return value;
}

test("two canonical remote workers are receipt-isolated and reconnect only recovers the original durable receipt", async t => {
  const c = await canonicalRemoteWorkerFixture(); t.after(c.f.close); c.advance(1_500);
  const enrolled = (workerId: string) => createRemoteWorkerEnrollmentV1({ workerId,
    adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321",
    enrollmentId: `enrollment:${workerId.slice(7)}`, state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
  const workerA = enrolled("worker:remote-a"), workerB = enrolled("worker:remote-b");
  await enrollCanonicalRemoteWorker(c, workerA); await enrollCanonicalRemoteWorker(c, workerB);
  const connectionA = await realInstalledConnection(workerA, c.now), connectionB = await realInstalledConnection(workerB, c.now);
  t.after(connectionA.close); t.after(connectionB.close);
  const stateA = new PrivateRemoteControllerWorkerEnrollmentStateV1(workerA);
  const stateB = new PrivateRemoteControllerWorkerEnrollmentStateV1(workerB);
  const compose = (worker: typeof workerA, state: PrivateRemoteControllerWorkerEnrollmentStateV1,
    session: typeof connectionA.session) => createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db, planner: c.planner,
    integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId, nodeId: binding.nodeId, workerId: worker.workerId,
    connectorProfileDigest: c.connectorProfileDigest, capabilityDigest: canonicalCapabilityDigest,
    releaseBindingDigest: canonicalReleaseBindingDigest, enrollmentState: state,
    supportedAdapterRevisions: [worker.adapterRevision], session, clock: c.now });
  const controllerA = compose(workerA, stateA, connectionA.session);
  const controllerB = compose(workerB, stateB, connectionB.session);
  const queueA = capturePrivateRemoteControllerWorkerQueueCapabilityV1(controllerA);
  assert.deepEqual({ startsWork: queueA.startsWork, grantsExecutionAuthority: queueA.grantsExecutionAuthority },
    { startsWork: false, grantsExecutionAuthority: false }, "queue custody is never execution authority");
  const preparedA = await controllerA.materializer.prepare(c.ref);
  assert.deepEqual({ startsWork: preparedA.startsWork, grantsExecutionAuthority: preparedA.grantsExecutionAuthority },
    { startsWork: false, grantsExecutionAuthority: false });
  const sent = await controllerA.materializer.transmit(c.ref, preparedA);
  assert.equal(sent.kind, "transmitted");
  if (sent.kind !== "transmitted") throw new Error("expected one canonical send");
  const dispatchA = connectionA.takeDispatch();
  await assert.rejects(connectionB.receiveDispatch(dispatchA), /(?:unauthenticated|unavailable|invalid|forbidden)/,
    "worker B cannot receive worker A's signed packet");
  await assert.rejects(controllerB.materializer.prepare(c.ref), /unavailable/,
    "worker B's protected resolver cannot adopt worker A's durable packet");
  assert.equal(connectionB.sends(), 0, "a foreign worker neither receives nor sends a substitute packet");
  const lostReceipt = await connectionA.receiveDispatch(dispatchA);
  assert.equal(connectionA.sends(), 1, "only worker A received the one packet");

  await connectionA.reconnect();
  const reconstructedA = compose(workerA, stateA, connectionA.session);
  const reconstructedPrepared = await reconstructedA.materializer.prepare(c.ref);
  assert.deepEqual(reconstructedPrepared, preparedA, "controller reconstruction retains only worker A's durable packet");
  const ingressA = capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(reconstructedA);
  const recoveredRaw = await connectionA.recovery(sent.transmission.queueId);
  const recovered = record(await ingressA.recover(recoveredRaw));
  assert.deepEqual({ replayed: recovered.replayed, startsWork: recovered.startsWork,
    grantsExecutionAuthority: recovered.grantsExecutionAuthority },
  { replayed: false, startsWork: false, grantsExecutionAuthority: false });
  assert.equal(connectionA.sends(), 1, "reconnect recovers the original durable receipt without a second send");
  await assert.rejects(ingressA.recover(lostReceipt), /unavailable/, "the recovery ingress cannot settle a second receipt");

  // A replacement connection which proved the original receipt is eligible to
  // return receipt-bound evidence.  The evidence remains inert at this stage.
  c.advance(1);
  const lostReceiptFrame = signedNodeFrameSchema.parse(JSON.parse(lostReceipt));
  if (lostReceiptFrame.type !== "controller.worker.delivery.receipt") throw new Error("expected_delivery_receipt_frame");
  const recoveredReceipt = controllerWorkerDeliveryReceiptSchemaV1.parse(lostReceiptFrame.body.receipt);
  const recoveredProgress = createControllerWorkerProgressReturnV1({
    identity: { ...preparedA.delivery.identity, workerId: workerA.workerId },
    deliveryReceipt: recoveredReceipt, enrollmentDigest: workerA.enrollmentDigest,
    connectionId: connectionA.connectionId(), sequence: 1, occurredAt: new Date(c.now()).toISOString(),
    progressPercent: 1, evidenceDigest: "sha256:" + "4".repeat(64),
  });
  const recoveredResultIngress = capturePrivateRemoteControllerWorkerResultIngressCapabilityV1(reconstructedA);
  const recoveredProgressResult = await recoveredResultIngress.receive(await connectionA.result(
    "controller.worker.result.progress", recoveredProgress));
  assert.equal(record(recoveredProgressResult).kind, "progress", "recovered receipt enables only the existing inert result channel");

  const row = await c.f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, new Uint8Array(32).fill(61), {
    tenantId: binding.tenantId, workerId: workerA.workerId, expectedRevision: 0, state: "draining",
    evidenceDigest: "sha256:" + "1".repeat(64), now: new Date(c.now() + 1).toISOString() }));
  await assert.rejects(reconstructedA.materializer.prepare(c.ref), /unavailable/, "a stale resolver cannot bypass draining");
  const quarantined = await c.f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, new Uint8Array(32).fill(61), {
    tenantId: binding.tenantId, workerId: workerA.workerId, expectedRevision: row.record.revision, state: "quarantined",
    evidenceDigest: "sha256:" + "2".repeat(64), now: new Date(c.now() + 2).toISOString() }));
  await assert.rejects(reconstructedA.materializer.prepare(c.ref), /unavailable/, "a stale resolver cannot bypass quarantine");
  const revoked = await c.f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, new Uint8Array(32).fill(61), {
    tenantId: binding.tenantId, workerId: workerA.workerId, expectedRevision: quarantined.record.revision, state: "revoked",
    evidenceDigest: "sha256:" + "3".repeat(64), now: new Date(c.now() + 3).toISOString() }));
  await assert.rejects(reconstructedA.materializer.prepare(c.ref), /unavailable/, "a stale resolver cannot bypass revocation");
  assert.equal(revoked.record.state, "revoked");
});

test("stale remote resolvers reread lifecycle and key authority before preparing a packet", async t => {
  for (const state of ["draining", "quarantined", "revoked"] as const) await t.test(state, async t => {
    const c = await canonicalRemoteWorkerFixture(); t.after(c.f.close); c.advance(1_500);
    const worker = createRemoteWorkerEnrollmentV1({ workerId: `worker:stale-${state}`,
      adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321", enrollmentId: `enrollment:stale-${state}`,
      state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
    await enrollCanonicalRemoteWorker(c, worker);
    const connection = await realInstalledConnection(worker, c.now); t.after(connection.close);
    const controller = createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db, planner: c.planner,
      integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId, nodeId: binding.nodeId, workerId: worker.workerId,
      connectorProfileDigest: c.connectorProfileDigest, capabilityDigest: canonicalCapabilityDigest,
      releaseBindingDigest: canonicalReleaseBindingDigest, enrollmentState: new PrivateRemoteControllerWorkerEnrollmentStateV1(worker),
      supportedAdapterRevisions: [worker.adapterRevision], session: connection.session, clock: c.now });
    await controller.materializer.prepare(c.ref);
    let revision = 0;
    for (const next of state === "draining" ? ["draining"] as const
      : state === "quarantined" ? ["draining", "quarantined"] as const
        : ["draining", "quarantined", "revoked"] as const) {
      const advanced = await c.f.db.transaction(tx => advanceRemoteWorkerEnrollmentInStoreV1(tx, new Uint8Array(32).fill(61), {
        tenantId: binding.tenantId, workerId: worker.workerId, expectedRevision: revision, state: next,
        evidenceDigest: `sha256:${(next === "draining" ? "1" : next === "quarantined" ? "2" : "3").repeat(64)}`,
        now: new Date(c.now() + revision + 1).toISOString() }));
      revision = advanced.record.revision;
    }
    await assert.rejects(controller.materializer.prepare(c.ref), /unavailable/);
    assert.equal(connection.sends(), 0, "stale lifecycle state cannot send or start work");
  });
  await t.test("key rotation", async t => {
    const c = await canonicalRemoteWorkerFixture(); t.after(c.f.close); c.advance(1_500);
    const worker = createRemoteWorkerEnrollmentV1({ workerId: "worker:stale-key", adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1,
      adapterRevision: "revision:7654321", enrollmentId: "enrollment:stale-key", state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
    await enrollCanonicalRemoteWorker(c, worker);
    const connection = await realInstalledConnection(worker, c.now); t.after(connection.close);
    const controller = createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db, planner: c.planner,
      integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId, nodeId: binding.nodeId, workerId: worker.workerId,
      connectorProfileDigest: c.connectorProfileDigest, capabilityDigest: canonicalCapabilityDigest,
      releaseBindingDigest: canonicalReleaseBindingDigest, enrollmentState: new PrivateRemoteControllerWorkerEnrollmentStateV1(worker),
      supportedAdapterRevisions: [worker.adapterRevision], session: connection.session, clock: c.now });
    await controller.materializer.prepare(c.ref);
    await c.f.db.query("UPDATE control_node_keys SET state='retired' WHERE tenant_id=$1 AND node_id=$2 AND id='key:test'",
      [binding.tenantId, binding.nodeId]);
    await c.f.db.query(`INSERT INTO control_node_keys (id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
      VALUES('key:rotated',$1,$2,'ed25519','c3BraQ','sha256:${"4".repeat(64)}','active',$3,$3)`,
    [binding.tenantId, binding.nodeId, new Date(c.now()).toISOString()]);
    await c.f.db.query("UPDATE control_nodes SET identity_key_id='key:rotated', payload=jsonb_set(payload,'{identityKeyId}',to_jsonb('key:rotated'::text)) WHERE tenant_id=$1 AND id=$2",
      [binding.tenantId, binding.nodeId]);
    await assert.rejects(controller.materializer.prepare(c.ref), /unavailable/);
    assert.equal(connection.sends(), 0, "stale node-key authority cannot send or start work");
  });
});

test("an enrolled remote worker returns receipt-bound inert evidence without a second delivery", async t => {
  const c = await canonicalRemoteWorkerFixture(); t.after(c.f.close); c.advance(1_500);
  const worker = createRemoteWorkerEnrollmentV1({ workerId: "worker:remote-result",
    adapterId: CONTROLLER_WORKER_REMOTE_ADAPTER_V1, adapterRevision: "revision:7654321",
    enrollmentId: "enrollment:remote-result", state: "enrolled", enrolledAt: at(1_000), revokedAt: null });
  await enrollCanonicalRemoteWorker(c, worker);
  const connection = await realInstalledConnection(worker, c.now); t.after(connection.close);
  const controller = createPrivateRemoteControllerWorkerCompositionV1({ db: c.f.db, planner: c.planner,
    integrityKey: new Uint8Array(32).fill(61), tenantId: binding.tenantId, nodeId: binding.nodeId,
    workerId: worker.workerId, connectorProfileDigest: c.connectorProfileDigest,
    capabilityDigest: canonicalCapabilityDigest, releaseBindingDigest: canonicalReleaseBindingDigest,
    enrollmentState: new PrivateRemoteControllerWorkerEnrollmentStateV1(worker),
    supportedAdapterRevisions: [worker.adapterRevision], session: connection.session, clock: c.now });
  const prepared = await controller.materializer.prepare(c.ref);
  const sent = await controller.materializer.transmit(c.ref, prepared);
  assert.equal(sent.kind, "transmitted");
  if (sent.kind !== "transmitted") throw new Error("expected one dispatch");
  const delivery = prepared.delivery;
  const deliveryRaw = connection.takeDispatch();
  const receiptRaw = await connection.receiveDispatch(deliveryRaw);
  const receiptIngress = capturePrivateRemoteControllerWorkerReceiptIngressCapabilityV1(controller);
  const accepted = await receiptIngress.accept(receiptRaw) as { receipt: unknown };
  const receipt = accepted.receipt as Parameters<typeof createControllerWorkerProgressReturnV1>[0]["deliveryReceipt"];
  c.advance(1);
  const base = { identity: { tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    jobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId, runId: delivery.identity.runId,
    nodeId: delivery.identity.nodeId, workerId: delivery.worker.workerId }, deliveryReceipt: receipt,
    enrollmentDigest: worker.enrollmentDigest, connectionId: connection.connectionId(),
    occurredAt: new Date(c.now()).toISOString() };
  const progress = createControllerWorkerProgressReturnV1({ ...base, sequence: 1, progressPercent: 50,
    evidenceDigest: "sha256:" + "a".repeat(64) });
  const terminal = createControllerWorkerTerminalReturnV1({ ...base, sequence: 2, outcome: "completed",
    resultEvidenceDigest: "sha256:" + "b".repeat(64), contentHash: "sha256:" + "c".repeat(64), sizeBytes: 42,
    startedAt: base.occurredAt, safeReasonCode: null });
  const ingress = capturePrivateRemoteControllerWorkerResultIngressCapabilityV1(controller);
  const progressResult = await ingress.receive(await connection.result("controller.worker.result.progress", progress));
  const progressRecord = record(progressResult);
  assert.deepEqual({ kind: progressRecord.kind, recordsCompletion: progressRecord.recordsCompletion,
    publishesResult: progressRecord.publishesResult, releasesCapacity: progressRecord.releasesCapacity },
  { kind: "progress", recordsCompletion: false, publishesResult: false, releasesCapacity: false });
  const terminalRaw = await connection.result("controller.worker.result.terminal", terminal);
  const terminalResult = await ingress.receive(terminalRaw);
  const terminalRecord = record(terminalResult);
  assert.deepEqual({ kind: terminalRecord.kind, replayed: terminalRecord.replayed,
    recordsCompletion: terminalRecord.recordsCompletion, permitsRetry: terminalRecord.permitsRetry },
  { kind: "terminal", replayed: false, recordsCompletion: false, permitsRetry: false });
  const replay = await ingress.receive(terminalRaw);
  assert.equal(record(replay).replayed, true, "an exact lost terminal acknowledgement is inertly replayed");
  await assert.rejects(ingress.receive(await connection.result("controller.worker.result.progress", progress)), /unavailable/,
    "progress cannot follow a terminal record");
  await assert.rejects((ingress.receive as (this: object, raw: string) => Promise<unknown>).call({}, terminalRaw), /unavailable/,
    "a copied receiver cannot use the installed ingress");
  assert.equal(connection.sends(), 1, "result evidence never retransmits the delivery");
});

test("a failed remote terminal stays receipt-bound evidence without claiming a completed-result identity", async () => {
  const deliveryReceipt = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: "delivery:failed-return", deliveryDigest: "sha256:" + "a".repeat(64),
    workerId: "worker:failed-return", route: { kind: "remote" as const, workerId: "worker:failed-return" },
    receivedAt: at(1_900), disposition: "accepted" as const, startsWork: false as const,
    grantsExecutionAuthority: false as const };
  const returned = createControllerWorkerTerminalReturnV1({
    identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: "run:failed-return", nodeId: binding.nodeId, workerId: "worker:failed-return" },
    deliveryReceipt: { ...deliveryReceipt, receiptDigest: sha256Digest(deliveryReceipt) },
    enrollmentDigest: "sha256:" + "c".repeat(64), connectionId: "connection:failed-return", sequence: 1,
    occurredAt: at(2_000), outcome: "failed", resultEvidenceDigest: null, contentHash: null,
    sizeBytes: null, startedAt: null, safeReasonCode: "worker_failed" });
  assert.equal(returned.terminalIdentityDigest, null);
  assert.equal(returned.outcome, "failed");
});
