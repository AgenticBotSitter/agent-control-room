import assert from "node:assert/strict";
import test from "node:test";
import { hermes021LocalQueueTargetToDispatchReferenceV1,
  requireHermes021LocalQueuePublicationV1 } from "../src/web/v1/hermes-021-local-executor";

const target = Object.freeze({ kind: "hermes-021-local" as const, nodeId: "node:marvin-local", leaseId: "lease:marvin-1",
  task: Object.freeze({ projectId: "project:local", jobId: "job:marvin-1", attemptId: "attempt:marvin-1",
    inputDigest: `sha256:${"a".repeat(64)}` }), startsWork: false as const, grantsExecutionAuthority: false as const });

test("a local Marvin queue target becomes only a canonical dispatch reference", () => {
  assert.deepEqual(hermes021LocalQueueTargetToDispatchReferenceV1("tenant:local", target), {
    tenantId: "tenant:local", projectId: "project:local", jobId: "job:marvin-1", attemptId: "attempt:marvin-1",
    leaseId: "lease:marvin-1", inputDigest: `sha256:${"a".repeat(64)}`,
  });
  assert.throws(() => hermes021LocalQueueTargetToDispatchReferenceV1("tenant:local", { ...target, startsWork: true }));
  assert.throws(() => hermes021LocalQueueTargetToDispatchReferenceV1("tenant:local", { ...target, privateRunner: "not allowed" }));
});

test("a local Hermes queue acknowledgement requires a saved pending-review result", () => {
  requireHermes021LocalQueuePublicationV1({ publication: {} });
  for (const outcome of [
    {},
    { execution: { delivered: { state: "completed_delivery", outcome: { kind: "cancelled" } } } },
    { execution: { delivered: { state: "completed_delivery", outcome: { kind: "uncertain" } } } },
  ]) assert.throws(() => requireHermes021LocalQueuePublicationV1(outcome), /hermes_021_local_queue_delivery_unresolved/);
});
