import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSupervisorReadinessV1, summarizeLocalSupervisorReadinessV1,
  verifyLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

const planDigest = sha256Digest("installation-plan");

test("local supervisor readiness keeps only opaque plan-bound proof status", () => {
  const readiness = createLocalSupervisorReadinessV1({ planDigest, proofs: [
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("launch") },
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("custody") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("rollback") },
  ] });
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(summarizeLocalSupervisorReadinessV1(planDigest, readiness).state, "readiness_recorded");
  assert.throws(() => summarizeLocalSupervisorReadinessV1(sha256Digest("other-plan"), readiness), /plan_mismatch/);
  assert.throws(() => verifyLocalSupervisorReadinessV1({ ...readiness, readinessDigest: sha256Digest("changed") }));
  assert.doesNotMatch(JSON.stringify(readiness), /(?:path|launchd|systemd|token|password|credential)\s*[=:]/i);
});

test("local supervisor readiness never lets partial or fabricated evidence appear complete", () => {
  const pending = createLocalSupervisorReadinessV1({ planDigest, proofs: [
    { proof: "private_configuration_custody", state: "not_started" },
  ] });
  assert.equal(summarizeLocalSupervisorReadinessV1(planDigest, pending).state, "not_started");
  assert.throws(() => createLocalSupervisorReadinessV1({ planDigest,
    proofs: [{ proof: "restricted_launch_definition", state: "passed" }] }));
  assert.throws(() => createLocalSupervisorReadinessV1({ planDigest,
    proofs: [{ proof: "restart_and_drain_procedure", state: "failed", evidenceDigest: sha256Digest("must-not-exist") }] }));
});
