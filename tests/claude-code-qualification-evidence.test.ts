import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_EVIDENCE_V1,
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_FAILURE_EVIDENCE_V1,
  CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  claudeCodeTextReviewQualificationReportSchemaV1,
  createClaudeCodeTextReviewQualificationEvidenceV1,
  createClaudeCodeTextReviewQualificationFailureEvidenceV1,
} from "../src/harness/claude-code-v1";
import { createClaudeCodeLocalProcessReadinessV1, summarizeClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

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

const failedReport = {
  schema: CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_REPORT_V1,
  qualified: false,
  fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  terminalResultObserved: false,
  terminalResultDigest: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  durationMs: null,
  failureReason: "installed_process_unavailable" as const,
  retryRequiresFreshOwnerAuthorization: true,
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

test("a failed owner-run Claude check is retained only as opaque blocked evidence", () => {
  const evidence = createClaudeCodeTextReviewQualificationFailureEvidenceV1(failedReport);
  assert.deepEqual(evidence, createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport }));
  assert.deepEqual(Object.keys(evidence).sort(), ["evidenceDigest", "grantsExecutionAuthority",
    "retryRequiresFreshOwnerAuthorization", "schema", "state"]);
  assert.equal(evidence.schema, CLAUDE_CODE_TEXT_REVIEW_QUALIFICATION_FAILURE_EVIDENCE_V1);
  assert.equal(evidence.state, "failed");
  assert.equal(evidence.grantsExecutionAuthority, false);
  assert.equal(evidence.retryRequiresFreshOwnerAuthorization, true);
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(evidence), /installed_process_unavailable|token|terminal|prompt|output|input/i);
  const readiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: sha256Digest("claude-failed-qualification"), proofs: [
    { proof: "installed_process_identity", state: "failed", evidenceDigest: evidence.evidenceDigest },
  ] });
  assert.equal(readiness.proofs[0]?.evidenceDigest, evidence.evidenceDigest);
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(readiness.planDigest, readiness).state, "blocked");
});

test("failed Claude qualification evidence rejects unsafe failure data and changes when accepted data changes", () => {
  assert.throws(() => createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport, qualified: true }));
  assert.throws(() => createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport, failureReason: "none" }));
  assert.throws(() => createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport,
    retryRequiresFreshOwnerAuthorization: false }));
  assert.throws(() => createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport,
    terminalResultObserved: true }));
  assert.notEqual(createClaudeCodeTextReviewQualificationFailureEvidenceV1(failedReport).evidenceDigest,
    createClaudeCodeTextReviewQualificationFailureEvidenceV1({ ...failedReport,
      failureReason: "fixed_invocation_refused" }).evidenceDigest);
});
