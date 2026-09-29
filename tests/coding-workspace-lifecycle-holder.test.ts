import assert from "node:assert/strict";
import test from "node:test";
import { CodingWorkspaceLifecycleHolderV1 } from "../src/harness/v1/coding-workspace-lifecycle-holder";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security";

const revision = "a".repeat(40);
function delivery(runId: string, jobId = `job:${runId.slice(4)}`) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:one", projectId: "project:one", jobId,
      attemptId: `attempt:${runId.slice(4)}`, runId, nodeId: "node:one" },
    worker: { workerId: "worker:one", adapterId: "connector:test", adapterRevision: "0000001" },
    input: { prompt: "Make one bounded change.", instructions: "Return evidence only." },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("profile"),
    acceptanceProfileId: "profile:one", acceptanceProfileDigest: sha256Digest("acceptance"),
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:10:00.000Z",
  });
}

function fixture(options: { failCreate?: boolean; failCleanup?: boolean } = {}) {
  let creates = 0, removes = 0;
  const holder = new CodingWorkspaceLifecycleHolderV1({
    maximumConcurrentWorkspaces: 1, allowedPaths: ["src/**"],
    maximumChangedFiles: 2, maximumChangedBytes: 2048,
    workspacePort: {
      inspectExisting: async path => ({ realPath: path, device: "1", inode: path.includes("codex-") ? "4" : "2" }),
      createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision: headRevision }) => {
        creates += 1;
        if (options.failCreate) throw new Error("create_response_lost");
        return { realPath: checkoutPath, repositoryRealPath, headRevision, device: "1", inode: "4" };
      },
      removeWorktree: async () => { removes += 1; if (options.failCleanup) throw new Error("dirty_worktree"); },
    },
  });
  return { holder, counts: () => ({ creates, removes }) };
}

test("one delivery owns one manager lease and immutable audit policy", async () => {
  const { holder, counts } = fixture();
  const packet = delivery("run:bound");
  const held = await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  assert.equal(held.disposition, "workspace_held");
  assert.deepEqual(held.auditPlan?.allowedPaths, ["src/**"]);
  assert.equal(held.auditPlan?.deliveryDigest, packet.deliveryDigest);
  assert.equal(held.auditPlan?.baseRevision, revision);
  assert.equal(held.startsAdapter, false);
  assert.equal(held.releasesCapacity, false);
  assert.equal("lease" in held, false);
  assert.equal((await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision })).disposition, "workspace_held");
  await assert.rejects(holder.acquire({ delivery: packet, repositoryRoot: "/changed",
    workspaceRoot: "/changed", revision: "b".repeat(40) }), /delivery_binding_mismatch/);
  assert.equal(counts().creates, 1);
  await assert.rejects(holder.cleanup(delivery("run:bound", "job:substitute")), /delivery_binding_mismatch/);
});

test("workspace capacity refuses another delivery before any create effect", async () => {
  const { holder, counts } = fixture();
  await holder.acquire({ delivery: delivery("run:first"), repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  await assert.rejects(holder.acquire({ delivery: delivery("run:second"), repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision }), /capacity_exhausted/);
  assert.equal(counts().creates, 1);
});

test("concurrent acquire of the exact delivery creates one workspace", async () => {
  const { holder, counts } = fixture();
  const packet = delivery("run:concurrent");
  const request = { delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision };
  const [first, second] = await Promise.all([holder.acquire(request), holder.acquire(request)]);
  assert.equal(first.disposition, "workspace_held");
  assert.equal(second.disposition, "workspace_held");
  assert.equal(first.auditPlan?.planDigest, second.auditPlan?.planDigest);
  assert.equal(counts().creates, 1);
});

test("uncertain acquisition is retained and can never recreate the workspace", async () => {
  const { holder, counts } = fixture({ failCreate: true });
  const packet = delivery("run:uncertain");
  const uncertain = await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  assert.equal(uncertain.disposition, "workspace_reconciliation_required");
  assert.equal(uncertain.reconciliationRequired, true);
  assert.equal(uncertain.workspaceCapacityHeld, true);
  assert.equal((await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision })).disposition, "workspace_reconciliation_required");
  assert.equal(counts().creates, 1);
  assert.equal((await holder.cleanup(packet)).disposition, "workspace_reconciliation_required");
  assert.equal(counts().removes, 0);
});

test("audit-plan failure after creation is retained for reconciliation", async () => {
  const { holder, counts } = fixture();
  (holder as unknown as { auditAuthority: { derive(): never } }).auditAuthority = {
    derive() { throw new Error("audit_plan_fault"); },
  };
  const packet = delivery("run:audit-fault");
  const retained = await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  assert.equal(retained.disposition, "workspace_reconciliation_required");
  assert.equal(retained.reconciliationRequired, true);
  assert.equal(retained.auditPlan, undefined);
  assert.equal((await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision })).disposition, "workspace_reconciliation_required");
  assert.equal(counts().creates, 1);
});

test("successful cleanup frees only the workspace slot and retains the terminal record", async () => {
  const { holder, counts } = fixture();
  const first = delivery("run:cleaned");
  await holder.acquire({ delivery: first, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  const cleaned = await holder.cleanup(first);
  assert.equal(cleaned.disposition, "workspace_cleaned");
  assert.equal(cleaned.workspaceCapacityHeld, false);
  assert.equal(cleaned.releasesCapacity, false);
  assert.equal(holder.observation(first.identity.runId)?.disposition, "workspace_cleaned");
  assert.equal((await holder.acquire({ delivery: first, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision })).disposition, "workspace_cleaned");

  await holder.acquire({ delivery: delivery("run:after-cleanup"), repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  assert.deepEqual(counts(), { creates: 2, removes: 1 });
});

test("failed cleanup retains the lease and capacity without claiming task-capacity release", async () => {
  const { holder, counts } = fixture({ failCleanup: true });
  const packet = delivery("run:retained");
  await holder.acquire({ delivery: packet, repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision });
  const retained = await holder.cleanup(packet);
  assert.equal(retained.disposition, "cleanup_retained");
  assert.equal(retained.reconciliationRequired, true);
  assert.equal(retained.workspaceCapacityHeld, true);
  assert.equal(retained.releasesCapacity, false);
  assert.equal(holder.observation(packet.identity.runId)?.disposition, "cleanup_retained");
  await assert.rejects(holder.acquire({ delivery: delivery("run:blocked"), repositoryRoot: "/fixture/repo",
    workspaceRoot: "/fixture/work", revision }), /capacity_exhausted/);
  assert.deepEqual(counts(), { creates: 1, removes: 1 });
});
