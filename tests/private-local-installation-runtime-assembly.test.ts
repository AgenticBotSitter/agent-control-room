import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from
  "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1, refreshInstallationPlanV1,
  type InstallationPlanV1, verifyInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { createPrivateLocalInstallationRuntimeAssemblyV1 } from
  "../src/installer/v1/private-local-installation-runtime-assembly";
import { createPrivateLocalInstallationOperatorV1 } from
  "../src/installer/v1/private-local-installation-operator";
import { prepareLocalHermesAdmissionV1 } from "../src/installer/v1/local-hermes-admission-preparation";
import { localHermesAdmissionTerminalReceiptForRequestV1 } from
  "../src/installer/v1/local-hermes-admission-transaction";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  prepareLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
  preparePrivateLocalHermesAdmissionRequestV1, type PrivateLocalHermesAdmissionRunnerContextV1 } from
  "../src/installer/v1/private-local-hermes-admission-runner";
import { PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
  privateInstallationFinalReviewBindingsV1, type PrivateInstallationFinalReviewContextV1 } from
  "../src/installer/v1/private-installation-final-review";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateHermes021LocalInstallationDeliveryV1,
  createPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../src/web/v1/hermes-021-private-installation-composition";
import { privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

const d = (value: unknown) => sha256Digest(value);

function completedInstallationPlan(result: unknown): InstallationPlanV1 {
  assert.ok(result && typeof result === "object");
  assert.equal((result as { status?: unknown }).status, "completed");
  return verifyInstallationPlanV1((result as { installationPlan?: unknown }).installationPlan);
}

function assertBlocked(result: unknown, blocker: "private_configuration_custody_missing"):
  asserts result is Readonly<{ status: "blocked"; blocker: typeof blocker }> {
  assert.ok(result && typeof result === "object");
  assert.equal((result as { status?: unknown }).status, "blocked");
  assert.equal((result as { blocker?: unknown }).blocker, blocker);
}

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
    totalTokens: 5, durationMs: 10, failureReason: "none" as const, retryRequiresFreshOwnerAuthorization: false };
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
    return { schema: "control-room.installation-plan-journal/v1" as const, installationId: "fixture-installation",
      revision: value.revision, planDigest: value.planDigest, replayed: true, enablesAuthority: false as const,
      startsService: false as const, startsWorker: false as const };
  } };
  const ownerPreparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput, { journal: replay });
  if (!ownerPreparation.admissionRequestDigest) throw new Error("fixture admission missing");
  const startupAdmissionBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({ delivery,
    queueWorker: privateStartupConfiguration.coordinator.queueWorker, installationBinding,
    topologyPlanDigest: topology.planDigest, releaseDigest, admissionRequestDigest: ownerPreparation.admissionRequestDigest });
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
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "final_review",
    action: "pass", outcomeDigest: d({ purpose: "private-installation-final-review-terminal/v1", confirmation: finalBody }) });
  history.push(plan);
  const c = privateStartupConfiguration.coordinator;
  const settings = { schema: "control-room.agent-task-operator-settings/v1" as const, port: 3210,
    tenantId: privateStartupConfiguration.web.tenantId,
    databaseRoles: { coordinator: c.database, results: c.resultDatabase, evidence: c.evidence!.database,
      queueWorker: c.queueWorker!.database }, queueWorkerConcurrency: c.queueWorker!.concurrency,
    features: { nativeQueue: true, nativeQueueRecovery: true, quality: true, evidence: true,
      queueWorker: true, artifactStorage: true, hermes021Local: true } };
  const { database: _evidenceDatabase, ...evidence } = c.evidence!;
  const artifactRoot = "/fixture/private-artifacts", artifactNamespace = "fixture-private-artifacts";
  const artifactStorage = { local: { rootPath: artifactRoot, maximumArtifacts: 100, maximumFileBytes: 65_536,
      maximumTotalBytes: 6_553_600, operationTimeoutMs: 1_000 },
    inventory: { releaseId: "release:fixture", releaseDigest, databaseSchemaVersion: inventory.databaseSchemaVersion,
      databaseSchemaDigest: inventory.databaseSchemaDigest, storageNamespace: artifactNamespace,
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(artifactNamespace, artifactRoot) } };
  const trusted = { web: { ...privateStartupConfiguration.web, installationPlan: plan }, planning: c.planning,
    routes: c.routes, approvalEnrollments: c.approvals!.enrollments, approvalStore: c.approvals!.store,
    quality: c.quality, evidence, artifactStorage,
    hermes021Local: delivery,
    localBackupRestoreReadiness: backupRestoreProof };
  let currentHistory: readonly InstallationPlanV1[] = Object.freeze(history), reads = 0, appends = 0;
  let inspectionSequence: readonly (readonly InstallationPlanV1[])[] = Object.freeze([]);
  const journal = { async inspectSettledHistory() { reads++;
      if (inspectionSequence.length > 0) {
        const [next, ...remaining] = inspectionSequence; inspectionSequence = Object.freeze(remaining); return next!;
      }
      return currentHistory;
    },
    async readHistory() { reads++; return currentHistory; }, async append(value: InstallationPlanV1) {
      appends++; const existing = currentHistory[value.revision];
      if (existing && existing.planDigest !== value.planDigest) throw new Error("journal conflict");
      if (!existing) {
        if (value.revision !== currentHistory.length) throw new Error("journal conflict");
        currentHistory = Object.freeze([...currentHistory, value]);
      }
      return { schema: "control-room.installation-plan-journal/v1" as const, installationId: "fixture-installation",
        revision: value.revision, planDigest: value.planDigest, replayed: existing !== undefined, enablesAuthority: false as const,
        startsService: false as const, startsWorker: false as const };
    } };
  return { runnerInput, history: Object.freeze(history), plan, topology, delivery, makeDelivery,
    queueWorker: c.queueWorker!, settings, trusted, journal, hermesCalls: () => hermesCalls,
    reads: () => reads, appends: () => appends, move(value: readonly InstallationPlanV1[]) { currentHistory = value; },
    inspectInOrder(...values: readonly (readonly InstallationPlanV1[])[]) {
      inspectionSequence = Object.freeze([...values]);
    } };
}

function dependencies(calls: string[]) {
  return { openDatabase() { calls.push("database"); throw new Error("test effect"); },
    install() { calls.push("install"); throw new Error("test effect"); } };
}

function startupBoundaryDependencies(calls: string[]) {
  return { openDatabase() { calls.push("database"); throw new Error("must_not_open_database"); },
    install() { calls.push("install"); throw new Error("must_not_install"); },
    clock() { calls.push("clock"); return 1; },
    async prepareNativeSubmission() { calls.push("native-submission"); throw new Error("must_not_prepare_native_submission"); },
    async startNativeWorker() { calls.push("native-worker"); throw new Error("must_not_start_native_worker"); },
    prepareNewsSubmission() { calls.push("news-submission"); throw new Error("must_not_prepare_news_submission"); },
    async startNewsWorker() { calls.push("news-worker"); throw new Error("must_not_start_news_worker"); },
    async openArtifactStorage() { calls.push("artifact-storage"); throw new Error("synthetic_first_startup_boundary"); } };
}

function finalReviewConfiguration(f: Awaited<ReturnType<typeof fixture>>, effects: string[],
  confirmOwnerAttached: (context: PrivateInstallationFinalReviewContextV1) => Promise<unknown>) {
  const setupSources = Object.fromEntries(["database_authority", "protected_data", "first_owner", "recovery",
    "platform_service", "agent_readiness", "final_review"].map(stage => [stage, {}]));
  const setupRuntimes = Object.fromEntries(Object.keys(setupSources).map(stage => [stage, undefined])) as Record<string, unknown>;
  setupRuntimes.final_review = { finalReview: { signal: new AbortController().signal, controlDeadlineMs: 1_000,
    confirmOwnerAttached } };
  return { prerequisiteInput: { installationId: "fixture-installation", topologyPlan: f.topology,
      releaseDigest: f.plan.releaseDigest, releasePreflight: {}, privatePlacement: {} },
    assemblyInput: { runnerInput: f.runnerInput, operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
    startupDependencies: dependencies(effects), setupSources, setupRuntimes };
}

function finalReviewConfirmation(context: PrivateInstallationFinalReviewContextV1) {
  return Object.freeze({ schema: PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
    installationId: context.installationId, installationPlanDigest: context.installationPlanDigest,
    installationPlanRevision: context.installationPlanRevision,
    finalReviewInputDigest: context.finalReviewInputDigest, ownerAttached: true as const, confirmed: true as const });
}

test("construction is inert and settled preparation supplies the exact opaque receipt to operator configuration", async t => {
  const f = await fixture(t), effects: string[] = [];
  const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: f.runnerInput,
    operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
  { journal: f.journal, startupDependencies: dependencies(effects) });
  assert.equal(assembly.status, "ready"); assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
  if (assembly.status !== "ready") return;
  const prepared = await assembly.prepare();
  assert.equal(prepared.plan.planDigest, f.plan.planDigest);
  const configuration = prepared.configuration as { coordinator: {
    hermes021LocalStartupReverification?: { receiptDigest?: string } } };
  assert.equal(configuration.coordinator.hermes021LocalStartupReverification?.receiptDigest,
    prepared.receipt.receiptDigest);
  assert.equal((prepared.configuration.web as { installationPlan?: { planDigest?: string } }).installationPlan?.planDigest,
    f.plan.planDigest);
  assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
});

test("installed operator reports ready and reaches the exact first injected startup boundary once", async t => {
  const f = await fixture(t), effects: string[] = [];
  const setupSources = Object.fromEntries(["database_authority", "protected_data", "first_owner", "recovery",
    "platform_service", "agent_readiness", "final_review"].map(stage => [stage, {}]));
  const setupRuntimes = Object.fromEntries(Object.keys(setupSources).map(stage => [stage, undefined]));
  const loaded = { prerequisiteInput: { installationId: "fixture-installation",
      topologyPlan: f.topology,
      releaseDigest: f.plan.releaseDigest, releasePreflight: {}, privatePlacement: {} },
    assemblyInput: { runnerInput: f.runnerInput, operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
    startupDependencies: startupBoundaryDependencies(effects), setupSources, setupRuntimes };
  const direct = createPrivateLocalInstallationRuntimeAssemblyV1(loaded.assemblyInput,
    { journal: f.journal, startupDependencies: loaded.startupDependencies });
  assert.equal(direct.status, "ready");
  const operator = createPrivateLocalInstallationOperatorV1({ async loadPrivateConfiguration() { return loaded; } }, { journal: f.journal });
  if (operator.status === "blocked") throw new Error("operator constructor blocked");
  const status = await operator.status();
  assert.equal(status.status, "ready", JSON.stringify(status));
  if (status.status === "ready") assert.equal(status.nextStage, "complete");
  await assert.rejects(operator.start(), /private_task_startup_prerequisites_failed/u);
  assert.deepEqual(effects, ["artifact-storage"]);
  assert.equal(f.hermesCalls(), 0);
});

test("installed operator dispatches final review after settled prerequisites", async t => {
  const f = await fixture(t), effects: string[] = [];
  f.move(Object.freeze(f.history.slice(0, -2)));
  let confirmations = 0;
  const loaded = finalReviewConfiguration(f, effects, async context => {
    confirmations += 1;
    return finalReviewConfirmation(context);
  });
  const operator = createPrivateLocalInstallationOperatorV1(
    { async loadPrivateConfiguration() { return loaded; } }, { journal: f.journal });
  if (operator.status === "blocked") throw new Error("operator constructor blocked");
  const status = await operator.status();
  assert.equal(status.status, "ready", JSON.stringify(status));
  if (status.status === "ready") assert.equal(status.nextStage, "final_review");
  const result = await operator.setupNext();
  const completedPlan = completedInstallationPlan(result);
  assert.equal(completedPlan.stages.find(item => item.stage === "final_review")?.state, "passed");
  assert.equal(confirmations, 1); assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
});

test("successive operator setup calls pass agent admission and final review before completing", async t => {
  const f = await fixture(t), effects: string[] = [], ownerCalls: string[] = [];
  const beforeAdmission = f.history.findIndex(plan =>
    plan.stages.find(item => item.stage === "platform_service")?.state === "passed"
      && plan.stages.find(item => item.stage === "agent_readiness")?.state === "not_started");
  assert.notEqual(beforeAdmission, -1);
  f.move(Object.freeze(f.history.slice(0, beforeAdmission + 1)));
  const loaded = finalReviewConfiguration(f, effects, async context => {
    ownerCalls.push("final-review");
    return finalReviewConfirmation(context);
  });
  loaded.setupSources.agent_readiness = f.runnerInput;
  loaded.setupRuntimes.agent_readiness = { agentReadiness: {
    signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      ownerCalls.push("agent-admission");
      return { schema: PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
        installationId: context.installationId, requestDigest: context.requestDigest,
        admissionRequestDigest: context.admissionRequestDigest,
        privateStartupBindingDigest: context.privateStartupBindingDigest,
        installationPlanDigest: context.installationPlanDigest,
        installationPlanRevision: context.installationPlanRevision,
        ownerAttached: true as const, confirmed: true as const };
    } } };
  const operator = createPrivateLocalInstallationOperatorV1(
    { async loadPrivateConfiguration() { return loaded; } }, { journal: f.journal });
  if (operator.status === "blocked") throw new Error("operator constructor blocked");

  const admitted = await operator.setupNext();
  const admittedPlan = completedInstallationPlan(admitted);
  assert.equal(admittedPlan.stages.find(item => item.stage === "agent_readiness")?.state, "passed");
  assert.deepEqual(ownerCalls, ["agent-admission"]);

  const reviewed = await operator.setupNext();
  const reviewedPlan = completedInstallationPlan(reviewed);
  assert.equal(reviewedPlan.stages.find(item => item.stage === "final_review")?.state, "passed");
  assert.deepEqual(ownerCalls, ["agent-admission", "final-review"]);

  const complete = await operator.setupNext();
  assert.equal(complete.status, "complete");
  assert.equal(complete.installationPlanDigest, reviewedPlan.planDigest);
  assert.deepEqual(ownerCalls, ["agent-admission", "final-review"]);
  assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
});

test("operator parent abort reaches the active owner context and reconstruction will not repeat review", async t => {
  const f = await fixture(t), effects: string[] = [];
  f.move(Object.freeze(f.history.slice(0, -2)));
  const parent = new AbortController();
  let confirmations = 0, contextSignal: AbortSignal | undefined;
  const loaded = finalReviewConfiguration(f, effects, async context => {
    confirmations += 1; contextSignal = context.signal;
    assert.equal(context.signal.aborted, false);
    parent.abort();
    assert.equal(context.signal.aborted, true);
    return finalReviewConfirmation(context);
  });
  const construct = () => createPrivateLocalInstallationOperatorV1(
    { async loadPrivateConfiguration() { return loaded; } }, { journal: f.journal });
  const first = construct();
  if (first.status === "blocked") throw new Error("operator constructor blocked");
  await assert.rejects(first.setupNext(parent.signal),
    /private_(?:installation_final_review|local_installation_operator|local_setup_orchestrator)_refused/u);
  assert.equal(contextSignal?.aborted, true);
  assert.equal(confirmations, 1);
  const history = await f.journal.readHistory();
  assert.equal(history.at(-1)?.stages.find(item => item.stage === "final_review")?.state, "running");

  const reconstructed = construct();
  if (reconstructed.status === "blocked") throw new Error("reconstructed operator blocked at construction");
  await assert.rejects(reconstructed.setupNext(), /private_local_installation_operator_refused/u);
  assert.equal(confirmations, 1, "a running owner review cannot be called a second time");
  assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
});

test("operator seals nested configuration and runtime before awaited journal custody", async t => {
  const f = await fixture(t), effects: string[] = [];
  f.move(Object.freeze(f.history.slice(0, -2)));
  let originalCalls = 0, replacementCalls = 0;
  const loaded = finalReviewConfiguration(f, effects, async context => {
    originalCalls += 1;
    return finalReviewConfirmation(context);
  });
  let releaseRead!: () => void, announceRead!: () => void;
  const readStarted = new Promise<void>(resolve => { announceRead = resolve; });
  const continueRead = new Promise<void>(resolve => { releaseRead = resolve; });
  let delayed = false;
  const delayedJournal = { ...f.journal, async readHistory() {
    if (!delayed) { delayed = true; announceRead(); await continueRead; }
    return f.journal.readHistory();
  } };
  const operator = createPrivateLocalInstallationOperatorV1(
    { async loadPrivateConfiguration() { return loaded; } }, { journal: delayedJournal });
  if (operator.status === "blocked") throw new Error("operator constructor blocked");
  const pending = operator.setupNext();
  await readStarted;
  loaded.assemblyInput.runnerInput.admissionPreparationInput.installationId = "foreign-after-capture";
  loaded.assemblyInput.runnerInput.privateStartupConfiguration.coordinator.hermes021Local = f.makeDelivery();
  const runtime = loaded.setupRuntimes.final_review as { finalReview: {
    confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1): Promise<unknown> } };
  runtime.finalReview.confirmOwnerAttached = async context => {
    replacementCalls += 1;
    return finalReviewConfirmation(context);
  };
  releaseRead();
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(originalCalls, 1); assert.equal(replacementCalls, 0);
  assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0);
});

test("operator status and start both refuse a foreign assembly installation", async t => {
  for (const operation of ["status", "start"] as const) {
    const f = await fixture(t), effects: string[] = [];
    const loaded = finalReviewConfiguration(f, effects, async context => finalReviewConfirmation(context));
    loaded.assemblyInput.runnerInput.admissionPreparationInput.installationId = "foreign-installation";
    const operator = createPrivateLocalInstallationOperatorV1(
      { async loadPrivateConfiguration() { return loaded; } }, { journal: f.journal });
    if (operator.status === "blocked") throw new Error("operator constructor blocked");
    const result = await operator[operation]();
    assertBlocked(result, "private_configuration_custody_missing");
    assert.deepEqual(effects, [], operation); assert.equal(f.hermesCalls(), 0, operation);
  }
});

test("missing configuration or native custody returns an explicit inert blocker", async t => {
  const f = await fixture(t), effects: string[] = [];
  const missing = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: undefined,
    operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
  { journal: f.journal, startupDependencies: dependencies(effects) });
  assert.equal(missing.status, "blocked"); assert.equal(missing.blocker, "private_configuration_custody_missing");
  const ready = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: f.runnerInput,
    operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
  { journal: f.journal, startupDependencies: dependencies(effects) });
  if (ready.status !== "ready") throw new Error("fixture blocked");
  const native = await ready.dispatchSetup({ requestedStage: "platform_service" }, {});
  assert.equal(native.blocker, "native_service_custody_missing");
  assert.deepEqual(effects, []); assert.equal(f.hermesCalls(), 0); assert.equal(f.reads(), 0); assert.equal(f.appends(), 0);
});

test("journal and startup effect ports reject accessors, inherited, extra and symbol properties without reading them", async t => {
  const f = await fixture(t), effects: string[] = [];
  let journalGetterCalls = 0, dependencyGetterCalls = 0;
  const accessorJournal = {
    readHistory: f.journal.readHistory,
    inspectSettledHistory: f.journal.inspectSettledHistory,
  } as Record<string, unknown>;
  Object.defineProperty(accessorJournal, "append", { enumerable: true, get() {
    journalGetterCalls++; effects.push("journal-getter"); return f.journal.append;
  } });
  const accessorDependencies = { install() { effects.push("install"); } } as Record<string, unknown>;
  Object.defineProperty(accessorDependencies, "openDatabase", { enumerable: true, get() {
    dependencyGetterCalls++; effects.push("dependency-getter"); return () => effects.push("database");
  } });
  const ordinaryDependencies = dependencies(effects);
  const cases: readonly { journal: unknown; startupDependencies: unknown }[] = [
    { journal: accessorJournal, startupDependencies: ordinaryDependencies },
    { journal: f.journal, startupDependencies: accessorDependencies },
    { journal: Object.create(f.journal), startupDependencies: ordinaryDependencies },
    { journal: { ...f.journal, extra() {} }, startupDependencies: ordinaryDependencies },
    { journal: { ...f.journal, [Symbol("journal")]: () => undefined }, startupDependencies: ordinaryDependencies },
    { journal: f.journal, startupDependencies: Object.create(ordinaryDependencies) },
    { journal: f.journal, startupDependencies: { ...ordinaryDependencies, extra() {} } },
    { journal: f.journal,
      startupDependencies: { ...ordinaryDependencies, [Symbol("dependency")]: () => undefined } },
  ];
  for (const runtime of cases) {
    const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: f.runnerInput,
      operatorSettings: f.settings, operatorTrustedInputs: f.trusted }, runtime);
    assert.equal(assembly.status, "blocked");
    if (assembly.status === "blocked") assert.equal(assembly.blocker, "private_configuration_custody_missing");
  }
  assert.equal(journalGetterCalls, 0); assert.equal(dependencyGetterCalls, 0);
  assert.deepEqual(effects, []); assert.equal(f.reads(), 0); assert.equal(f.appends(), 0); assert.equal(f.hermesCalls(), 0);
});

test("incomplete or unsettled journal, generic readiness and cancellation refuse before every effect port", async t => {
  for (const mode of ["incomplete", "unsettled", "generic", "cancelled"] as const) {
    const f = await fixture(t), effects: string[] = [];
    if (mode === "incomplete") f.move(f.history.slice(0, -1));
    if (mode === "unsettled") f.move(Object.freeze([...f.history.slice(0, -1),
      advanceInstallationPlanV1(f.history.at(-2)!, { expectedRevision: f.history.at(-2)!.revision,
        stage: "final_review", action: "uncertain", outcomeDigest: d("uncertain") })]));
    const runnerInput = mode === "generic" ? { ...f.runnerInput, privateStartupConfiguration: {
      ...f.runnerInput.privateStartupConfiguration, web: { ...f.runnerInput.privateStartupConfiguration.web,
        installationReadiness: createInstallationReadinessV1({ planDigest: f.plan.topologyPlanDigest, proofs: [
          { proof: "backup_restore", state: "passed", evidenceDigest: d("generic") },
          { proof: "local_owner_qualification", state: "passed", evidenceDigest: d("generic-owner") },
          { proof: "local_runner_bridge", state: "passed", evidenceDigest: d("generic-runner") },
        ] }) } } } : f.runnerInput;
    const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput,
      operatorSettings: f.settings, operatorTrustedInputs: f.trusted },
    { journal: f.journal, startupDependencies: dependencies(effects) });
    if (assembly.status === "ready") {
      const controller = new AbortController(); if (mode === "cancelled") controller.abort();
      await assert.rejects(assembly.start(controller.signal),
        /private_local_(?:installation_runtime_assembly|hermes_startup_reverification)_refused/u);
    } else assert.equal(mode, "generic");
    assert.deepEqual(effects, [], mode); assert.equal(f.hermesCalls(), 0, mode); assert.equal(f.appends(), 0, mode);
  }
});

test("callback, runner and queue substitution plus journal movement refuse before effects", async t => {
  for (const mode of ["callback", "runner", "queue", "movement"] as const) {
    const f = await fixture(t), effects: string[] = [];
    const runnerInput = mode === "callback" ? { ...f.runnerInput, privateStartupConfiguration: {
      ...f.runnerInput.privateStartupConfiguration, coordinator: { ...f.runnerInput.privateStartupConfiguration.coordinator,
        hermes021Local: f.makeDelivery() } } } : mode === "runner" ? { ...f.runnerInput,
      admissionPreparationInput: { ...f.runnerInput.admissionPreparationInput, workerBinding: {
        ...f.runnerInput.admissionPreparationInput.workerBinding, workerId: "worker:substituted" } } } : f.runnerInput;
    const settings = mode === "queue" ? { ...f.settings, databaseRoles: { ...f.settings.databaseRoles,
      queueWorker: { ...f.settings.databaseRoles.queueWorker!, username: "substituted_queue" } } } : f.settings;
    const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput, operatorSettings: settings,
      operatorTrustedInputs: f.trusted }, { journal: f.journal, startupDependencies: dependencies(effects) });
    if (mode === "movement" && assembly.status === "ready") {
      f.inspectInOrder(f.history, Object.freeze(f.history.slice(0, -1)));
    }
    if (assembly.status === "ready") await assert.rejects(assembly.start(),
      /private_local_(?:installation_runtime_assembly|hermes_startup_reverification)_refused|agent_task_operator_config/u);
    assert.deepEqual(effects, [], mode); assert.equal(f.hermesCalls(), 0, mode); assert.equal(f.appends(), 0, mode);
  }
});
