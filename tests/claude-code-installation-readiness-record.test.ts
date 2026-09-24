import assert from "node:assert/strict";
import test from "node:test";
import { recordClaudeCodeLocalQualificationReadinessV1 } from
  "../src/harness/claude-code-v1/installation-readiness-record";
import { createClaudeCodeLocalProcessReadinessV1,
  summarizeClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from
  "../src/harness/claude-code-v1/text-review-invocation-policy";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";

const hermes = { kind: "local" as const, workerId: "worker:marvin",
  adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" };
const claude = { kind: "local" as const, workerId: "worker:claude",
  adapterId: "connector:claude-code-local-v1", adapterRevision: "0000001" };
const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
  schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [hermes], requestedRoutes: [hermes, claude] });
const report = { schema: "control-room.claude-code-text-review-qualification-report/v1" as const,
  qualified: true, fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  executableSha256: sha256Digest("claude-executable"), workingDirectoryBindingDigest: sha256Digest("workspace"),
  supervisedRouteDigest: sha256Digest("supervised-route"),
  terminalResultObserved: true, terminalResultDigest: sha256Digest("result"), inputTokens: 10, outputTokens: 4,
  totalTokens: 14, durationMs: 250, failureReason: "none" as const, retryRequiresFreshOwnerAuthorization: false,
  startsWork: false as const, grantsExecutionAuthority: false as const };

test("Claude qualification records process identity and permission proof but not restart recovery", () => {
  const recorded = recordClaudeCodeLocalQualificationReadinessV1(plan, report);
  assert.deepEqual(recorded.proofs.map(item => [item.proof, item.state]), [
    ["cancellation_and_restart_recovery", "not_started"],
    ["installed_process_identity", "passed"],
    ["permission_boundary", "passed"],
  ]);
  const summary = summarizeClaudeCodeLocalProcessReadinessV1(plan.planDigest, recorded);
  assert.equal(summary.state, "not_started");
  assert.equal(summary.nextProof, "cancellation_and_restart_recovery");
  assert.equal(recorded.proofs[1]?.evidenceDigest, recorded.proofs[2]?.evidenceDigest);
});

function previouslyReady() {
  const qualified = recordClaudeCodeLocalQualificationReadinessV1(plan, report);
  return createClaudeCodeLocalProcessReadinessV1({ planDigest: plan.planDigest,
    proofs: qualified.proofs.map(item => item.proof === "cancellation_and_restart_recovery"
      ? { proof: item.proof, state: "passed" as const, evidenceDigest: sha256Digest("recovery") }
      : item) });
}

test("successful requalification cannot preserve a previously passed restart proof", () => {
  const recorded = recordClaudeCodeLocalQualificationReadinessV1(plan, { ...report,
    executableSha256: sha256Digest("replacement-claude-executable"),
    workingDirectoryBindingDigest: sha256Digest("replacement-workspace") }, previouslyReady());
  assert.deepEqual(recorded.proofs.find(item => item.proof === "cancellation_and_restart_recovery"),
    { proof: "cancellation_and_restart_recovery", state: "not_started" });
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(plan.planDigest, recorded).state, "not_started");
});

test("failed requalification cannot preserve a previously passed restart proof", () => {
  const failed = { ...report, qualified: false, executableSha256: sha256Digest("missing-claude-executable"),
    workingDirectoryBindingDigest: sha256Digest("replacement-workspace"), terminalResultObserved: false,
    terminalResultDigest: null, inputTokens: null, outputTokens: null, totalTokens: null, durationMs: null,
    failureReason: "installed_process_unavailable" as const, retryRequiresFreshOwnerAuthorization: true };
  const recorded = recordClaudeCodeLocalQualificationReadinessV1(plan, failed, previouslyReady());
  assert.deepEqual(recorded.proofs.find(item => item.proof === "cancellation_and_restart_recovery"),
    { proof: "cancellation_and_restart_recovery", state: "not_started" });
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(plan.planDigest, recorded).state, "blocked");
});

test("failed qualification becomes blocked evidence and wrong plans refuse", () => {
  const failed = { ...report, qualified: false, terminalResultObserved: false, terminalResultDigest: null,
    inputTokens: null, outputTokens: null, totalTokens: null, durationMs: null,
    failureReason: "installed_process_unavailable" as const, retryRequiresFreshOwnerAuthorization: true };
  const recorded = recordClaudeCodeLocalQualificationReadinessV1(plan, failed);
  assert.equal(summarizeClaudeCodeLocalProcessReadinessV1(plan.planDigest, recorded).state, "blocked");
  assert.equal(recorded.proofs.find(item => item.proof === "installed_process_identity")?.state, "failed");
  const hermesOnly = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [hermes], requestedRoutes: [hermes] });
  assert.throws(() => recordClaudeCodeLocalQualificationReadinessV1(hermesOnly, report),
    /claude_code_local_installation_readiness_unavailable/);
  assert.throws(() => recordClaudeCodeLocalQualificationReadinessV1(plan, { ...report,
    fixedInvocationPolicyDigest: sha256Digest("changed") }), /claude_code_local_installation_readiness_unavailable/);
});
