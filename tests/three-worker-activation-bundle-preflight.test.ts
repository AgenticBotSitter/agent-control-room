import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  createHermes021MacosProtectedWorkerReadinessV1,
  runHermes021MacosInstallationBoundRunnerQualificationV1 } from "../src/harness/hermes-021-v1";
import { sha256Digest } from "../src/security/canonical-digest";
import { composeThreeWorkerActivationBundlePreflightV1, createThreeWorkerActivationBundleCustodyV1,
  recordHermesThreeWorkerActivationSourceProofV1, refreshThreeWorkerActivationBundlePreflightV1,
  verifyThreeWorkerActivationBundlePreflightV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";
import { createHermesOwnerQualificationHostFixture } from "./helpers/hermes-owner-qualification-host";

const d = (value: string) => sha256Digest(value);
const route = Object.freeze({ kind: "local" as const, workerId: "worker:marvin",
  adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1 });
const topologyInput = Object.freeze({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: Object.freeze([]), requestedRoutes: Object.freeze([route]) });
const topologyPlan = planInstallationTopologyV1(topologyInput);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: topologyPlan.planDigest });

async function hermesSource() {
  const workerBinding = Object.freeze({ localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
  const runnerConfiguration = Object.freeze({ executablePath: "/private/fixture/hermes", profile: "owner-profile-private",
    model: "qwen3.8:27b-long", provider: "ollama", workingDirectory: "/private/fixture/work",
    taskClass: "text_review" as const, maximumTurns: 1 as const, maximumRunBudgetSeconds: 120 });
  const fixture = createHermesOwnerQualificationHostFixture(runnerConfiguration);
  const qualified = await runHermes021MacosInstallationBoundRunnerQualificationV1({
    installationId: binding.installationId, releaseDigest: binding.releaseDigest, topologyPlan, workerBinding,
    runnerConfiguration }, fixture.host);
  fixture.close();
  const currentInput = { installationId: binding.installationId, releaseDigest: binding.releaseDigest,
    topologyInput, topologyPlan, workerBinding, runnerConfiguration,
    runnerQualificationReport: qualified.report, runnerQualificationEvidence: qualified.evidence };
  return { currentInput, readiness: createHermes021MacosProtectedWorkerReadinessV1(currentInput) };
}

test("custody alone cannot manufacture ready evidence or rollback", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  assert.deepEqual(Object.keys(custody).sort(), ["aggregate", "providesGenericEvidenceIssuer",
    "providesRollbackRecorder", "schema"]);
  assert.equal(custody.providesGenericEvidenceIssuer, false);
  assert.equal(custody.providesRollbackRecorder, false);
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.components.filter(item => item.blocker === "source_proof_missing").length, 6);
  assert.deepEqual(plan.rollback.missing, ["release_rollback", "database_snapshot", "private_route_snapshot",
    "website_route_snapshot", "protected_configuration_prior_state"]);
  assert.deepEqual(plan.ownerActions, []);
  for (const name of ["performsEffect", "readsProtectedFiles", "writesProtectedFiles", "opensDatabase", "usesNetwork",
    "startsService", "startsWorker", "invokesAgent", "accessesCredentialStore", "accessesKeychain"] as const)
    assert.equal(plan[name], false);
  assert.doesNotMatch(JSON.stringify(plan), /password|\/Users\/|postgresql:\/\/|100\.\d+\.\d+\.\d+/iu);
});

test("structural or caller-digest proof cannot leave blocked state", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate,
    sourceProofs: [{ schema: "control-room.three-worker-activation-source-proof/v1",
      component: "verified_release", state: "ready", evidenceDigest: d("forged") }] }), /preflight_refused/u);
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  assert.equal(plan.status, "blocked");
});

test("real Hermes producer proof updates only Hermes and invalidates old aggregate generation", async () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const first = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  const source = await hermesSource();
  const hermesProof = recordHermesThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate, ...source });
  const refreshed = refreshThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate,
    current: first, sourceProofs: [hermesProof] });
  assert.equal(refreshed.kind, "invalidated");
  assert.equal(refreshed.plan.generation, 2);
  assert.equal(refreshed.plan.status, "blocked");
  assert.deepEqual(refreshed.plan.ownerActions, ["approve_hermes_first_task"]);
  assert.equal(refreshed.plan.components.find(item => item.component === "hermes_route")?.state,
    "owner_attended_action");
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(custody.aggregate, first), /preflight_refused/u);
  assert.deepEqual(verifyThreeWorkerActivationBundlePreflightV1(custody.aggregate, refreshed.plan), refreshed.plan);
});

test("Hermes proof refuses a different aggregate binding", async () => {
  const source = await hermesSource();
  const custody = createThreeWorkerActivationBundleCustodyV1({ ...binding, releaseDigest: d("other-release") });
  assert.throws(() => recordHermesThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate, ...source }),
    /preflight_refused|readiness_unavailable/u);
});

test("exact replay stays current and output tampering refuses", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const first = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  const replay = refreshThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate, current: first });
  assert.equal(replay.kind, "replay"); assert.equal(replay.plan.generation, 1);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(custody.aggregate,
    { ...first, planDigest: d("tampered") }), /preflight_refused/u);
});
