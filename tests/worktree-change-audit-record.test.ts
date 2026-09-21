import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createWorktreeChangeAuditEvidenceV1, createWorktreeChangeAuditPlanV1 } from "../src/harness/v1/worktree-change-audit";
import { createWorktreeChangeAuditRecordV1, summarizeWorktreeChangeAuditRecordV1,
  verifyWorktreeChangeAuditRecordV1 } from "../src/harness/v1/worktree-change-audit-record";

const digest = (value: unknown) => sha256Digest(value);
const resultReceipt = () => ({ schema: "control-room.durable-result-receipt/v1", artifactId: `artifact:result:${"b".repeat(64)}`,
  tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", runId: "run:test",
  nodeId: "node:test", harness: "test", contentHash: digest("content"), sizeBytes: 20, manifestDigest: digest("manifest"),
  receivedAt: "2026-09-21T00:00:00.000Z", byteCheck: "matched_recorded_claim", qualityAccepted: false,
  canonicalPublicationAllowed: false, completionVerified: false, releasesCapacity: false, grantsExecutionAuthority: false });
const plan = () => createWorktreeChangeAuditPlanV1({ deliveryDigest: digest("delivery"), worktreeLeaseDigest: digest("lease"),
  baseRevision: "a".repeat(40), allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 100 });
const evidence = () => createWorktreeChangeAuditEvidenceV1(plan(), { baseRevision: "a".repeat(40), changes: [
  { path: "src/one.ts", kind: "added", bytes: 12, contentDigest: digest("one") },
  { path: "src/two.ts", kind: "modified", bytes: 8, contentDigest: digest("two") },
] });
const recordInput = () => ({ identity: { tenantId: "tenant:test", projectId: "project:test",
  jobId: "job:test", attemptId: "attempt:test", runId: "run:test", artifactId: `artifact:result:${"b".repeat(64)}` },
  resultReceipt: resultReceipt(), plan: plan(), evidence: evidence(), recordedAt: "2026-09-21T00:00:00.000Z" });
const record = () => createWorktreeChangeAuditRecordV1(recordInput());

test("a worktree audit record binds one result receipt and produces a private aggregate", () => {
  const value = record(), summary = summarizeWorktreeChangeAuditRecordV1(value);
  assert.deepEqual(summary, { schema: "control-room.worktree-change-audit-summary/v1",
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false,
    permitsResume: false, permitsApproval: false, permitsMerge: false,
    changedFiles: 2, changedBytes: 20,
    addedFiles: 1, modifiedFiles: 1, deletedFiles: 0, evidenceDigest: value.evidence.evidenceDigest });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.plan), true);
  assert.equal(Object.isFrozen(value.evidence.changes[0]), true);
});

test("a worktree audit record rejects altered record fields and nested audit evidence", () => {
  const value = record();
  assert.throws(() => verifyWorktreeChangeAuditRecordV1({ ...value, resultReceiptDigest: digest("other") }), /record_invalid/);
  assert.throws(() => verifyWorktreeChangeAuditRecordV1({ ...value, evidence: { ...value.evidence, evidenceDigest: digest("other") } }), /record_invalid|evidence_invalid/);
});

test("a worktree audit record refuses a receipt from a different durable result", () => {
  const receipt = resultReceipt();
  assert.throws(() => createWorktreeChangeAuditRecordV1({ ...recordInput(), resultReceipt: { ...receipt, runId: "run:other" } }),
    /result_identity_mismatch/);
  assert.throws(() => createWorktreeChangeAuditRecordV1({ ...recordInput(), resultReceipt: { ...receipt,
    artifactId: `artifact:native:${"b".repeat(64)}` } }));
});

test("a worktree audit record requires the complete result identity shape", () => {
  const input = recordInput();
  assert.throws(() => createWorktreeChangeAuditRecordV1({ ...input, identity: { ...input.identity, artifactId: "artifact:other" } }));
  assert.throws(() => createWorktreeChangeAuditRecordV1({ ...input, identity: { ...input.identity, nodeId: "node:test" } }));
});

test("a zero-change audit remains distinct from an omitted audit", () => {
  const empty = createWorktreeChangeAuditEvidenceV1(plan(), { baseRevision: "a".repeat(40), changes: [] });
  const value = createWorktreeChangeAuditRecordV1({ ...recordInput(), plan: plan(), evidence: empty });
  assert.equal(summarizeWorktreeChangeAuditRecordV1(value).changedFiles, 0);
  assert.throws(() => createWorktreeChangeAuditRecordV1({ ...recordInput(), evidence: undefined }));
});

test("the browser aggregate recursively excludes private worktree evidence", () => {
  const serialized = JSON.stringify(summarizeWorktreeChangeAuditRecordV1(record()));
  for (const forbidden of ["src/one.ts", "src/**", "a".repeat(40), "worktreeLeaseDigest", "contentDigest", "resultReceiptDigest"])
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
