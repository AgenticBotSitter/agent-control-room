import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { projectTwoLocalWorkerActivationPreflightV1,
  verifyTwoLocalWorkerActivationPreflightV1 } from "../src/installer/v1/two-local-worker-activation-preflight";

const planDigest = sha256Digest("local-claude-plan");
const completeClaudeReadiness = () => createClaudeCodeLocalProcessReadinessV1({ planDigest, proofs: [
  { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("identity") },
  { proof: "permission_boundary", state: "passed", evidenceDigest: sha256Digest("policy") },
  { proof: "cancellation_and_restart_recovery", state: "passed", evidenceDigest: sha256Digest("recovery") },
] });

function rebound(value: Record<string, unknown>) {
  const { preflightDigest: _ignored, ...material } = value;
  return { ...value, preflightDigest: sha256Digest(material) };
}

test("two-local projection reports only the exact missing local prerequisites", () => {
  const preflight = projectTwoLocalWorkerActivationPreflightV1({});
  assert.equal(preflight.status, "missing_local_proof");
  assert.deepEqual(preflight.workers, [
    { worker: "hermes", prerequisite: "hermes_qualification_record", status: "missing_local_proof" },
    { worker: "claude", prerequisite: "claude_process_readiness", status: "missing_local_proof" },
  ]);
  assert.equal(preflight.performsEffect, false);
  assert.equal(preflight.startsService, false);
  assert.equal(preflight.startsWorker, false);
  assert.equal(preflight.invokesAgent, false);
  assert.doesNotMatch(JSON.stringify(preflight), /password|\/Users\/|postgresql:\/\//iu);
});

test("two-local projection distinguishes a prepared Claude record from a missing Hermes record", () => {
  const readiness = completeClaudeReadiness();
  const preflight = projectTwoLocalWorkerActivationPreflightV1({ claude: { readiness, planDigest } });
  assert.equal(preflight.status, "missing_local_proof");
  assert.deepEqual(preflight.workers[0],
    { worker: "hermes", prerequisite: "hermes_qualification_record", status: "missing_local_proof" });
  assert.deepEqual(preflight.workers[1], { worker: "claude", prerequisite: "claude_process_readiness",
    status: "prepared", evidenceDigest: readiness.readinessDigest });
});

test("incomplete, mismatched, or tampered local evidence cannot appear prepared", () => {
  const incomplete = createClaudeCodeLocalProcessReadinessV1({ planDigest, proofs: [
    { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("identity") },
  ] });
  assert.equal(projectTwoLocalWorkerActivationPreflightV1({ claude: { readiness: incomplete, planDigest } })
    .workers[1]?.status, "missing_local_proof");
  const readiness = completeClaudeReadiness();
  assert.throws(() => projectTwoLocalWorkerActivationPreflightV1({ claude: { readiness, planDigest: sha256Digest("other") } }),
    /two_local_worker_activation_preflight_unavailable/u);
  const preflight = projectTwoLocalWorkerActivationPreflightV1({ claude: { readiness, planDigest } });
  assert.throws(() => verifyTwoLocalWorkerActivationPreflightV1({ ...preflight, preflightDigest: sha256Digest("changed") }),
    /two_local_worker_activation_preflight_unavailable/u);
});

test("verification rejects a rehashed duplicate or contradictory worker projection", () => {
  const preflight = projectTwoLocalWorkerActivationPreflightV1({});
  const duplicate = rebound({ ...preflight, status: "prepared", workers: [
    { worker: "claude", prerequisite: "hermes_qualification_record", status: "prepared", evidenceDigest: sha256Digest("one") },
    { worker: "claude", prerequisite: "hermes_qualification_record", status: "prepared", evidenceDigest: sha256Digest("two") },
  ] });
  assert.throws(() => verifyTwoLocalWorkerActivationPreflightV1(duplicate), /unavailable/u);

  const noEvidence = rebound({ ...preflight, workers: [
    { worker: "hermes", prerequisite: "hermes_qualification_record", status: "prepared" },
    { worker: "claude", prerequisite: "claude_process_readiness", status: "missing_local_proof" },
  ] });
  assert.throws(() => verifyTwoLocalWorkerActivationPreflightV1(noEvidence), /unavailable/u);

  const wrongAggregate = rebound({ ...preflight, status: "prepared" });
  assert.throws(() => verifyTwoLocalWorkerActivationPreflightV1(wrongAggregate), /unavailable/u);
});
