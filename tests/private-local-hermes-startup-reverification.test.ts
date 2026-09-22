import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, HERMES_021_SOURCE_REVISION_V1 } from
  "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from
  "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1, refreshInstallationPlanV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { prepareLocalHermesAdmissionV1 } from "../src/installer/v1/local-hermes-admission-preparation";
import { localHermesAdmissionTerminalReceiptForRequestV1 } from
  "../src/installer/v1/local-hermes-admission-transaction";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  prepareLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { preparePrivateLocalHermesAdmissionRequestV1 } from
  "../src/installer/v1/private-local-hermes-admission-runner";
import { privateInstallationFinalReviewBindingsV1 } from
  "../src/installer/v1/private-installation-final-review";
import { reverifyPrivateLocalHermesStartupV1, verifyPrivateLocalHermesStartupReverificationV1 } from
  "../src/installer/v1/private-local-hermes-startup-reverification";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateHermes021LocalInstallationDeliveryV1,
  createPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../src/web/v1/hermes-021-private-installation-composition";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

const d = (value: unknown) => sha256Digest(value);

async function fixture(t: { after(fn: () => unknown): void }) {
  const workerBinding = { localServiceId: "service:hermes", workerId: "worker:hermes", expectedVersion: "0.21.3",
    sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyInput = { databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"), currentRoutes: [],
    requestedRoutes: [{ kind: "local" as const, workerId: workerBinding.workerId,
      adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: workerBinding.sourceRevision }] };
  const topology = planInstallationTopologyV1(topologyInput), releaseDigest = d("release");
  const runnerConfiguration = { executablePath: "/fixture/bin/hermes", profile: "private-profile", model: "private-model",
    provider: "private-provider", workingDirectory: "/fixture/private-project" };
  const runnerQualificationReport = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
    qualified: true, terminalResultObserved: true, sessionDigest: d("session"), inputTokens: 2, outputTokens: 3,
    totalTokens: 5, durationMs: 10, failureReason: "none", retryRequiresFreshOwnerAuthorization: false };
  const qualificationEvidenceDigest = createHermes021MacosLocalRunnerQualificationEvidenceV1(
    runnerQualificationReport).evidenceDigest;
  const qualificationObservation = { state: "passed", topologyPlanDigest: topology.planDigest, releaseDigest,
    workerBindingDigest: d(workerBinding), runnerConfigurationDigest: localHermesRunnerConfigurationDigestV1(runnerConfiguration),
    qualificationEvidenceDigest, observationDigest: d("qualification-observation") };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:fixture", releaseId: "release:fixture", releaseDigest,
    databaseSchemaVersion: "schema:fixture", databaseSchemaDigest: d("schema"), storageNamespace: "storage:fixture",
    storageNamespaceDigest: d("storage"), entries: [] });
  const backupRestoreProof = createLocalBackupRestoreReadinessV1({ planDigest: topology.planDigest,
    databaseRestore: { tenantId: inventory.tenantId, releaseId: inventory.releaseId, releaseDigest,
      databaseIdentityDigest: d("database-identity"), databaseDumpDigest: d("dump"),
      databaseSchemaVersion: inventory.databaseSchemaVersion, databaseSchemaDigest: inventory.databaseSchemaDigest,
      restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false,
      permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory, restoredArtifactInventory: inventory,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
  const installationReadiness = createInstallationReadinessV1({ planDigest: topology.planDigest, proofs: [
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: d("owner-proof") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: qualificationEvidenceDigest },
    { proof: "backup_restore", state: "passed", evidenceDigest: backupRestoreProof.proofDigest },
  ] });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: topology.planDigest,
    proofs: (["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure",
      "upgrade_and_rollback_procedure"] as const).map(proof => ({ proof, state: "passed", evidenceDigest: d(proof) })) });
  const serviceObservation = { state: "running", topologyPlanDigest: topology.planDigest, releaseDigest,
    serviceIdentityDigest: d("service"), databaseAuthorityDigest: topology.databaseAuthorityDigest,
    protectedDataBindingDigest: d("protected-data"), supervisorReadinessDigest: supervisorReadiness.readinessDigest,
    observationDigest: d("service-observation") };
  const bound = { topologyPlanDigest: topology.planDigest, releaseDigest, workerBindingDigest: d(workerBinding),
    runnerConfigurationDigest: qualificationObservation.runnerConfigurationDigest, qualificationEvidenceDigest,
    qualificationObservationDigest: d(qualificationObservation), installationReadinessDigest: installationReadiness.readinessDigest,
    recoveryProofDigest: backupRestoreProof.proofDigest, supervisorReadinessDigest: supervisorReadiness.readinessDigest,
    serviceObservationDigest: localPlatformServiceObservationDigestV1(serviceObservation) };
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(name => [name,
      name === "agent_readiness" ? localHermesInstallationStageInputDigestV1(bound) : d(name)])) });
  const history: InstallationPlanV1[] = [plan];
  const pass = (name: typeof installationSetupStagesV1[number], outcomeDigest = d(`outcome:${name}`)) => {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "pass", outcomeDigest }); history.push(plan);
  };
  for (const name of ["release_preflight", "private_placement", "database_authority"] as const) pass(name);
  pass("protected_data", serviceObservation.protectedDataBindingDigest); pass("first_owner");
  pass("recovery", backupRestoreProof.proofDigest); pass("platform_service", bound.serviceObservationDigest);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "agent_readiness", action: "start" });
  history.push(plan);
  const bindingInput = { installationPlan: plan, topologyInput, workerBinding, runnerConfiguration,
    runnerQualificationReport, qualificationObservation, installationReadiness, backupRestoreProof,
    supervisorReadiness, serviceObservation };
  const installationBinding = prepareLocalHermesInstallationBindingV1(bindingInput);
  const application = await privateAgentTaskCompositionFixture(); t.after(application.close);
  const scenario = application.scenario(); let hermesCalls = 0;
  const makeDelivery = () => createPrivateHermes021LocalInstallationDeliveryV1({ tenantId: scenario.configuration.web.tenantId,
    execution: { preparation: {}, runs: {}, delivery: { binding: workerBinding, db: {}, integrityKey: new Uint8Array(32),
      policy: { assertAdmitted() {} }, terminalResultStorage: {} } }, results: {}, assertAuthority() { hermesCalls++; },
    subprocess: runnerConfiguration });
  const delivery = makeDelivery();
  const privateStartupConfiguration = { ...scenario.configuration, coordinator: { ...scenario.configuration.coordinator,
    sessions: undefined, nativeHttp: undefined, planning: { ...scenario.configuration.coordinator.planning,
      localAdapterAdmission: { enabledAdapters: [HERMES_021_MACOS_LOCAL_ADAPTER_V1] } }, hermes021Local: delivery },
    web: { ...scenario.configuration.web, installationTopologyPlan: topology, installationReadiness,
      localBackupRestoreReadiness: backupRestoreProof, localSupervisorReadiness: supervisorReadiness } };
  const admissionPreparationInput = { installationId: "fixture-installation", installationPlan: plan,
    topologyInput, workerBinding, installationBinding, installationBindingInput: bindingInput };
  const replay = { async readHistory() { return Object.freeze([...history]); }, async append(value: InstallationPlanV1) {
    assert.equal(value.planDigest, plan.planDigest); return { schema: "control-room.installation-plan-journal/v1" as const,
      installationId: "fixture-installation", revision: value.revision, planDigest: value.planDigest, replayed: true,
      enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  } };
  // The request digest is needed by the saved binding, so derive the owner
  // preparation first through the public preparation function's deterministic material.
  const ownerPreparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput, { journal: replay });
  assert.ok(ownerPreparation.admissionRequestDigest);
  const startupAdmissionBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({ delivery,
    queueWorker: privateStartupConfiguration.coordinator.queueWorker, installationBinding,
    topologyPlanDigest: topology.planDigest, releaseDigest,
    admissionRequestDigest: ownerPreparation.admissionRequestDigest });
  const runnerInput = { admissionPreparationInput, privateStartupConfiguration, startupAdmissionBinding };
  const request = await preparePrivateLocalHermesAdmissionRequestV1(runnerInput, replay);
  const readiness = localHermesAdmissionTerminalReceiptForRequestV1(request);
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "agent_readiness",
    action: "pass", outcomeDigest: readiness.receiptDigest }); history.push(plan);
  const bindings = privateInstallationFinalReviewBindingsV1(plan);
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "final_review" ? bindings.finalReviewInputDigest : item.inputDigest])) });
  history.push(refreshed);
  plan = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision, stage: "final_review", action: "start" });
  history.push(plan);
  const finalBody = { schema: "control-room.private-installation-final-review-terminal/v1" as const,
    installationId: "fixture-installation", installationPlanDigest: plan.planDigest,
    installationPlanRevision: plan.revision, topologyPlanDigest: plan.topologyPlanDigest,
    releaseDigest: plan.releaseDigest, finalReviewInputDigest: bindings.finalReviewInputDigest,
    priorStageEvidenceDigest: bindings.priorStageEvidenceDigest, invokesAgent: false as const,
    enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
  const finalOutcome = d({ purpose: "private-installation-final-review-terminal/v1", confirmation: finalBody });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "final_review",
    action: "pass", outcomeDigest: finalOutcome }); history.push(plan);
  return { runnerInput, history: Object.freeze(history), plan, delivery, makeDelivery,
    queueWorker: privateStartupConfiguration.coordinator.queueWorker, hermesCalls: () => hermesCalls };
}

test("settled startup re-verification binds the exact composition without running it", async t => {
  const f = await fixture(t);
  let reads = 0;
  const receipt = await reverifyPrivateLocalHermesStartupV1({ runnerInput: f.runnerInput }, { journal: {
    async inspectSettledHistory() { reads++; return f.history; },
  } });
  assert.equal(reads, 1);
  assert.equal(f.hermesCalls(), 0);
  assert.equal(receipt.invokesHermes, false);
  assert.equal(receipt.opensDatabase, false);
  assert.equal(receipt.startsWorker, false);
  assert.equal(verifyPrivateLocalHermesStartupReverificationV1(receipt, {
    delivery: f.delivery, queueWorker: f.queueWorker, installationPlan: f.plan,
  }).receiptDigest, receipt.receiptDigest);
  assert.throws(() => verifyPrivateLocalHermesStartupReverificationV1(receipt, {
    delivery: f.makeDelivery(), queueWorker: f.queueWorker, installationPlan: f.plan,
  }), /private_local_hermes_startup_reverification_refused/);
  assert.equal(f.hermesCalls(), 0);
});

test("startup re-verification refuses incomplete or unsettled journal evidence", async t => {
  const f = await fixture(t);
  await assert.rejects(() => reverifyPrivateLocalHermesStartupV1({ runnerInput: f.runnerInput }, { journal: {
    async inspectSettledHistory() { return Object.freeze(f.history.slice(0, -1)); },
  } }), /private_local_hermes_startup_reverification_refused/);
  await assert.rejects(() => reverifyPrivateLocalHermesStartupV1({ runnerInput: f.runnerInput }, { journal: {
    async inspectSettledHistory() { throw new Error("unsettled publication"); },
  } }), /private_local_hermes_startup_reverification_refused/);
  assert.equal(f.hermesCalls(), 0);
});
