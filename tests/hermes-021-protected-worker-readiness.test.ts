import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  createHermes021MacosProtectedWorkerReadinessV1,
  runHermes021MacosInstallationBoundRunnerQualificationV1 } from "../src/harness/hermes-021-v1";
import { sha256Digest } from "../src/security/canonical-digest";
import { createHermesOwnerQualificationHostFixture, hermesOwnerQualificationConfigurationFixture } from
  "./helpers/hermes-owner-qualification-host";

const route = Object.freeze({ kind: "local" as const, workerId: "worker:marvin",
  adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1 });
const topologyInput = Object.freeze({ databaseAuthorityDigest: sha256Digest("database"),
  schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: Object.freeze([]),
  requestedRoutes: Object.freeze([route]) });
const topologyPlan = planInstallationTopologyV1(topologyInput);
const workerBinding = Object.freeze({ localServiceId: "service:marvin", workerId: route.workerId,
  expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
const runnerConfiguration = hermesOwnerQualificationConfigurationFixture();

test("reviewed path-based runner remains blocked before readiness", async () => {
  const fixture = await createHermesOwnerQualificationHostFixture(runnerConfiguration);
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1({
    installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyPlan, workerBinding,
    runnerConfiguration, reviewedExecutableIdentity: fixture.reviewedExecutableIdentity }, fixture.host),
  /installation_bound_runner_qualification_evidence_unavailable/u);
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1({
    installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyInput, topologyPlan,
    workerBinding, runnerConfiguration, reviewedExecutableIdentity: fixture.reviewedExecutableIdentity,
    runnerQualificationReport: {}, runnerQualificationEvidence: {} }), /protected_worker_readiness_unavailable/u);
});

test("structural qualification evidence cannot substitute for pinned launch", async () => {
  const fixture = await createHermesOwnerQualificationHostFixture(runnerConfiguration);
  const forged = { schema: "control-room.hermes-021-macos-installation-bound-runner-qualification-evidence/v1",
    installationId: "fixture-installation", releaseDigest: sha256Digest("release"),
    topologyPlanDigest: topologyPlan.planDigest, workerBindingDigest: sha256Digest(workerBinding),
    runnerConfigurationDigest: sha256Digest(runnerConfiguration),
    reviewedExecutableIdentityDigest: fixture.reviewedExecutableIdentity.reviewDigest,
    runnerQualificationDigest: sha256Digest("qualification"), evidenceDigest: sha256Digest("forged"),
    startsHermes: false, grantsExecutionAuthority: false };
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1({
    installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyInput, topologyPlan,
    workerBinding, runnerConfiguration, reviewedExecutableIdentity: fixture.reviewedExecutableIdentity,
    runnerQualificationReport: { qualified: true }, runnerQualificationEvidence: forged }),
  /protected_worker_readiness_unavailable/u);
});

test("readiness composition rejects Proxy input without observation", () => {
  let reads = 0;
  const value = new Proxy({}, { get() { reads += 1; return undefined; } });
  assert.throws(() => createHermes021MacosProtectedWorkerReadinessV1(value), /protected_worker_readiness_unavailable/u);
  assert.equal(reads, 0);
});
