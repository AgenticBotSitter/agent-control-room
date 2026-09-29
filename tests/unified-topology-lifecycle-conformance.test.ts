import assert from "node:assert/strict";
import test from "node:test";
import { nativeQualityCompletionFixture } from "./helpers/native-quality-completion";

/**
 * This is a disposable composition proof, not a network or installation
 * claim. The same real signed native fixture is carried through the shared
 * controller-to-worker envelope. The local and remote forms differ only in
 * route metadata; both keep the canonical task, result, review and completion
 * records in the one fixture database.
 */
for (const route of ["local", "remote"] as const) {
  test(`one complete task/result/review lifecycle uses the ${route} delivery route`, async t => {
    const x = await nativeQualityCompletionFixture(undefined, undefined, { topologyRoute: route });
    t.after(x.close);
    assert.equal(x.topology?.route, route);
    assert.equal(x.topology?.deliveryId.startsWith("delivery:"), true);
    assert.equal(x.topology?.deliveryDigest.startsWith("sha256:"), true);
    assert.equal(x.receipt.nodeReportedDisposition, "recorded");

    await x.verify();
    const ownerReview = await x.review("accepted");
    assert.equal(ownerReview.receipt.grantsExecutionAuthority, false);
    const completed = await x.complete();
    assert.equal(completed.replayed, false);
    const states = await x.states();
    assert.deepEqual([states.job.state, states.attempt.state, states.lease.state],
      ["succeeded", "succeeded", "released"]);
  });
}
