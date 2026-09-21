import assert from "node:assert/strict";
import test from "node:test";
import { claudeCodeLocalQueueTargetToDispatchReferenceV1, createClaudeCodeLocalQueueExecutorV1,
  requireClaudeCodeQueuePublicationV1 } from "../src/web/v1/claude-code-local-executor";
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

test("a queue executor never acknowledges an unresolved Claude delivery", async () => {
  // This construction proves the public queue boundary refuses an absent or
  // malformed execution composition before it can be mistaken for delivery.
  assert.throws(() => createClaudeCodeLocalQueueExecutorV1({ tenantId: "tenant:local", execution: undefined as never }),
    /claude_code_local_executor_unavailable/);
  requireClaudeCodeQueuePublicationV1({ state: "published_pending_review" });
  requireClaudeCodeQueuePublicationV1({ state: "recovered_pending_review" });
  for (const state of ["not_started", "terminal_result_uncertain"] as const)
    assert.throws(() => requireClaudeCodeQueuePublicationV1({ state }), /claude_code_local_queue_delivery_unresolved/);
});
