import assert from "node:assert/strict";
import test from "node:test";
import { codexOwnerTrustedLocalQueueTargetToDispatchReferenceV1, createCodexOwnerTrustedLocalQueueExecutorV1 } from "../src/web/v1/codex-owner-trusted-local-executor";

const target = { kind: "codex-owner-trusted-local" as const, nodeId: "node:mac", leaseId: "lease:one",
  task: { projectId: "project:one", jobId: "job:one", attemptId: "attempt:one", inputDigest: `sha256:${"a".repeat(64)}` },
  startsWork: false as const, grantsExecutionAuthority: false as const };

test("local Codex queue executor passes only a reconstructed current delivery to the fixed host bridge", async () => {
  assert.deepEqual(codexOwnerTrustedLocalQueueTargetToDispatchReferenceV1("tenant:one", target), {
    tenantId: "tenant:one", projectId: "project:one", jobId: "job:one", attemptId: "attempt:one", leaseId: "lease:one",
    inputDigest: `sha256:${"a".repeat(64)}`,
  });
  let prepared = 0, checked = 0, delivered = 0;
  const executor = createCodexOwnerTrustedLocalQueueExecutorV1({ tenantId: "tenant:one", clock: () => 1_700_000_000_000,
    preparation: { async prepare() { prepared++; return { schema: "control-room.codex-owner-trusted-local-dispatch-preparation/v1",
      delivery: {} as never, workflowId: "workflow:one", route: { kind: "local", workerId: "worker:codex" },
      startsWork: false, grantsExecutionAuthority: false }; }, async assertCurrent() { checked++; } },
    delivery: { async deliver(delivery, route, receivedAt) { delivered++; assert.deepEqual(delivery, {}); assert.deepEqual(route, { kind: "local", workerId: "worker:codex" });
      assert.equal(receivedAt, "2023-11-14T22:13:20.000Z"); return { state: "published" }; } },
  });
  const result = await executor.deliver(target, new AbortController().signal);
  assert.equal(result.disposition, "delivered");
  assert.equal(prepared, 1); assert.equal(checked, 2); assert.equal(delivered, 1);
});

test("local Codex queue executor refuses altered locators and incomplete publication", async () => {
  assert.throws(() => codexOwnerTrustedLocalQueueTargetToDispatchReferenceV1("tenant:one", { ...target, model: "not allowed" }),
    /codex_owner_trusted_local_executor_unavailable|[Uu]nrecognized key/);
  const executor = createCodexOwnerTrustedLocalQueueExecutorV1({ tenantId: "tenant:one",
    preparation: { async prepare() { return { schema: "control-room.codex-owner-trusted-local-dispatch-preparation/v1", delivery: {} as never,
      workflowId: "workflow:one", route: { kind: "local", workerId: "worker:codex" }, startsWork: false, grantsExecutionAuthority: false }; }, async assertCurrent() {} },
    delivery: { async deliver() { return { state: "delivery_uncertain" }; } },
  });
  await assert.rejects(executor.deliver(target, new AbortController().signal), /codex_owner_trusted_local_queue_delivery_unresolved/);
});
