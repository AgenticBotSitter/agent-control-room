import assert from "node:assert/strict";
import test from "node:test";
import { NativeResultVerificationService } from "../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
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

    const complete = () => new NativeTaskCompletionService(x.f.db, x.config, x.f.clock)
      .complete(x.request, () => {});
    await assert.rejects(complete, /verification|review|completion/i);

    const verification = new NativeResultVerificationService(x.f.db, x.config, [x.scenario], x.f.clock);
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
