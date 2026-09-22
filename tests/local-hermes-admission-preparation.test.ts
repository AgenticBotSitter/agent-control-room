import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1,
  verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
  HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { CONTROLLER_WORKER_DELIVERY_V1 } from "../src/harness/v1/controller-worker-delivery";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1,
  installationSetupStagesV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { prepareLocalHermesAdmissionV1, type LocalHermesAdmissionPreparationInputV1 } from
  "../src/installer/v1/local-hermes-admission-preparation";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  prepareLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);

function fixture() {
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
      permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory,
    restoredArtifactInventory: inventory,
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
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(name => [name,
      name === "agent_readiness" ? localHermesInstallationStageInputDigestV1(bound) : d(name)])) });
  const pass = (name: typeof installationSetupStagesV1[number], outcomeDigest = d(`outcome:${name}`)) => {
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "start" });
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "pass", outcomeDigest });
  };
  for (const name of ["release_preflight", "private_placement", "database_authority"] as const) pass(name);
  pass("protected_data", serviceObservation.protectedDataBindingDigest);
  pass("first_owner");
  const beforeRecovery = installationPlan;
  pass("recovery", backupRestoreProof.proofDigest);
  const beforeService = installationPlan;
  pass("platform_service", bound.serviceObservationDigest);
  const beforeAgentReadiness = installationPlan;
  installationPlan = advanceInstallationPlanV1(installationPlan,
    { expectedRevision: installationPlan.revision, stage: "agent_readiness", action: "start" });
  const bindingInput = { installationPlan, topologyInput, workerBinding, runnerConfiguration, runnerQualificationReport,
    qualificationObservation, installationReadiness, backupRestoreProof, supervisorReadiness, serviceObservation };
  const installationBinding = prepareLocalHermesInstallationBindingV1(bindingInput);
  return { installationId: "fixture-installation", topologyInput, workerBinding, installationPlan,
    installationBinding, installationBindingInput: bindingInput, beforeRecovery, beforeService, beforeAgentReadiness };
}

function request(input: ReturnType<typeof fixture>) {
  return { installationId: input.installationId, topologyInput: input.topologyInput,
    workerBinding: input.workerBinding, installationPlan: input.installationPlan,
    installationBinding: input.installationBinding, installationBindingInput: input.installationBindingInput };
}

function prepare(input: LocalHermesAdmissionPreparationInputV1, authenticatedInstallationId = input.installationId) {
  const plan = input.installationPlan as InstallationPlanV1;
  return prepareLocalHermesAdmissionV1(input, { journal: {
    async readHistory() { return Object.freeze([plan]); },
    async append(value: InstallationPlanV1) {
      assert.equal(value.planDigest, plan.planDigest);
      return { schema: "control-room.installation-plan-journal/v1" as const,
        installationId: authenticatedInstallationId, revision: plan.revision, planDigest: plan.planDigest,
        replayed: true, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    },
  } });
}

const refuses = (run: () => Promise<unknown>) => assert.rejects(run,
  /^Error: local_hermes_admission_preparation_refused$/);

test("turns exact current installation evidence into an inert owner-admission review request", async () => {
  const fixtureValue = fixture(), input = request(fixtureValue), before = structuredClone(input),
    result = await prepare(input);
  assert.equal(result.state, "awaiting_owner_admission_review");
  assert.equal(result.nextOperation, "supply_private_startup_and_owner_admission");
  assert.deepEqual(result.blockers, ["private_startup_composition_not_supplied", "owner_admission_not_recorded",
    "agent_readiness_not_settled", "final_review_not_settled"]);
  for (const flag of ["invokesRunner", "startsWork", "startsService", "enablesWorker", "grantsExecutionAuthority",
    "createsQueue", "createsStore", "capacityAuthorizesAdmission"] as const) assert.equal(result[flag], false);
  assert.ok(result.admissionRequestDigest?.startsWith("sha256:"));
  assert.deepEqual(input, before);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /fixture\/bin|private-profile|private-model|private-provider|private-project|worker:hermes|service:hermes/);
});

test("binds the existing shared delivery and ordinary result-review-correction lifecycle", async () => {
  const first = await prepare(request(fixture()));
  const second = await prepare(request(fixture()));
  assert.equal(first.lifecycleContractDigest, second.lifecycleContractDigest);
  assert.equal(first.admissionRequestDigest, second.admissionRequestDigest);
  assert.equal(CONTROLLER_WORKER_DELIVERY_V1, "control-room.controller-worker-delivery/v1");
  assert.equal(HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1.startsWith("sha256:"), true);
});

test("reports the exact first incomplete recovery or service prerequisite without accepting capacity as authority", async () => {
  const input = fixture();
  const recovery = await prepare({ ...request(input), installationPlan: input.beforeRecovery,
    installationBinding: undefined, installationBindingInput: undefined });
  assert.deepEqual(recovery.blockers, ["recovery_not_settled"]);
  assert.equal(recovery.nextOperation, "finish_installation_prerequisite");
  assert.equal(recovery.capacityAuthorizesAdmission, false);
  const service = await prepare({ ...request(input), installationPlan: input.beforeService,
    installationBinding: undefined, installationBindingInput: undefined });
  assert.deepEqual(service.blockers, ["platform_service_not_settled"]);
});

test("requires a current binding after agent readiness begins", async () => {
  const input = fixture();
  const notStarted = await prepare({ ...request(input), installationPlan: input.beforeAgentReadiness,
    installationBinding: undefined, installationBindingInput: undefined });
  assert.deepEqual(notStarted.blockers, ["agent_readiness_not_started"]);
  const missing = await prepare({ ...request(input),
    installationBinding: undefined, installationBindingInput: undefined });
  assert.equal(missing.state, "blocked");
  assert.deepEqual(missing.blockers, ["installation_binding_not_verified"]);
  assert.equal(missing.nextOperation, "verify_installation_binding");
});

test("a saved binding cannot authorize itself after current private evidence changes", async () => {
  const input = fixture();
  await refuses(() => prepare({ ...request(input), installationBindingInput: {
    ...input.installationBindingInput,
    qualificationObservation: { ...input.installationBindingInput.qualificationObservation, state: "revoked" },
  } }));
  await refuses(() => prepare({ ...request(input), installationBindingInput: undefined }));
});

test("refuses route, plan and adapter drift rather than preparing admission", async () => {
  const input = fixture();
  await refuses(() => prepare({ ...request(input), topologyInput: {
    ...input.topologyInput, schedulerAuthorityDigest: d("changed"),
  } }));
  await refuses(() => prepare({ ...request(input), workerBinding: {
    ...input.workerBinding, sourceRevision: "a".repeat(40),
  } }));
  await refuses(() => prepare({ ...request(input), workerBinding: {
    ...input.workerBinding, workerId: "worker:other",
  } }));
});

test("does not replay an owner request after agent readiness is settled or uncertain", async () => {
  const input = fixture();
  for (const action of ["pass", "fail", "uncertain"] as const) {
    const plan = advanceInstallationPlanV1(input.installationPlan, { expectedRevision: input.installationPlan.revision,
      stage: "agent_readiness", action, outcomeDigest: d(action) });
    const result = await prepare({ ...request(input), installationPlan: plan,
      installationBinding: undefined, installationBindingInput: undefined });
    assert.deepEqual(result.blockers, ["agent_readiness_requires_owner_attention"]);
    assert.equal(result.admissionRequestDigest, undefined);
  }
});

test("refuses extra fields that could smuggle a browser grant, callback or capacity claim", async () => {
  const input = fixture();
  for (const extra of [{ ownerAuthorized: true }, { callback: () => {} }, { capacityAvailable: true },
    { enablesWorker: true }]) await refuses(() => prepare({ ...request(input), ...extra }));
});

test("refuses an installation name that the journal does not authenticate", async () => {
  const input = request(fixture());
  await refuses(() => prepare({ ...input, installationId: "other-installation" }, input.installationId));
});

test("refuses when the journal advances after replaying the claimed current plan", async () => {
  const input = request(fixture()), plan = input.installationPlan as InstallationPlanV1;
  const later = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision,
    stage: "agent_readiness", action: "uncertain", outcomeDigest: d("concurrent-change") });
  let history: readonly InstallationPlanV1[] = Object.freeze([plan]);
  await refuses(() => prepareLocalHermesAdmissionV1(input, { journal: {
    async readHistory() { return history; },
    async append(value: InstallationPlanV1) {
      assert.equal(value.planDigest, plan.planDigest);
      history = Object.freeze([plan, later]);
      return { schema: "control-room.installation-plan-journal/v1" as const,
        installationId: input.installationId, revision: plan.revision, planDigest: plan.planDigest,
        replayed: true, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    },
  } }));
});
