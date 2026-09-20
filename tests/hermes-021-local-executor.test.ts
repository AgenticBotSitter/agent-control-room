import assert from "node:assert/strict";
import test from "node:test";
import { hermes021LocalQueueTargetToDispatchReferenceV1 } from "../src/web/v1/hermes-021-local-executor";

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
