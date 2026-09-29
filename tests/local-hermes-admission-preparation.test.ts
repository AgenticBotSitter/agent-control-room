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
import { confirmLocalHermesAdmissionTerminalV1 } from "../src/installer/v1/local-hermes-admission-transaction";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  prepareLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
  runPrivateLocalHermesAdmissionV1, type PrivateLocalHermesAdmissionRunnerContextV1 } from
  "../src/installer/v1/private-local-hermes-admission-runner";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateHermes021LocalInstallationDeliveryV1,
  createPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../src/web/v1/hermes-021-private-installation-composition";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

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
  const installationHistory: InstallationPlanV1[] = [installationPlan];
  const pass = (name: typeof installationSetupStagesV1[number], outcomeDigest = d(`outcome:${name}`)) => {
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "start" });
    installationHistory.push(installationPlan);
    installationPlan = advanceInstallationPlanV1(installationPlan,
      { expectedRevision: installationPlan.revision, stage: name, action: "pass", outcomeDigest });
    installationHistory.push(installationPlan);
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
  installationHistory.push(installationPlan);
  const bindingInput = { installationPlan, topologyInput, workerBinding, runnerConfiguration, runnerQualificationReport,
    qualificationObservation, installationReadiness, backupRestoreProof, supervisorReadiness, serviceObservation };
  const installationBinding = prepareLocalHermesInstallationBindingV1(bindingInput);
  return { installationId: "fixture-installation", topologyInput, workerBinding, installationPlan,
    installationBinding, installationBindingInput: bindingInput, beforeRecovery, beforeService, beforeAgentReadiness,
    topology, installationReadiness, backupRestoreProof, supervisorReadiness,
    installationHistory: Object.freeze(installationHistory) };
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

function memoryJournal(initial: readonly InstallationPlanV1[], installationId = "fixture-installation") {
  let history = [...initial], appendCount = 0;
  return { journal: {
    async readHistory() { return Object.freeze([...history]); },
    async append(value: InstallationPlanV1) {
      appendCount++;
      const existing = history[value.revision];
      if (existing) {
        if (existing.planDigest !== value.planDigest) throw new Error("journal_conflict");
        return { schema: "control-room.installation-plan-journal/v1" as const, installationId,
          revision: value.revision, planDigest: value.planDigest, replayed: true,
          enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
      }
      if (value.revision !== history.length) throw new Error("journal_conflict");
      history.push(value);
      return { schema: "control-room.installation-plan-journal/v1" as const, installationId,
        revision: value.revision, planDigest: value.planDigest, replayed: false,
        enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    },
  }, current: () => history.at(-1)!, appends: () => appendCount,
  replaceCurrent(value: InstallationPlanV1) { history = [...history.slice(0, value.revision), value]; } };
}

async function privateAdmissionFixture(t: { after(fn: () => unknown): void }) {
  const local = fixture(), application = await privateAgentTaskCompositionFixture();
  t.after(() => application.close());
  const scenario = application.scenario();
  let hermesCalls = 0;
  const makeDelivery = (binding: typeof local.workerBinding = local.workerBinding,
    subprocess: typeof local.installationBindingInput.runnerConfiguration =
      local.installationBindingInput.runnerConfiguration) => createPrivateHermes021LocalInstallationDeliveryV1({
    tenantId: scenario.configuration.web.tenantId,
    execution: { preparation: {}, runs: {}, delivery: {
      binding, db: {}, integrityKey: new Uint8Array(32),
      policy: { assertAdmitted() {} }, terminalResultStorage: {},
    } },
    results: {},
    assertAuthority() { hermesCalls++; },
    subprocess,
  });
  const hermes021Local = makeDelivery();
  const privateStartupConfiguration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined,
    planning: { ...scenario.configuration.coordinator.planning,
      localAdapterAdmission: { enabledAdapters: [HERMES_021_MACOS_LOCAL_ADAPTER_V1] } },
    hermes021Local,
  }, web: { ...scenario.configuration.web, installationTopologyPlan: local.topology,
    installationReadiness: local.installationReadiness,
    localBackupRestoreReadiness: local.backupRestoreProof,
    localSupervisorReadiness: local.supervisorReadiness } };
  const admissionPreparationInput = request(local);
  const preparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput,
    { journal: memoryJournal(local.installationHistory).journal });
  assert.ok(preparation.admissionRequestDigest);
  const startupAdmissionBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({
    delivery: hermes021Local, queueWorker: privateStartupConfiguration.coordinator.queueWorker,
    installationBinding: local.installationBinding, topologyPlanDigest: preparation.topologyPlanDigest,
    releaseDigest: preparation.releaseDigest, admissionRequestDigest: preparation.admissionRequestDigest,
  });
  const runnerInput = { admissionPreparationInput, privateStartupConfiguration, startupAdmissionBinding };
  return { local, runnerInput, hermes021Local, makeDelivery, hermesCalls: () => hermesCalls };
}

function ownerConfirmation(context: PrivateLocalHermesAdmissionRunnerContextV1) {
  return { schema: PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
    installationId: context.installationId, requestDigest: context.requestDigest,
    admissionRequestDigest: context.admissionRequestDigest,
    privateStartupBindingDigest: context.privateStartupBindingDigest,
    installationPlanDigest: context.installationPlanDigest,
    installationPlanRevision: context.installationPlanRevision,
    ownerAttached: true as const, confirmed: true as const };
}

test("attached owner admission validates private startup without invoking Hermes", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  let confirmations = 0, childSignal: AbortSignal | undefined;
  const runtime = { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      confirmations++; childSignal = context.signal; return ownerConfirmation(context); } };
  const pending = runPrivateLocalHermesAdmissionV1(input.runnerInput, runtime);
  runtime.confirmOwnerAttachedTerminal = async () => { throw new Error("mutated port"); };
  const result = await pending;
  assert.equal(confirmations, 1);
  assert.equal(childSignal?.aborted, true);
  assert.equal(input.hermesCalls(), 0);
  assert.equal(result.disposition, "terminal_confirmation");
  assert.equal(result.terminalConfirmation.passesFinalReview, false);
  for (const flag of ["invokesHermes", "startsService", "startsWork", "enablesWorker",
    "grantsExecutionAuthority"] as const) assert.equal(result[flag], false);
  assert.doesNotMatch(JSON.stringify(result), /fixture\/bin|private-profile|private-model|private-provider|private-project|password/);
});

test("owner admission refuses a changed startup proof and uncertain owner confirmation", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  const changed = { ...input.runnerInput, privateStartupConfiguration: {
    ...input.runnerInput.privateStartupConfiguration,
    web: { ...input.runnerInput.privateStartupConfiguration.web, localSupervisorReadiness: undefined },
  } };
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(changed, { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      return ownerConfirmation(context); } }),
  /private_local_hermes_admission_runner_refused/);
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal() { throw new Error("lost reply"); } }),
  /private_local_hermes_admission_runner_uncertain/);
  assert.equal(input.hermesCalls(), 0);
});

test("a concurrent journal change after owner confirmation is uncertain", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      const current = store.current();
      store.replaceCurrent(advanceInstallationPlanV1(current, { expectedRevision: current.revision,
        stage: "agent_readiness", action: "uncertain", outcomeDigest: d("concurrent") }));
      return ownerConfirmation(context);
    } }), /private_local_hermes_admission_runner_uncertain/);
  assert.equal(input.hermesCalls(), 0);
});

test("owner confirmation timeout aborts the exact child signal and reports uncertainty", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  let childSignal: AbortSignal | undefined;
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 10,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      childSignal = context.signal;
      return new Promise<never>(() => {});
    } }), /private_local_hermes_admission_runner_uncertain/);
  assert.equal(childSignal?.aborted, true);
  assert.equal(input.hermesCalls(), 0);
});

test("parent cancellation during owner confirmation aborts the child and reports uncertainty", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  const parent = new AbortController();
  let childSignal: AbortSignal | undefined;
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: parent.signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      childSignal = context.signal;
      queueMicrotask(() => parent.abort());
      return new Promise<never>(() => {});
    } }), /private_local_hermes_admission_runner_uncertain/);
  assert.equal(childSignal?.aborted, true);
  assert.equal(input.hermesCalls(), 0);
});

test("parent cancellation during the final journal reread is uncertain", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  const parent = new AbortController();
  let confirmed = false, childSignal: AbortSignal | undefined;
  const journal = { ...store.journal, async readHistory() {
    if (!confirmed) return store.journal.readHistory();
    parent.abort();
    return new Promise<readonly InstallationPlanV1[]>(() => {});
  } };
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal,
    signal: parent.signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      childSignal = context.signal;
      confirmed = true;
      return ownerConfirmation(context);
    } }), /private_local_hermes_admission_runner_uncertain/);
  assert.equal(childSignal?.aborted, true);
  assert.equal(input.hermesCalls(), 0);
});

test("owner admission refuses a malformed cancellation signal before terminal entry", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  let confirmations = 0;
  await assert.rejects(() => runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: { aborted: false, addEventListener() {} }, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      confirmations++;
      return ownerConfirmation(context);
    } } as never), /private_local_hermes_admission_runner_refused/);
  assert.equal(confirmations, 0);
  assert.equal(input.hermesCalls(), 0);
});

test("startup admission binding refuses callback, worker, runner, queue role and concurrency substitution", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  const startup = input.runnerInput.privateStartupConfiguration;
  const queueWorker = startup.coordinator.queueWorker;
  if (!queueWorker) throw new Error("missing queue worker fixture");
  const refuseRunner = async (privateStartupConfiguration: typeof startup,
    startupAdmissionBinding: unknown = input.runnerInput.startupAdmissionBinding) => assert.rejects(
    () => runPrivateLocalHermesAdmissionV1({ ...input.runnerInput, privateStartupConfiguration,
      startupAdmissionBinding }, { journal: store.journal, signal: new AbortController().signal,
      controlDeadlineMs: 1_000,
      async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
        return ownerConfirmation(context);
      } }), /private_local_hermes_admission_runner_refused/);
  await refuseRunner({ ...startup, coordinator: { ...startup.coordinator,
    hermes021Local: { deliver: input.hermes021Local.deliver } } });
  await refuseRunner({ ...startup, coordinator: { ...startup.coordinator,
    queueWorker: { ...queueWorker,
      database: { ...queueWorker.database, username: "other_queue_worker" } } } });
  await refuseRunner({ ...startup, coordinator: { ...startup.coordinator,
    queueWorker: { ...queueWorker, concurrency: 1 } } });
  assert.throws(() => createPrivateHermes021LocalStartupAdmissionBindingV1({
    delivery: input.makeDelivery({ ...input.local.workerBinding, workerId: "worker:other" }),
    queueWorker, installationBinding: input.local.installationBinding,
    topologyPlanDigest: input.local.installationBinding.topologyPlanDigest,
    releaseDigest: input.local.installationBinding.releaseDigest,
    admissionRequestDigest: input.runnerInput.startupAdmissionBinding.admissionRequestDigest,
  }), /hermes_021_private_installation_composition_unavailable/);
  assert.throws(() => createPrivateHermes021LocalStartupAdmissionBindingV1({
    delivery: input.makeDelivery(input.local.workerBinding, {
      ...input.local.installationBindingInput.runnerConfiguration, model: "substituted-model" }),
    queueWorker, installationBinding: input.local.installationBinding,
    topologyPlanDigest: input.local.installationBinding.topologyPlanDigest,
    releaseDigest: input.local.installationBinding.releaseDigest,
    admissionRequestDigest: input.runnerInput.startupAdmissionBinding.admissionRequestDigest,
  }), /hermes_021_private_installation_composition_unavailable/);
  const serializedBinding = JSON.stringify(input.runnerInput.startupAdmissionBinding);
  assert.doesNotMatch(serializedBinding, new RegExp(queueWorker.database.password));
  assert.equal(input.hermesCalls(), 0);
});

test("settles agent readiness once in the existing journal and leaves final review untouched", async t => {
  const input = await privateAdmissionFixture(t), store = memoryJournal(input.local.installationHistory);
  const owner = await runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: store.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      return ownerConfirmation(context); } });
  const envelope = { runnerInput: input.runnerInput, terminalConfirmation: owner.terminalConfirmation };
  const [settled, concurrent] = await Promise.all([
    confirmLocalHermesAdmissionTerminalV1(envelope, { journal: store.journal }),
    confirmLocalHermesAdmissionTerminalV1(envelope, { journal: store.journal }),
  ]);
  assert.deepEqual([settled.replayed, concurrent.replayed].sort(), [false, true]);
  assert.equal(concurrent.receipt.receiptDigest, settled.receipt.receiptDigest);
  assert.equal(store.current().stages.find(item => item.stage === "agent_readiness")?.state, "passed");
  assert.equal(store.current().stages.find(item => item.stage === "agent_readiness")?.outcomeDigest,
    settled.receipt.receiptDigest);
  assert.equal(store.current().stages.find(item => item.stage === "final_review")?.state, "not_started");
  assert.equal(settled.passesFinalReview, false);
  assert.equal(input.hermesCalls(), 0);
  const replay = await confirmLocalHermesAdmissionTerminalV1(envelope, { journal: store.journal });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receiptDigest, settled.receipt.receiptDigest);
});

test("settlement refuses cross-installation, tampered, stale and competing evidence", async t => {
  const input = await privateAdmissionFixture(t), ownerStore = memoryJournal(input.local.installationHistory);
  const owner = await runPrivateLocalHermesAdmissionV1(input.runnerInput, { journal: ownerStore.journal,
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      return ownerConfirmation(context); } });
  const cross = memoryJournal(input.local.installationHistory, "other-installation");
  await assert.rejects(() => confirmLocalHermesAdmissionTerminalV1({ runnerInput: input.runnerInput,
    terminalConfirmation: owner.terminalConfirmation }, { journal: cross.journal }),
  /local_hermes_admission_transaction_refused/);
  await assert.rejects(() => confirmLocalHermesAdmissionTerminalV1({ runnerInput: input.runnerInput,
    terminalConfirmation: { ...owner.terminalConfirmation, confirmationDigest: d("tampered") } },
  { journal: memoryJournal(input.local.installationHistory).journal }), /local_hermes_admission_transaction_refused/);
  for (const action of ["fail", "uncertain"] as const) {
    const changed = advanceInstallationPlanV1(input.local.installationPlan,
      { expectedRevision: input.local.installationPlan.revision, stage: "agent_readiness", action, outcomeDigest: d(action) });
    const competing = memoryJournal([...input.local.installationHistory, changed]);
    await assert.rejects(() => confirmLocalHermesAdmissionTerminalV1({ runnerInput: input.runnerInput,
      terminalConfirmation: owner.terminalConfirmation }, { journal: competing.journal }),
    /local_hermes_admission_transaction_refused/);
  }
  assert.equal(input.hermesCalls(), 0);
});
