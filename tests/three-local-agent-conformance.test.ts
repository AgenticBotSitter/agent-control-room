import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1, deliverControllerWorkerPacketV1,
  type ControllerWorkerDeliveryReceiptV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { localHarnessCapabilitiesV1 } from "../src/harness/v1/local-harness-capabilities";
import { sha256Digest } from "../src/security/canonical-digest";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";

/**
 * This is deliberately a controller-contract conformance proof, not a claim
 * that any local agent has been installed, launched, or granted task authority.
 * It makes the important shared-product property executable: Hermes, Codex and
 * Claude have distinct local worker identities, but receive the same immutable
 * controller packet and the controller keeps one project/task/result/review/
 * correction lifecycle. Real process bridges have their own owner-attended
 * qualification and enablement gates.
 */
const workers = [
  { harness: "hermes", workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1" },
  { harness: "codex", workerId: "worker:codex", adapterId: "codex-app-server/v1" },
  { harness: "claude", workerId: "worker:claude", adapterId: "connector:claude-code-local-v1" },
] as const;

const revision = "00570550";
const issuedAt = "2026-09-20T12:00:00.000Z";
const expiresAt = "2026-09-20T12:05:00.000Z";

function deliveryFor(worker: typeof workers[number]): ControllerWorkerDeliveryV1 {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:local", projectId: "project:local", jobId: "job:shared",
      attemptId: "attempt:shared", runId: "run:shared", nodeId: "node:mac" },
    worker: { workerId: worker.workerId, adapterId: worker.adapterId, adapterRevision: revision },
    input: { prompt: "Review this bounded local task.", instructions: "Return text only." },
    authorityDigest: sha256Digest("one-authority"), connectorProfileDigest: sha256Digest(`${worker.harness}-profile`),
    acceptanceProfileId: "profile:local", acceptanceProfileDigest: sha256Digest("one-acceptance-profile"),
    issuedAt, expiresAt,
  });
}

/** An inert persisted-receipt seam. It models a controller restart without a process launch. */
function receiptPort(receipts = new Map<string, ControllerWorkerDeliveryReceiptV1>()) {
  return { receipts, port: { async receive(delivery: ControllerWorkerDeliveryV1,
    route: { kind: "local" | "remote"; workerId: string }): Promise<ControllerWorkerDeliveryReceiptV1> {
    const prior = receipts.get(delivery.deliveryId);
    const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
      deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: route.workerId,
      route, receivedAt: issuedAt, disposition: prior ? "duplicate" as const : "accepted" as const,
      startsWork: false as const, grantsExecutionAuthority: false as const };
    const receipt = { ...material, receiptDigest: sha256Digest(material) } satisfies ControllerWorkerDeliveryReceiptV1;
    if (!prior) receipts.set(delivery.deliveryId, receipt);
    return receipt;
  } } };
}

test("one this-computer plan represents Hermes, Codex and Claude without a second authority", () => {
  const routes = workers.map(worker => ({ kind: "local" as const, workerId: worker.workerId,
    adapterId: worker.adapterId, adapterRevision: revision }));
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-postgres"),
    schedulerAuthorityDigest: sha256Digest("one-scheduler"), currentRoutes: routes, requestedRoutes: routes });

  assert.equal(plan.mode, "this_computer");
  assert.deepEqual(plan.retainedWorkerIds, workers.map(worker => worker.workerId).sort());
  assert.deepEqual(plan.addedLocalWorkerIds, []);
  assert.deepEqual(plan.addedRemoteWorkerIds, []);
  assert.equal(plan.enablesWorkers, false);
  assert.deepEqual(plan.requiredProofs, ["backup_restore", "local_owner_qualification", "local_runner_bridge"]);
  assert.deepEqual(localHarnessCapabilitiesV1.map(value => value.id), ["hermes", "claude", "codex"]);
  assert.deepEqual(localHarnessCapabilitiesV1.map(value => value.state),
    ["setup_required", "setup_required", "not_available"],
    "a topology plan must not turn an unqualified local connector into a live worker");
});

test("all three local worker identities use one non-executing delivery contract and fail closed on a wrong worker", async () => {
  for (const worker of workers) {
    const delivery = deliveryFor(worker);
    const first = receiptPort();
    const route = { kind: "local" as const, workerId: worker.workerId };
    const accepted = await deliverControllerWorkerPacketV1(first.port, delivery, route);
    assert.equal(accepted.disposition, "accepted", worker.harness);
    assert.equal(accepted.startsWork, false, worker.harness);
    assert.equal(accepted.grantsExecutionAuthority, false, worker.harness);

    // A fresh receiver over the retained receipt store represents restart recovery:
    // it records duplicate delivery rather than launching, scheduling, or retrying work.
    const restarted = receiptPort(first.receipts);
    const duplicate = await deliverControllerWorkerPacketV1(restarted.port, delivery, route);
    assert.equal(duplicate.disposition, "duplicate", worker.harness);
    assert.equal(duplicate.startsWork, false, worker.harness);

    await assert.rejects(deliverControllerWorkerPacketV1(first.port, delivery,
      { kind: "local", workerId: "worker:wrong" }), /controller_worker_delivery_unavailable/);
  }
});

test("two separately prepared local routes retain separate receipts through a shared controller restart", async () => {
  // This is deliberately below the real-process adapters: it proves the one
  // controller receipt shape does not accidentally turn two local routes into
  // one task, while remaining a source-only proof that cannot launch either
  // harness. Hermes and Claude are the two first supported local adapters.
  const hermes = workers[0], claude = workers[2];
  const first = receiptPort();
  const inputFor = (worker: typeof workers[number], identity: ControllerWorkerDeliveryV1["identity"]) => {
    const { schema: _schema, inputDigest: _inputDigest, deliveryId: _deliveryId, deliveryDigest: _deliveryDigest, ...input } = deliveryFor(worker);
    return createControllerWorkerDeliveryV1({ ...input, identity });
  };
  const hermesPacket = inputFor(hermes, {
    tenantId: "tenant:local", projectId: "project:local", jobId: "job:hermes", attemptId: "attempt:hermes",
    runId: "run:hermes", nodeId: "node:marvin",
  });
  const claudePacket = inputFor(claude, {
    tenantId: "tenant:local", projectId: "project:local", jobId: "job:claude", attemptId: "attempt:claude",
    runId: "run:claude", nodeId: "node:claude",
  });
  const hermesReceipt = await deliverControllerWorkerPacketV1(first.port, hermesPacket,
    { kind: "local", workerId: hermes.workerId });
  const claudeReceipt = await deliverControllerWorkerPacketV1(first.port, claudePacket,
    { kind: "local", workerId: claude.workerId });
  assert.equal(hermesReceipt.disposition, "accepted");
  assert.equal(claudeReceipt.disposition, "accepted");
  assert.notEqual(hermesReceipt.deliveryId, claudeReceipt.deliveryId);
  assert.equal(first.receipts.size, 2);

  const restarted = receiptPort(first.receipts);
  const replayedHermes = await deliverControllerWorkerPacketV1(restarted.port, hermesPacket,
    { kind: "local", workerId: hermes.workerId });
  const replayedClaude = await deliverControllerWorkerPacketV1(restarted.port, claudePacket,
    { kind: "local", workerId: claude.workerId });
  assert.equal(replayedHermes.disposition, "duplicate");
  assert.equal(replayedClaude.disposition, "duplicate");
  assert.equal(first.receipts.size, 2, "restart replay cannot add or merge local task receipts");
});

test("the shared local lifecycle carries a correction through result, review, and completion exactly once", async t => {
  // The existing disposable fixture is the authoritative lifecycle proof. It remains
  // adapter-neutral: the worker packet above is the boundary by which each local
  // connector joins this exact same lifecycle.
  const x = await nativeRevisedResultFixture(undefined, { topologyRoute: "local" });
  t.after(x.close);
  assert.equal(x.original.topology?.route, "local");
  assert.equal(x.topology?.route, "local");

  // nativeRevisedResultFixture has already registered and delivered the revised
  // child; this test starts at the shared verification/review boundary.
  const verification = new NativeResultVerificationService(x.f.db, x.config, [x.scenario], x.f.clock);
  const verified = await verification.verify(x.request, () => {});
  assert.equal(verified.replayed, false);
  const reviewed = await x.review("accepted");
  assert.equal(reviewed.receipt.grantsExecutionAuthority, false);
  const completion = await new NativeTaskCompletionService(x.f.db, x.config, x.f.clock).complete(x.request, () => {});
  assert.equal(completion.replayed, false);
  const states = await x.childStates();
  assert.deepEqual([states.job.state, states.attempt.state, states.lease.state],
    ["succeeded", "succeeded", "released"]);

  const replay = await new NativeTaskCompletionService(x.f.db, x.config, x.f.clock).complete(x.request, () => {});
  assert.equal(replay.replayed, true, "completion replay cannot create a second corrected result");
});
