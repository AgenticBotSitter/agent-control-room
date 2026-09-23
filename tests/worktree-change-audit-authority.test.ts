import assert from "node:assert/strict";
import test from "node:test";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { createManagedWorktreeChangeAuditAuthorityV1 } from "../src/harness/v1/worktree-change-audit-authority";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security";

const revision = "a".repeat(40);
const delivery = (runId = "run:audited") => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:one", projectId: "project:one", jobId: "job:one", attemptId: "attempt:one", runId, nodeId: "node:one" },
  worker: { workerId: "worker:one", adapterId: "connector:test", adapterRevision: "0000001" },
  input: { prompt: "Review this bounded change.", instructions: "Return evidence only." },
  authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("profile"),
  acceptanceProfileId: "profile:one", acceptanceProfileDigest: sha256Digest("acceptance"),
  issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:10:00.000Z",
});

function manager() {
  return new CodexWorkspaceManagerV1({
    inspectExisting: async path => ({ realPath: path, device: "1",
      inode: path === "/fixture/repo" ? "2" : path === "/fixture/work" ? "3" : "4" }),
    createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision: headRevision }) => ({
      realPath: checkoutPath, repositoryRealPath, headRevision, device: "1", inode: "4" }),
    removeWorktree: async () => {},
  });
}

test("only the manager-owned active lease can derive a fixed-policy change-audit plan", async () => {
  const workspace = manager();
  const lease = await workspace.prepare({ runId: "run:audited", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 2048 });
  const plan = authority.derive({ delivery: delivery(), lease });
  assert.deepEqual(plan.allowedPaths, ["src/**"]);
  assert.equal(plan.maximumChangedFiles, 2);
  assert.equal(plan.maximumChangedBytes, 2048);
  assert.equal(plan.baseRevision, revision);

  await workspace.cleanup(lease);
  assert.throws(() => authority.derive({ delivery: delivery(), lease }), /not active/);
});

test("a structurally valid, self-computed lease cannot substitute for a manager lease", async () => {
  const workspace = manager();
  const lease = await workspace.prepare({ runId: "run:audited", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 2048 });
  const forged = { ...lease, checkoutPath: "/fixture/work/codex-aaaaaaaaaaaaaaaaaaaaaaaa", inode: "99" };
  forged.leaseId = sha256Digest({ runId: forged.runId, repositoryRealPath: forged.repositoryRealPath,
    checkoutPath: forged.checkoutPath, revision: forged.revision, device: forged.device, inode: forged.inode });
  assert.throws(() => authority.derive({ delivery: delivery(), lease: forged }), /not active/);
});

test("the authority refuses a packet for another run before it can create a plan", async () => {
  const workspace = manager();
  const lease = await workspace.prepare({ runId: "run:audited", repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 2048 });
  assert.throws(() => authority.derive({ delivery: delivery("run:other"), lease }), /delivery_lease_mismatch/);
});
