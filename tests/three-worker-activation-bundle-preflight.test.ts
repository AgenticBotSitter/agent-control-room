import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  runHermes021MacosInstallationBoundRunnerQualificationV1 } from "../src/harness/hermes-021-v1";
import { sha256Digest } from "../src/security/canonical-digest";
import { composeThreeWorkerActivationBundlePreflightV1, createThreeWorkerActivationBundleCustodyV1,
  recordProtectedConfigurationThreeWorkerActivationSourceProofV1, refreshThreeWorkerActivationBundlePreflightV1,
  recordVerifiedReleaseThreeWorkerActivationSourceProofV1,
  verifyThreeWorkerActivationBundlePreflightV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";
import { prepareLocalInstallationReleaseV1 } from "../src/installer/v1/local-installation-release.mjs";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";
import { PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1,
  preparePrivateInstalledConfigurationV1, privateInstalledPostgresEndpointFingerprintV1 } from
  "../src/installer/v1/private-installed-configuration-preparation";
import { PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
import { PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 } from
  "../src/installer/v1/private-installed-local-hermes-runtime-composer";
import { createHermesOwnerQualificationHostFixture, hermesOwnerQualificationConfigurationFixture } from
  "./helpers/hermes-owner-qualification-host";

const d = (value: string) => sha256Digest(value);
const route = Object.freeze({ kind: "local" as const, workerId: "worker:marvin",
  adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1 });
const topologyInput = Object.freeze({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: Object.freeze([]), requestedRoutes: Object.freeze([route]) });
const topologyPlan = planInstallationTopologyV1(topologyInput);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: topologyPlan.planDigest });

async function releaseSource() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-activation-release-")));
  const releaseDirectory = join(root, "release"), installRoot = join(root, "install");
  await mkdir(installRoot, { mode: 0o700 });
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
  const placement = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot });
  const releaseRoot = join(installRoot, "versions", placement.version);
  const fingerprint = await prepareLocalInstallationReleaseV1({ releaseRoot });
  const releasePreparation = await prepareLocalInstallationReleaseV1({ releaseRoot,
    expectedDigest: fingerprint.bundle.digest });
  return { root, fingerprint, releasePreparation };
}

function protectedConfigurationSource() {
  const endpoint = { host: "private-authority.invalid", port: 5432, database: "control_room" as const,
    majorVersion: 17 as const };
  const databaseAuthority = { provider: "postgresql" as const, majorVersion: 17 as const,
    database: "control_room" as const, networkClass: "private_network" as const,
    databaseAuthorityDigest: topologyInput.databaseAuthorityDigest, targetIdentityDigest: d("database-target"),
    endpointFingerprint: privateInstalledPostgresEndpointFingerprintV1(endpoint),
    credentialReferenceFingerprint: d("credential-reference"), privateRouteEvidenceDigest: d("private-route") };
  const nativeSidecar = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "1.2.3", portableReleaseManifestSha256: binding.releaseDigest,
    outerLauncherManifestSha256: d("outer"), sidecarManifestSha256: d("sidecar"),
    archiveSha256: d("archive"), artifactManifestSha256: d("artifact"), executableSha256: d("executable"),
    platform: "darwin" as const, protocol: "ACRJNL1" as const, architecture: "arm64" as const };
  const privateConfigurationData = { schema: PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1,
    installationId: binding.installationId, releaseDigest: binding.releaseDigest,
    installedManifestBindingDigest: d("installed-binding"), runtimeIdentityDigest: d("runtime"),
    prerequisiteInput: { installationId: binding.installationId, topologyPlan, releaseDigest: binding.releaseDigest,
      releasePreflight: { evidenceDigest: d("release-preflight") },
      privatePlacement: { evidenceDigest: d("private-placement") } },
    settledInstallationPlan: { schema: "control-room.installation-plan/v1", digest: d("plan") },
    hermes: { runnerConfiguration: { executablePath: "/private/owner-held/hermes",
      workingDirectory: "/private/owner-held/workspace", profile: "cr", model: "owner-model",
      provider: "owner-provider" }, taskPolicy: { taskClass: "text_review", tools: "none" } },
    operator: { port: 3210, templateId: "template:hermes-text-review" },
    database: { ...endpoint, roles: { web: "control_room_web", coordinator: "control_room_coordinator",
      results: "control_room_results", evidence: "control_room_evidence", queueWorker: "control_room_queue_worker" },
    queueConcurrency: 1 }, artifactStorage: { local: { rootPath: "/private/owner-held/results" },
      inventory: { storageNamespaceDigest: d("storage") } }, setupSources: {
      database_authority: { targetIdentityDigest: databaseAuthority.targetIdentityDigest },
      agent_readiness: { schema: "control-room.private-installed-local-hermes-agent-source/v1" } } };
  return preparePrivateInstalledConfigurationV1({ schema: PRIVATE_INSTALLED_CONFIGURATION_PREPARATION_V1,
    installationId: binding.installationId, releaseDigest: binding.releaseDigest,
    standardProtectedRootPath: "/Users/example-owner/Library/Application Support/Agent Control Room/Protected",
    expectedOwnerUid: 501, privateConfigurationData, nativeSidecar, databaseAuthority,
    verificationDeadlineMs: 5_000 });
}

async function assertHermesPinnedLaunchBlocked() {
  const workerBinding = Object.freeze({ localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
  const runnerConfiguration = hermesOwnerQualificationConfigurationFixture({ profile: "owner-profile-private",
    model: "qwen3.8:27b-long", provider: "ollama" });
  const fixture = await createHermesOwnerQualificationHostFixture(runnerConfiguration);
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1({
    installationId: binding.installationId, releaseDigest: binding.releaseDigest, topologyPlan, workerBinding,
    runnerConfiguration, reviewedExecutableIdentity: fixture.reviewedExecutableIdentity }, fixture.host),
  /installation_bound_runner_qualification_evidence_unavailable/u);
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

test("a structural fake Hermes host cannot advance the activation preflight", async () => {
  const workerBinding = Object.freeze({ localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
  const runnerConfiguration = Object.freeze({ executablePath: "/private/fixture/hermes",
    profile: "owner-profile-private", model: "qwen3.8:27b-long", provider: "ollama",
    workingDirectory: "/private/fixture/work", taskClass: "text_review" as const,
    maximumTurns: 1 as const, maximumRunBudgetSeconds: 120 });
  let calls = 0;
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1({
    installationId: binding.installationId, releaseDigest: binding.releaseDigest, topologyPlan, workerBinding,
    runnerConfiguration }, { async execute() { calls += 1; return undefined; } }),
  /installation_bound_runner_qualification_evidence_unavailable/u);
  assert.equal(calls, 0);

  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.components.find(item => item.component === "hermes_route")?.blocker, "source_proof_missing");
  assert.deepEqual(plan.ownerActions, []);
});

test("real release inventory remains blocked without a reviewed release identity", async t => {
  const source = await releaseSource();
  t.after(() => rm(source.root, { recursive: true, force: true }));
  const selectedBinding = { ...binding, releaseDigest: source.releasePreparation.releaseManifestDigest };
  const custody = createThreeWorkerActivationBundleCustodyV1(selectedBinding);
  assert.throws(() => recordVerifiedReleaseThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate,
    releasePreparation: source.fingerprint }), /preflight_refused/u);
  const proof = recordVerifiedReleaseThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate,
    releasePreparation: source.releasePreparation });
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate, sourceProofs: [proof] });
  const releaseComponent = plan.components.find(item => item.component === "verified_release");
  assert.equal(releaseComponent?.state, "blocked");
  assert.equal(releaseComponent?.blocker, "reviewed_release_identity_missing");
  assert.match(releaseComponent?.evidenceDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.components.filter(item => item.blocker === "source_proof_missing").length, 5);
  assert.throws(() => recordVerifiedReleaseThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate,
    releasePreparation: structuredClone(source.releasePreparation) }), /local_installation_package_refused/u);
});

test("real protected-configuration plan remains blocked until owner write verification", () => {
  const configurationPlan = protectedConfigurationSource();
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const proof = recordProtectedConfigurationThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate,
    configurationPlan });
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate, sourceProofs: [proof] });
  assert.equal(plan.components.find(item => item.component === "protected_configuration")?.state, "blocked");
  assert.equal(plan.components.find(item => item.component === "protected_configuration")?.blocker,
    "owner_materialization_verification_missing");
  assert.equal(plan.components.filter(item => item.blocker === "source_proof_missing").length, 5);
  assert.throws(() => recordProtectedConfigurationThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate,
    configurationPlan: structuredClone(configurationPlan) }), /private_installed_configuration_preparation_refused/u);
  const foreign = createThreeWorkerActivationBundleCustodyV1({ ...binding, topologyPlanDigest: d("foreign-topology") });
  assert.throws(() => recordProtectedConfigurationThreeWorkerActivationSourceProofV1({ aggregate: foreign.aggregate,
    configurationPlan }), /preflight_refused/u);
});

test("reviewed path-based Hermes remains blocked without pinned executable launch", async () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  await assertHermesPinnedLaunchBlocked();
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  assert.equal(plan.components.find(item => item.component === "hermes_route")?.blocker, "source_proof_missing");
  assert.deepEqual(plan.ownerActions, []);
});

test("exact replay stays current and output tampering refuses", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const first = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate });
  const replay = refreshThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate, current: first });
  assert.equal(replay.kind, "replay"); assert.equal(replay.plan.generation, 1);
  assert.throws(() => verifyThreeWorkerActivationBundlePreflightV1(custody.aggregate,
    { ...first, planDigest: d("tampered") }), /preflight_refused/u);
});
