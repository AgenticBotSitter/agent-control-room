import assert from "node:assert/strict";
import test from "node:test";
import { guideInstallationReadinessV1 } from "../src/harness/v1/installation-guidance";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";

const route = { kind: "local" as const, workerId: "worker:private", adapterId: "connector:private", adapterRevision: "00570550" };
const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
  currentRoutes: [route], requestedRoutes: [route] });

test("local guidance follows the proof order without exposing worker details", () => {
  const first = guideInstallationReadinessV1(plan);
  assert.equal(first[0]?.proof, "backup_restore");
  const textDone = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("backup") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("text") },
  ] });
  const next = guideInstallationReadinessV1(plan, textDone);
  assert.equal(next[0]?.proof, "local_runner_bridge");
  assert.match(next[0]?.detail ?? "", /no-agent preflight/);
  assert.doesNotMatch(JSON.stringify(next), /worker:private|connector:private|sha256:/);
});

test("complete and failed setup states remain honest and offer no enablement action", () => {
  const complete = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("backup") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("text") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("runner") },
  ] });
  const completeSteps = guideInstallationReadinessV1(plan, complete);
  assert.equal(completeSteps[0]?.state, "complete");
  assert.match(completeSteps[0]?.detail ?? "", /cannot enable a worker/);
  const failed = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "failed" },
  ] });
  assert.equal(guideInstallationReadinessV1(plan, failed)[0]?.state, "blocked");
});
