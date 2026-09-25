import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createHermesLocalQueueExecutorV1, hermesLocalQueueTargetToDispatchReferenceV1 } from "../src/web/v1/hermes-local-executor";

const target = Object.freeze({ kind: "hermes-local" as const, nodeId: "node:mac-1", leaseId: "lease:one",
  task: Object.freeze({ projectId: "project:one", jobId: "job:one", attemptId: "attempt:one", inputDigest: sha256Digest("input") }),
  startsWork: false as const, grantsExecutionAuthority: false as const });

test("the current Hermes executor prepares and rechecks before it accepts one published delivery", async () => {
  const reference = hermesLocalQueueTargetToDispatchReferenceV1("tenant:one", target);
  const prepared = Object.freeze({ delivery: Object.freeze({ marker: "delivery" }), route: Object.freeze({ kind: "local", workerId: "worker:marvin" }) });
  let preparedCalls = 0, checkedCalls = 0, deliveredCalls = 0;
  const executor = createHermesLocalQueueExecutorV1({ tenantId: "tenant:one", clock: () => 1_700_000_000_000,
    preparation: {
      async prepare(value) { preparedCalls++; assert.deepEqual(value, reference); return prepared as never; },
      async assertCurrent(value, valuePrepared) { checkedCalls++; assert.deepEqual(value, reference); assert.equal(valuePrepared, prepared); },
    },
    delivery: { async deliver(delivery, route, receivedAt, signal) {
      deliveredCalls++; assert.equal(delivery, prepared.delivery); assert.equal(route, prepared.route);
      assert.equal(receivedAt, "2023-11-14T22:13:20.000Z"); assert.equal(signal?.aborted, false);
      return { state: "published" };
    } },
  });
  await executor.deliver(target, new AbortController().signal);
  assert.deepEqual({ preparedCalls, checkedCalls, deliveredCalls }, { preparedCalls: 1, checkedCalls: 1, deliveredCalls: 1 });
});

test("the current Hermes executor does not turn a replay acknowledgement into queue success", async () => {
  const executor = createHermesLocalQueueExecutorV1({ tenantId: "tenant:one",
    preparation: { async prepare() { return { delivery: {}, route: {} } as never; }, async assertCurrent() {} },
    delivery: { async deliver() { return { state: "already_delivered" }; } },
  });
  await assert.rejects(() => executor.deliver(target, new AbortController().signal));
});
