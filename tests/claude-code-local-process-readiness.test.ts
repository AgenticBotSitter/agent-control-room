import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeCodeLocalProcessReadinessV1, summarizeClaudeCodeLocalProcessReadinessV1,
  verifyClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

const planDigest = sha256Digest("installation-plan");

test("Claude local-process readiness keeps only opaque plan-bound proof status", () => {
  const readiness = createClaudeCodeLocalProcessReadinessV1({ planDigest, proofs: [
    { proof: "permission_boundary", state: "passed", evidenceDigest: sha256Digest("permission") },
    { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("identity") },
    { proof: "cancellation_and_restart_recovery", state: "passed", evidenceDigest: sha256Digest("recovery") },
  ] });
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(planDigest, readiness).state, "readiness_recorded");
  assert.throws(() => summarizeClaudeCodeLocalProcessReadinessV1(sha256Digest("other-plan"), readiness), /plan_mismatch/);
  assert.throws(() => verifyClaudeCodeLocalProcessReadinessV1({ ...readiness, readinessDigest: sha256Digest("changed") }));
});

test("Claude local-process readiness retains settled evidence but never lets incomplete or fabricated evidence appear complete", () => {
  const pending = createClaudeCodeLocalProcessReadinessV1({ planDigest, proofs: [
    { proof: "installed_process_identity", state: "not_started" },
  ] });
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(planDigest, pending).state, "not_started");
  assert.throws(() => createClaudeCodeLocalProcessReadinessV1({ planDigest,
    proofs: [{ proof: "permission_boundary", state: "passed" }] }));
  assert.throws(() => createClaudeCodeLocalProcessReadinessV1({ planDigest,
    proofs: [{ proof: "permission_boundary", state: "failed" }] }));
  assert.throws(() => createClaudeCodeLocalProcessReadinessV1({ planDigest,
    proofs: [{ proof: "permission_boundary", state: "not_started", evidenceDigest: sha256Digest("should-not-exist") }] }));
  assert.throws(() => createClaudeCodeLocalProcessReadinessV1({ planDigest,
    proofs: [{ proof: "permission_boundary", state: "unavailable", evidenceDigest: sha256Digest("should-not-exist") }] }));
});

test("a failed proof retains its opaque digest and keeps Claude readiness blocked", () => {
  const evidenceDigest = sha256Digest("owner-attended-qualification-failure");
  const readiness = createClaudeCodeLocalProcessReadinessV1({ planDigest, proofs: [
    { proof: "installed_process_identity", state: "failed", evidenceDigest },
  ] });
  assert.equal(readiness.proofs[0]?.evidenceDigest, evidenceDigest);
  assert.equal(verifyClaudeCodeLocalProcessReadinessV1(readiness).proofs[0]?.evidenceDigest, evidenceDigest);
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(planDigest, readiness).state, "blocked");
});
