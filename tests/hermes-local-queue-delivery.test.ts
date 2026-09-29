import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { deliverVerifiedHermesLocalQueueTaskV1 } from "../src/web/v1/hermes-local-queue-delivery";

const reference = Object.freeze({ schema: "control-room.native-task-submission/v1" as const,
  tenantId: "tenant:one", projectId: "project:one", jobId: "job:one", attemptId: "attempt:one",
  queueId: "queue:one", inputDigest: sha256Digest("input"), packetDigest: sha256Digest("packet") });
const target = Object.freeze({ kind: "hermes-local" as const, nodeId: "node:mac-1", leaseId: "lease:one",
  task: Object.freeze({ projectId: reference.projectId, jobId: reference.jobId, attemptId: reference.attemptId,
    inputDigest: reference.inputDigest }), startsWork: false as const, grantsExecutionAuthority: false as const });

test("the current Hermes queue switch accepts only its exact canonical locator", async () => {
  let calls = 0;
  const result = await deliverVerifiedHermesLocalQueueTaskV1({ reference, target, signal: new AbortController().signal,
    async deliver(value, signal) { calls++; assert.equal(value, target); assert.equal(signal.aborted, false); } });
  assert.deepEqual(result, { disposition: "delivered" });
  assert.equal(calls, 1);
  await assert.rejects(() => deliverVerifiedHermesLocalQueueTaskV1({ reference,
    target: { ...target, task: { ...target.task, inputDigest: sha256Digest("changed") } },
    signal: new AbortController().signal, async deliver() { calls++; } }));
  assert.equal(calls, 1);
});
