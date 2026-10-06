import assert from "node:assert/strict";
import test from "node:test";
import { createWorktreeChangeAuditEvidenceV1, createWorktreeChangeAuditPlanV1,
  createControllerDeliveryWorktreeChangeAuditPlanV1, verifyWorktreeChangeAuditEvidenceV1 } from "../src/harness/v1/worktree-change-audit";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const plan = () => createWorktreeChangeAuditPlanV1({ deliveryDigest: digest("delivery"), worktreeLeaseDigest: digest("lease"),
  baseRevision: "a".repeat(40), allowedPaths: ["src/**", "README.md"], maximumChangedFiles: 3, maximumChangedBytes: 100 });

test("a worktree audit binds a small allowed change set to one delivery and lease", () => {
  const value = createWorktreeChangeAuditEvidenceV1(plan(), { baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40), changes: [
    { path: "README.md", kind: "modified", bytes: 10, contentDigest: digest("readme") },
    { path: "src/worker.ts", kind: "added", bytes: 20, contentDigest: digest("worker") },
  ] });
  const verified = verifyWorktreeChangeAuditEvidenceV1(plan(), value);
  assert.deepEqual(verified.changes.map(change => change.path), ["README.md", "src/worker.ts"]);
  assert.equal(Object.isFrozen(verified.changes), true);
  assert.doesNotMatch(JSON.stringify(verified), /start|approve|execute|retry/i);
});

test("a worktree audit rejects changed revision, duplicate path, unsafe path, and out-of-scope changes", () => {
  const cases = [
    { baseRevision: "b".repeat(40), headRevision: "c".repeat(40), changes: [] },
    { baseRevision: "a".repeat(40), headRevision: "b".repeat(40), changes: [{ path: "README.md", kind: "modified" as const, bytes: 1, contentDigest: digest("a") },
      { path: "README.md", kind: "modified" as const, bytes: 1, contentDigest: digest("b") }] },
    { baseRevision: "a".repeat(40), headRevision: "b".repeat(40), changes: [{ path: "../outside", kind: "added" as const, bytes: 1, contentDigest: digest("a") }] },
    { baseRevision: "a".repeat(40), headRevision: "b".repeat(40), changes: [{ path: "package.json", kind: "modified" as const, bytes: 1, contentDigest: digest("a") }] },
  ];
  for (const value of cases) assert.throws(() => createWorktreeChangeAuditEvidenceV1(plan(), value));
});

test("worktree audit evidence whose top-level head disagrees with the Git head is refused by both the creator and the verifier", () => {
  // The owner is shown git.unifiedDiff and git.headRevision, while publication
  // binds only the top-level headRevision. Evidence must never be able to show
  // the owner one commit's diff while publishing another.
  const first = "b".repeat(40), second = "c".repeat(40);
  const change = { path: "src/worker.ts", kind: "modified" as const, bytes: 20, contentDigest: digest("worker") };
  const gitAt = (headRevision: string) => ({ headRevision, commits: [{ revision: headRevision, subject: "Bounded change" }],
    commitsTruncated: false,
    unifiedDiff: { text: "--- a\n+++ b\n", originalBytes: 10, retainedBytes: 10, truncated: false,
      contentDigest: digest(`diff ${headRevision}`), retainedDigest: digest(`diff ${headRevision}`) },
    confinement: { kind: "workspace_write" as const, outsideWorktree: "refused" as const, evidenceDigest: digest("cage") } });
  // The creator refuses the mixed pair outright.
  assert.throws(() => createWorktreeChangeAuditEvidenceV1(plan(),
    { baseRevision: "a".repeat(40), headRevision: first, changes: [change], git: gitAt(second) }),
  /worktree_change_audit_evidence_out_of_scope/u);
  // The verifier refuses a stored record whose two heads disagree, even when its
  // own self-computed evidenceDigest is intact, so a forged record cannot replay.
  const honest = createWorktreeChangeAuditEvidenceV1(plan(),
    { baseRevision: "a".repeat(40), headRevision: second, changes: [change], git: gitAt(second) });
  assert.equal(honest.headRevision, second);
  assert.throws(() => verifyWorktreeChangeAuditEvidenceV1(plan(), { ...honest, headRevision: first }),
    /worktree_change_audit_evidence_out_of_scope/u);
  assert.throws(() => verifyWorktreeChangeAuditEvidenceV1(plan(), { ...honest, git: gitAt(first) }),
    /worktree_change_audit_evidence_out_of_scope/u);
  // One head with no captured Git diff, and the consistent pair, both still hold.
  assert.equal(createWorktreeChangeAuditEvidenceV1(plan(),
    { baseRevision: "a".repeat(40), headRevision: second, changes: [change] }).headRevision, second);
  assert.equal(verifyWorktreeChangeAuditEvidenceV1(plan(), honest).evidenceDigest, honest.evidenceDigest);
});

test("a future local code task can bind its worktree evidence to the existing controller delivery without exposing paths", () => {
  const delivery = { schema: "control-room.controller-worker-delivery/v1" as const,
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
    worker: { workerId: "worker:test", adapterId: "adapter:test", adapterRevision: "1234567" },
    input: { prompt: "Review a small change", instructions: "Return evidence only" },
    writeScopes: [{ scopeKind: "tree" as const, path: "src" }], authorityDigest: digest("authority"),
    connectorProfileDigest: digest("profile"), acceptanceProfileId: "profile:test", acceptanceProfileDigest: digest("acceptance"),
    issuedAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-20T00:10:00.000Z" };
  const inputDigest = digest(delivery.input);
  const deliveryId = `delivery:${sha256Digest({ identity: delivery.identity, worker: delivery.worker, inputDigest,
    writeScopes: delivery.writeScopes,
    authorityDigest: delivery.authorityDigest, connectorProfileDigest: delivery.connectorProfileDigest,
    acceptanceProfileId: delivery.acceptanceProfileId, acceptanceProfileDigest: delivery.acceptanceProfileDigest,
    issuedAt: delivery.issuedAt, expiresAt: delivery.expiresAt }).slice(7)}`;
  const packet = { ...delivery, inputDigest, deliveryId };
  const deliveryDigest = digest(packet);
  const lease = { deliveryDigest, runId: "run:test", repositoryRealPath: "/private/repository",
    repositoryDevice: "1", repositoryInode: "2", checkoutPath: "/private/work/codex-test",
    revision: "b".repeat(40), device: "1", inode: "3" };
  const leaseId = sha256Digest(lease);
  const audited = createControllerDeliveryWorktreeChangeAuditPlanV1({ delivery: { ...packet, deliveryDigest },
    lease: { ...lease, leaseId }, allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 1024 });
  assert.equal(audited.deliveryDigest, deliveryDigest);
  assert.equal(audited.worktreeLeaseDigest, leaseId);
  assert.equal(audited.baseRevision, lease.revision);
  assert.doesNotMatch(JSON.stringify(audited), /private\/repository|private\/work/);
  const otherLease = { ...lease, runId: "run:other" };
  assert.throws(() => createControllerDeliveryWorktreeChangeAuditPlanV1({ delivery: { ...packet, deliveryDigest },
    lease: { ...otherLease, leaseId: sha256Digest(otherLease) }, allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 1024 }),
  /delivery_lease_mismatch/);
});
