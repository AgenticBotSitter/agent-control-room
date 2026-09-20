import assert from "node:assert/strict";
import test from "node:test";
import { localHarnessCapabilitiesV1, summarizeLocalHarnessCapabilitiesV1 } from "../src/harness/v1/local-harness-capabilities";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { sha256Digest } from "../src/security/canonical-digest";

test("local harness capabilities are truthful, bounded and installation-safe", () => {
  assert.deepEqual(localHarnessCapabilitiesV1.map(value => value.id), ["hermes", "claude", "codex"]);
  const hermes = localHarnessCapabilitiesV1.find(value => value.id === "hermes")!;
  const claude = localHarnessCapabilitiesV1.find(value => value.id === "claude")!;
  const codex = localHarnessCapabilitiesV1.find(value => value.id === "codex")!;
  assert.equal(hermes.state, "setup_required");
  assert.equal(hermes.operations.submit, "unknown");
  assert.match(hermes.firstSupportedWork, /plain-text review/);
  assert.match(hermes.firstSupportedWork, /cannot edit a project yet/);
  assert.equal(claude.state, "setup_required");
  assert.equal(claude.operations.submit, "unsupported");
  assert.equal(codex.state, "not_available");
  assert.equal(codex.operations.submit, "unsupported");
  const rendered = JSON.stringify(localHarnessCapabilitiesV1);
  assert.doesNotMatch(rendered, /\/Users\/|https?:\/\/|(?:token|password|profile)\s*[=:]/i);
});

test("local Hermes proof completion is honest about the separate enablement decision", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" }] });
  const ready = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("backup") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("qualification") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("bridge") },
  ] });
  const hermes = summarizeLocalHarnessCapabilitiesV1(plan, ready).find(value => value.id === "hermes")!;
  assert.equal(hermes.state, "owner_enablement_required");
  assert.match(hermes.stateLabel, /owner enablement/);
  assert.match(hermes.summary, /still has not started Hermes/);
});
