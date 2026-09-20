import assert from "node:assert/strict";
import test from "node:test";
import { createWorktreeChangeAuditEvidenceV1, createWorktreeChangeAuditPlanV1,
  verifyWorktreeChangeAuditEvidenceV1 } from "../src/harness/v1/worktree-change-audit";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const plan = () => createWorktreeChangeAuditPlanV1({ deliveryDigest: digest("delivery"), worktreeLeaseDigest: digest("lease"),
  baseRevision: "a".repeat(40), allowedPaths: ["src/**", "README.md"], maximumChangedFiles: 3, maximumChangedBytes: 100 });

test("a worktree audit binds a small allowed change set to one delivery and lease", () => {
  const value = createWorktreeChangeAuditEvidenceV1(plan(), { baseRevision: "a".repeat(40), changes: [
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
    { baseRevision: "b".repeat(40), changes: [] },
    { baseRevision: "a".repeat(40), changes: [{ path: "README.md", kind: "modified" as const, bytes: 1, contentDigest: digest("a") },
      { path: "README.md", kind: "modified" as const, bytes: 1, contentDigest: digest("b") }] },
    { baseRevision: "a".repeat(40), changes: [{ path: "../outside", kind: "added" as const, bytes: 1, contentDigest: digest("a") }] },
    { baseRevision: "a".repeat(40), changes: [{ path: "package.json", kind: "modified" as const, bytes: 1, contentDigest: digest("a") }] },
  ];
  for (const value of cases) assert.throws(() => createWorktreeChangeAuditEvidenceV1(plan(), value));
});
