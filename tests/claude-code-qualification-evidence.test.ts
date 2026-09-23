import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1,
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  claudeCodeTextReviewQualificationReportSchemaV1,
  createClaudeCodeTextReviewQualificationEvidenceV1,
} from "../src/harness/claude-code-v1";

const digest = `sha256:${"a".repeat(64)}`;
const report = {
  schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  qualified: true,
  fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  terminalResultObserved: true,
  terminalResultDigest: digest,
  inputTokens: 9,
  outputTokens: 7,
  totalTokens: 16,
  durationMs: 120,
  failureReason: "none" as const,
  retryRequiresFreshOwnerAuthorization: false,
  startsWork: false as const,
  grantsExecutionAuthority: false as const,
};

test("a successful owner-run Claude check becomes a stable non-authorizing evidence digest", () => {
  const evidence = createClaudeCodeTextReviewQualificationEvidenceV1(report);
  assert.equal(evidence.schema, CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1);
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence, createClaudeCodeTextReviewQualificationEvidenceV1({ ...report }));
  assert.notEqual(evidence.evidenceDigest, createClaudeCodeTextReviewQualificationEvidenceV1({ ...report,
    durationMs: 121 }).evidenceDigest);
});

test("qualification evidence rejects incomplete, broadened, or retryable reports", () => {
  assert.throws(() => createClaudeCodeTextReviewQualificationEvidenceV1({ ...report, qualified: false }));
  assert.throws(() => createClaudeCodeTextReviewQualificationEvidenceV1({ ...report, terminalResultDigest: null }));
  assert.throws(() => createClaudeCodeTextReviewQualificationEvidenceV1({ ...report, totalTokens: 15 }));
  assert.throws(() => createClaudeCodeTextReviewQualificationEvidenceV1({ ...report, retryRequiresFreshOwnerAuthorization: true }));
  assert.equal(claudeCodeTextReviewQualificationReportSchemaV1.safeParse({ ...report,
    fixedInvocationPolicyDigest: digest }).success, false);
  assert.equal(claudeCodeTextReviewQualificationReportSchemaV1.safeParse({ ...report,
    startsWork: true }).success, false);
});
