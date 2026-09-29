import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createClaudeOwnerTrustedLocalQueueExecutorV1 } from "../src/web/v1/claude-owner-trusted-local-executor";

const tenantId = "tenant:local", nodeId = "mac-1", leaseId = "lease:local";
const target = { kind: "claude-code-local" as const, nodeId, leaseId,
  task: { projectId: "project:one", jobId: "job:one", attemptId: "attempt:one", inputDigest: sha256Digest("input") },
  startsWork: false as const, grantsExecutionAuthority: false as const };
const prepared = { delivery: { identity: { tenantId } }, route: { kind: "local", workerId: "worker:claude:mac-1" } };

test("Mac-local Claude queue delivery rechecks authority and requires published result", async () => {
  const events: string[] = [];
  const executor = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
    preparation: { async prepare(reference) {
      assert.equal(reference.leaseId, leaseId); events.push("prepare");
      return prepared as never;
    }, async assertCurrent() { events.push("current"); } },
    delivery: { async deliver() { events.push("deliver"); return { state: "published" }; } },
  });
  assert.deepEqual(await executor.deliver(target, new AbortController().signal), { disposition: "delivered" });
  assert.deepEqual(events, ["prepare", "current", "deliver", "current"]);

  const refused = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
    preparation: { async prepare() { return prepared as never; }, async assertCurrent() { throw new Error("revoked"); } },
    delivery: { async deliver() { throw new Error("must_not_spawn"); } },
  });
  await assert.rejects(refused.deliver(target, new AbortController().signal), /revoked/);

  const unresolved = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
    preparation: { async prepare() { return prepared as never; }, async assertCurrent() {} },
    delivery: { async deliver() { return { state: "failed" }; } },
  });
  await assert.rejects(unresolved.deliver(target, new AbortController().signal), /queue_delivery_unresolved/);
});

test("Mac-local Claude refuses an already-aborted signal before preparation", async () => {
  let preparedCount = 0;
  const executor = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
    preparation: { async prepare() { preparedCount++; return prepared as never; }, async assertCurrent() {} },
    delivery: { async deliver() { return { state: "published" }; } },
  });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executor.deliver(target, controller.signal), /executor_unavailable/);
  assert.equal(preparedCount, 0);
});

test("Mac-local Claude does not acknowledge a lease revoked during delivery", async () => {
  let checks = 0;
  const executor = createClaudeOwnerTrustedLocalQueueExecutorV1({ tenantId,
    preparation: { async prepare() { return prepared as never; }, async assertCurrent() {
      if (++checks === 2) throw new Error("lease_revoked");
    } },
    delivery: { async deliver() { return { state: "published" }; } },
  });
  await assert.rejects(executor.deliver(target, new AbortController().signal), /lease_revoked/);
  assert.equal(checks, 2);
});
