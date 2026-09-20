import assert from "node:assert/strict";
import test from "node:test";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { syntheticWorkerDeliveryConformance, type SyntheticWorkerPlacement } from "./helpers/worker-delivery-conformance";
import { sha256Digest } from "../src/security";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";

for (const placement of ["local", "remote"] as const satisfies readonly SyntheticWorkerPlacement[]) {
  test(`worker-delivery adapter carries one complete original result-and-review journey (${placement})`, async t => {
    let worker!: ReturnType<typeof syntheticWorkerDeliveryConformance>;
    const x = await nativeTaskLifecycleFixture({ workerDeliveryFactory: ({ deliverCanonical, reconcileCanonical }) => {
      worker = syntheticWorkerDeliveryConformance(placement, reconcileCanonical, deliverCanonical);
      return worker.delivery;
    } });
    t.after(x.close);
    assert.deepEqual(worker.deliveries, [x.deliveryReference]);
    assert.deepEqual(worker.reconciliations, placement === "remote" ? [x.deliveryReference] : []);
    assert.equal(x.receipt.nodeReportedDisposition, "recorded");

    await x.handoff.start(); const plan = await x.register(); await x.publish();
    x.advance(); await x.handoff.poll(); await x.publish();
    x.advance(); const text = `Worker-delivery ${placement} result.`; x.setResult(text);
    await x.handoff.poll(); const completed = await x.publish();
    const saved = await x.results.ingest(completed.raw, new TextEncoder().encode(text), x.options());
    const target = (await x.f.reviewStore.snapshot(x.registration.tenantId, plan.plan.targetId)).target;
    const review = await new WebTaskReviewService(x.f.db, x.f.scope, x.f.ownerConfig, x.f.clock).record(
      x.f.identity, x.registration.projectId, x.registration.jobId, {
        artifactId: saved.receipt.artifactId, targetId: target.id, targetDigest: sha256Digest(target),
        contentHash: saved.receipt.contentHash, decision: "changes_requested", feedback: "Provide a correction through the separately approved path.",
      }, `worker-delivery-${placement}-review`);
    assert.equal(review.receipt.grantsExecutionAuthority, false);
    assert.equal((await x.f.reviewStore.snapshot(x.registration.tenantId, target.id)).status, "changes_requested");
    assert.deepEqual(x.local.calls, ["capabilities", "start", "status", "status"]);
  });
}

/**
 * U1 composition check. This is deliberately test-only synthetic evidence,
 * not a local IPC, networking, enrollment, installation or agent claim.
 * Existing signed native lifecycle fixtures exercise the canonical task,
 * result, review and correction records. The two doubles exercise only the
 * new controller-to-worker receipt boundary around those same opaque records.
 * The signed fixture wire is still the existing direct test path, so this does
 * not claim that a mounted controller now routes the full journey exclusively
 * through WorkerDeliveryV1.
 */
for (const placement of ["local", "remote"] as const satisfies readonly SyntheticWorkerPlacement[]) {
  test(`worker-delivery composition preserves canonical result-and-correction records (${placement})`, async t => {
    const x = await nativeRevisedResultFixture(); t.after(x.close);
    const signal = new AbortController().signal;
    const sourceQueued = await x.original.f.coordinator.readNativeTaskQueue(...x.original.f.args);
    const correctionQueued = await x.coordinator.readNativeTaskQueue(...x.args);
    assert.ok(sourceQueued); assert.ok(correctionQueued);
    const source = { schema: "control-room.native-task-submission/v1" as const,
      tenantId: x.original.registration.tenantId, projectId: x.original.registration.projectId,
      jobId: x.original.registration.jobId, attemptId: x.original.registration.attemptId,
      queueId: sourceQueued.queueId, inputDigest: x.original.f.args[3], packetDigest: sourceQueued.packetDigest };
    const correction = { schema: "control-room.native-task-submission/v1" as const,
      tenantId: x.prepared.request.tenantId, projectId: x.plan.projectId, jobId: x.prepared.request.jobId,
      attemptId: x.prepared.request.attemptId, queueId: correctionQueued.queueId,
      inputDigest: x.prepared.inputDigest, packetDigest: correctionQueued.packetDigest };
    const sourceReconciliation = x.original.f.create(x.original.f.db, { async enqueueInSession() {} });
    const worker = syntheticWorkerDeliveryConformance(placement, (reference, abort) =>
      reference.queueId === source.queueId
        ? sourceReconciliation.reconcileApprovedQueueDelivery(reference, abort)
        : x.reconciliationCoordinator.reconcileApprovedQueueDelivery(reference, abort));

    for (const reference of [source, correction]) {
      const receipt = await worker.delivery.deliver(reference, signal);
      assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
      if (placement === "local") {
        assert.equal(receipt.disposition, "delivered");
        assert.equal(receipt.deliveryConfirmed, true);
      } else {
        assert.equal(receipt.disposition, "unresolved");
        assert.equal(receipt.deliveryConfirmed, false);
        // The lost remote reply is reconciled from the existing signed receipt,
        // not a test-double answer. This operation never sends or reauthorizes.
        assert.deepEqual(await worker.delivery.reconcile(reference, signal), {
          contract: "control-room.worker-delivery/v1", disposition: "recorded",
          startsWork: false, grantsExecutionAuthority: false });
      }
    }
    assert.deepEqual(worker.deliveries, [source, correction]);
    assert.deepEqual(worker.reconciliations, placement === "remote" ? [source, correction] : []);

    // The existing fixture proves the original signed result was reviewed with
    // changes requested, and only then created a separately approved child.
    assert.equal(x.changeReview.decision, "changes_requested");
    assert.equal(x.planned.receipt.executionAvailability, "requires_separate_assignment_and_approval");
    assert.notEqual(x.child.jobId, x.source.jobId);
    assert.equal(x.child.target.supersedesTargetId, x.source.target.id);

    // The child has a fresh result. It still needs its own verification and an
    // owner acceptance before canonical completion can release the lease.
    const completion = new NativeTaskCompletionService(x.f.db, x.config, x.f.clock);
    await assert.rejects(completion.complete(x.request, () => {}));
    await new NativeResultVerificationService(x.f.db, x.config, [x.scenario], x.f.clock).verify(x.request, () => {});
    await x.review("accepted");
    const completed = await completion.complete(x.request, () => {});
    assert.equal(completed.replayed, false);
    const state = await x.childStates();
    assert.deepEqual([state.job.state, state.attempt.state, state.lease.state], ["succeeded", "succeeded", "released"]);
  });
}
