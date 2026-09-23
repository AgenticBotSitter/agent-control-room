import assert from "node:assert/strict";
import test from "node:test";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
import { NativeResultSubmissionService } from "../src/completion-gate/v1/native-result-submission";
import { nativeRevisedResultFixture } from "./helpers/native-revised-result";

/**
 * Disposable composition proof only. It verifies that a correction is not a
 * separate local queue: the source task and its revised child use the same
 * shared controller-to-worker envelope, changing only route metadata. It does
 * not claim an installed transport or a real second computer.
 */
for (const route of ["local", "remote"] as const) {
  test(`one correction lifecycle uses the ${route} delivery route`, async t => {
    const x = await nativeRevisedResultFixture(undefined, { topologyRoute: route });
    t.after(x.close);
    assert.equal(x.original.topology?.route, route);
    assert.equal(x.topology?.route, route);
    assert.notEqual(x.original.topology?.deliveryId, x.topology?.deliveryId);

    // The shared correction lane accepts an installation-owned inspection
    // capability rather than assuming every completed task used the older
    // native result format. This fixture deliberately wraps the native reader
    // so the test proves the injected seam without adding a second lifecycle.
    const nativeSource = new NativeResultSubmissionService(x.f.db, x.config);
    const source = { async inspectSubmitted(...args: Parameters<typeof nativeSource.inspectSubmitted>) {
      const context = await nativeSource.inspectSubmitted(...args), nativeTask = context.run.nativeTask;
      assert.ok(nativeTask && context.run.startedAt && context.run.finishedAt);
      return { ...context, execution: { leaseId: nativeTask.leaseId, leaseEpoch: nativeTask.leaseEpoch,
        startedAt: context.run.startedAt, completedAt: context.run.finishedAt, completedBefore: nativeTask.deadline } };
    } };
    const complete = () => new NativeTaskCompletionService(x.f.db, x.config, x.f.clock, source)
      .complete(x.request, () => {});
    await assert.rejects(complete, /verification|review|completion/i);

    const verification = new NativeResultVerificationService(x.f.db, x.config, [x.scenario], x.f.clock, source);
    const verified = await verification.verify(x.request, () => {});
    assert.equal(verified.replayed, false);
    const reviewed = await x.review("accepted");
    assert.equal(reviewed.receipt.grantsExecutionAuthority, false);
    const completed = await complete();
    assert.equal(completed.replayed, false);
    const states = await x.childStates();
    assert.deepEqual([states.job.state, states.attempt.state, states.lease.state],
      ["succeeded", "succeeded", "released"]);
  });
}
