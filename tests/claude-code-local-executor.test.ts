import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeLocalQueueTargetToDispatchReferenceV1 } from "../src/web/v1/claude-code-local-executor";
import { sha256Digest } from "../src/security";

const target = Object.freeze({ kind: "claude-code-local" as const, nodeId: "node:claude-local", leaseId: "lease:claude-local",
  task: Object.freeze({ projectId: "project:local", jobId: "job:local", attemptId: "attempt:local", inputDigest: sha256Digest("input") }),
  startsWork: false as const, grantsExecutionAuthority: false as const });

test("Claude queue executor accepts only the narrow verified queue locator", () => {
  assert.deepEqual(claudeCodeLocalQueueTargetToDispatchReferenceV1("tenant:local", target), {
    tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local",
    leaseId: "lease:claude-local", inputDigest: target.task.inputDigest,
  });
  assert.throws(() => claudeCodeLocalQueueTargetToDispatchReferenceV1("tenant:local", { ...target, startsWork: true }));
  assert.throws(() => claudeCodeLocalQueueTargetToDispatchReferenceV1("tenant:local", { ...target, kind: "hermes-021-local" }));
  assert.throws(() => claudeCodeLocalQueueTargetToDispatchReferenceV1("tenant:local", { ...target, workspace: "/private/path" }));
});
