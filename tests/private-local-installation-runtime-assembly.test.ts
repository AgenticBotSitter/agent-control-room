import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, HERMES_021_SOURCE_REVISION_V1 } from
  "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_MACOS_LOCAL_START_OPERATION_V1 } from
  "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from
  "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from
  "../src/harness/claude-code-v1/task-planning-contract";
import { createInstallationTransitionV1, advanceInstallationTransitionV1 } from
  "../src/harness/v1/installation-transition";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1, refreshInstallationPlanV1,
  type InstallationPlanV1, verifyInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { createPrivateLocalInstallationRuntimeAssemblyV1 } from
  "../src/installer/v1/private-local-installation-runtime-assembly";
import { createPrivateLocalInstallationOperatorV1 } from
  "../src/installer/v1/private-local-installation-operator";
import { createPrivateInstalledLocalHermesRuntimeComposerV1,
  PRIVATE_INSTALLED_LOCAL_HERMES_AGENT_SOURCE_V1,
  PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1 } from
  "../src/installer/v1/private-installed-local-hermes-runtime-composer";
import { PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
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
import { computeAuthorityDigest } from "../src/security/digest";
import { createPrivateHermes021LocalInstallationDeliveryV1,
  } from
  "../src/web/v1/hermes-021-private-installation-composition";
import { privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { isClaudeCodePrivateInstalledDeliverCapabilityV1 } from
  "../src/web/v1/claude-code-private-installation-composition";

const d = (value: unknown) => sha256Digest(value);

function installedSidecar(releaseDigest: string, variant = "current") {
  return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_SIDECAR_IDENTITY_V1,
    releaseVersion: "0.1.0", portableReleaseManifestSha256: releaseDigest,
    outerLauncherManifestSha256: d([variant, "outer"]), sidecarManifestSha256: d([variant, "sidecar"]),
    archiveSha256: d([variant, "archive"]), artifactManifestSha256: d([variant, "artifact"]),
    executableSha256: d([variant, "executable"]), platform: "darwin" as const,
    protocol: "ACRJNL1" as const, architecture: "arm64" as const };
}

function installedRuntimeIdentity(installationId: string, releaseDigest: string, nativeSidecar: unknown,
  workerBinding: unknown, runnerConfiguration: unknown) {
  return d({ purpose: "private-installed-local-hermes-runtime-identity/v1", installationId, releaseDigest,
    nativeSidecarIdentityDigest: d(nativeSidecar), workerBindingDigest: d(workerBinding),
    runnerConfigurationDigest: localHermesRunnerConfigurationDigestV1(runnerConfiguration) });
}

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
  const admissionPreparationInput = { installationId: "fixture-installation", installationPlan: plan,
    topologyInput, workerBinding, installationBinding, installationBindingInput: bindingInput };
  const replay = { async readHistory() { return Object.freeze([...history]); }, async append(value: InstallationPlanV1) {
    return { schema: "control-room.installation-plan-journal/v1" as const, installationId: "fixture-installation",
      revision: value.revision, planDigest: value.planDigest, replayed: true, enablesAuthority: false as const,
      startsService: false as const, startsWorker: false as const };
  } };
  const ownerPreparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput, { journal: replay });
  if (!ownerPreparation.admissionRequestDigest) throw new Error("fixture admission missing");
  const artifactRoot = "/fixture/private-artifacts", artifactNamespace = "fixture-private-artifacts";
  const artifactStorage = { local: { rootPath: artifactRoot, maximumArtifacts: 100, maximumFileBytes: 65_536,
      maximumTotalBytes: 6_553_600, operationTimeoutMs: 1_000 },
    inventory: { releaseId: "release:fixture", releaseDigest, databaseSchemaVersion: inventory.databaseSchemaVersion,
      databaseSchemaDigest: inventory.databaseSchemaDigest, storageNamespace: artifactNamespace,
      storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(artifactNamespace, artifactRoot) } };
  const bootstrapStartupConfiguration = { ...scenario.configuration,
    coordinator: { ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined },
    web: { ...scenario.configuration.web, installationTopologyPlan: topology, installationReadiness,
      localBackupRestoreReadiness: backupRestoreProof, localSupervisorReadiness: supervisorReadiness } };
  const bootstrapPackage = installedComposerPackage({ plan, topology,
    runnerInput: { admissionPreparationInput, privateStartupConfiguration: bootstrapStartupConfiguration,
      startupAdmissionBinding: { admissionRequestDigest: ownerPreparation.admissionRequestDigest } },
    settings: { port: 3210 }, trusted: { artifactStorage } } as never);
  const bootstrapLoaded = await createPrivateInstalledLocalHermesRuntimeComposerV1(
    bootstrapPackage.preparation, bootstrapPackage.ports).custody.loadPrivateConfiguration();
  const privateStartupConfiguration = bootstrapLoaded.assemblyInput.runnerInput.privateStartupConfiguration;
  const startupAdmissionBinding = bootstrapLoaded.assemblyInput.runnerInput.startupAdmissionBinding;
  const delivery = bootstrapLoaded.assemblyInput.operatorTrustedInputs.hermes021Local;
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

function installedComposerPackage(f: any, sidecarVariant = "current"): { preparation: any; ports: any } {
  const startup = f.runnerInput.privateStartupConfiguration, coordinator = startup.coordinator;
  const { localAdapterAdmission: _localAdmission, ...basePlanning } = coordinator.planning;
  const authority = { ...basePlanning.template.authority,
    allowedOperations: [HERMES_021_MACOS_LOCAL_START_OPERATION_V1], maxDurationSeconds: 60, digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const existingHermesTemplate = [basePlanning.template, ...(basePlanning.additionalTemplates ?? [])]
    .find(template => template.adapter === HERMES_021_MACOS_LOCAL_ADAPTER_V1);
  const hermesTemplate = existingHermesTemplate ?? { ...basePlanning.template, id: "template:hermes-text-review",
    adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1, workspaceIntentDigest: undefined, authority };
  const planning = existingHermesTemplate ? basePlanning : { ...basePlanning,
    additionalTemplates: [...(basePlanning.additionalTemplates ?? []), hermesTemplate] };
  const { installationTopologyPlan: _topology, installationReadiness: _readiness,
    localBackupRestoreReadiness: _backup, localSupervisorReadiness: _supervisor,
    installationPlan: _installedPlan, ...web } = startup.web as typeof startup.web & { installationPlan?: unknown };
  const setupSources = Object.fromEntries(["database_authority", "protected_data", "first_owner", "recovery",
    "platform_service", "agent_readiness", "final_review"].map(stage => [stage,
      stage === "agent_readiness" ? { schema: PRIVATE_INSTALLED_LOCAL_HERMES_AGENT_SOURCE_V1 } : {}]));
  const nativeSidecar = installedSidecar(f.plan.releaseDigest, sidecarVariant);
  const runtimeIdentityDigest = installedRuntimeIdentity("fixture-installation", f.plan.releaseDigest,
    nativeSidecar, f.runnerInput.admissionPreparationInput.workerBinding,
    f.runnerInput.admissionPreparationInput.installationBindingInput.runnerConfiguration);
  const configurationWithoutBinding = {
    schema: PRIVATE_INSTALLED_LOCAL_HERMES_CONFIGURATION_V1,
    installationId: "fixture-installation", releaseDigest: f.plan.releaseDigest,
    runtimeIdentityDigest,
    prerequisiteInput: { installationId: "fixture-installation", topologyPlan: f.topology,
      releaseDigest: f.plan.releaseDigest, releasePreflight: {}, privatePlacement: {} },
    settledInstallationPlan: f.plan,
    hermes: { admissionPreparationInput: f.runnerInput.admissionPreparationInput,
      admissionRequestDigest: f.runnerInput.startupAdmissionBinding.admissionRequestDigest,
      runnerConfiguration: f.runnerInput.admissionPreparationInput.installationBindingInput.runnerConfiguration,
      taskPolicy: { adapter: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
        connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
        taskClass: "text_review", tools: "none", maximumTurns: 1, maximumRunBudgetSeconds: 120 } },
    operator: { port: f.settings.port, templateId: hermesTemplate.id },
    database: { host: coordinator.database.host, port: coordinator.database.port,
      database: coordinator.database.database, majorVersion: coordinator.database.majorVersion,
      roles: { web: web.database.username, coordinator: coordinator.database.username,
        results: coordinator.resultDatabase!.username, evidence: coordinator.evidence!.database.username,
        queueWorker: coordinator.queueWorker!.database.username },
      queueConcurrency: coordinator.queueWorker!.concurrency ?? 1 },
    artifactStorage: f.trusted.artifactStorage, setupSources,
  };
  const journal = { rootPath: "/fixture/private-journal", expectedRootIdentity: { device: 1, inode: 2 },
    expectedOwnerUid: 501, expectedRootMode: 0o700 };
  const installedManifestBindingDigest = d({ purpose: "private-installed-local-hermes-configuration-binding/v1",
    installationId: "fixture-installation", journal, nativeSidecar, configuration: configurationWithoutBinding });
  const privateConfigurationData = { ...configurationWithoutBinding, installedManifestBindingDigest };
  const preparation = { schema: PRIVATE_INSTALLED_CONFIGURATION_MANIFEST_BOUND_PREPARATION_V1,
    installationId: "fixture-installation", privateConfigurationData, journal, nativeSidecar,
    dataOnly: true, opensJournal: false, constructsJournal: false, stagesNativeSidecar: false,
    performsNativeOperation: false, writesInstalledManifest: false, autoUpgradesManifest: false };
  const startupBase = { web, coordinator: { planning, routes: coordinator.routes, approvals: coordinator.approvals,
    quality: coordinator.quality, ...(coordinator.revisionPlanning ? { revisionPlanning: coordinator.revisionPlanning } : {}),
    database: coordinator.database, resultDatabase: coordinator.resultDatabase, evidence: coordinator.evidence,
    queueWorker: coordinator.queueWorker } };
  const setupRuntimes = Object.fromEntries(Object.keys(setupSources).map(stage => [stage, undefined]));
  const ports = { startupBase, deliveryIntegrityKey: new Uint8Array(32).fill(177), assertCurrentDelivery() {}, setupRuntimes };
  return { preparation, ports };
}

test("installed data composes the real inert Hermes graph and retains the native-journal owner gate", async t => {
  const f = await fixture(t), input = installedComposerPackage(f);
  const composer = createPrivateInstalledLocalHermesRuntimeComposerV1(input.preparation, input.ports);
  assert.equal(composer.status, "configuration_graph_ready");
  assert.deepEqual(composer.operatorComposition,
    { status: "blocked", blocker: "native_journal_operation_custody_missing" });
  assert.equal(composer.performsEffect, false); assert.equal(composer.startsWorker, false);
  assert.equal(f.hermesCalls(), 0); assert.equal(f.reads(), 0); assert.equal(f.appends(), 0);
  const loaded = await composer.custody.loadPrivateConfiguration();
  assert.equal(loaded.assemblyInput.runnerInput.privateStartupConfiguration.coordinator.queueWorker?.concurrency,
    f.queueWorker.concurrency);
  assert.equal(loaded.setupSources.agent_readiness, loaded.assemblyInput.runnerInput);
  assert.equal(loaded.assemblyInput.operatorTrustedInputs.hermes021Local,
    loaded.assemblyInput.runnerInput.privateStartupConfiguration.coordinator.hermes021Local);
  assert.deepEqual(composer.contracts, { taskClass: "text_review",
    delivery: "control-room.private-hermes-021-local-installation-delivery/v1",
    resultStaging: "control-room.hermes-021-macos-terminal-stage/v1", queue: "pg-boss/postgres",
    startup: "control-room.private-task-startup", setup: "control-room.private-local-setup-orchestrator/v1" });
  const assembly = createPrivateLocalInstallationRuntimeAssemblyV1(loaded.assemblyInput,
    { journal: f.journal, startupDependencies: loaded.startupDependencies });
  assert.equal(assembly.status, "ready");
  if (assembly.status === "ready") {
    const prepared = await assembly.prepare();
    assert.equal(prepared.plan.planDigest, f.plan.planDigest,
      "the source-composed restart identity must reproduce the receipt that settled agent readiness");
  }
  assert.equal(f.hermesCalls(), 0); assert.ok(f.reads() > 0); assert.equal(f.appends(), 0);
});

test("a changed installed runtime identity cannot reuse the settled admission receipt", async t => {
  const f = await fixture(t), changed = installedComposerPackage(f, "replacement");
  const loaded = await createPrivateInstalledLocalHermesRuntimeComposerV1(changed.preparation, changed.ports)
    .custody.loadPrivateConfiguration();
  const assembly = createPrivateLocalInstallationRuntimeAssemblyV1(loaded.assemblyInput,
    { journal: f.journal, startupDependencies: loaded.startupDependencies });
  assert.equal(assembly.status, "ready");
  if (assembly.status === "ready") await assert.rejects(assembly.prepare(),
    /private_local_installation_runtime_assembly_refused|private_local_hermes_admission_runner_unavailable|private_local_hermes_startup_reverification_refused/u);
  assert.equal(f.hermesCalls(), 0); assert.equal(f.appends(), 0);
});

test("installed composer rejects foreign, mutated, secret-bearing and callback-shaped input before effects", async t => {
  const f = await fixture(t), input = installedComposerPackage(f), effects = () => {
    assert.equal(f.hermesCalls(), 0); assert.equal(f.reads(), 0); assert.equal(f.appends(), 0);
  };
  const mutate = (fn: (copy: any) => void) => {
    const copy = structuredClone(input.preparation); fn(copy);
    assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(copy, input.ports),
      /private_installed_local_hermes_runtime_composer_refused/u); effects();
  };
  mutate(copy => { copy.installationId = "foreign-installation"; });
  mutate(copy => { copy.nativeSidecar.archiveSha256 = d("mutated"); });
  mutate(copy => { copy.privateConfigurationData.hermes.taskPolicy.tools = "browser"; });
  mutate(copy => { copy.privateConfigurationData.setupSources.final_review = { credential: "forbidden" }; });
  const getterPorts = { ...input.ports, get assertCurrentDelivery() { effects(); return () => {}; } };
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(input.preparation, getterPorts),
    /private_installed_local_hermes_runtime_composer_refused/u);
  const proxyPorts = { ...input.ports, startupBase: new Proxy(input.ports.startupBase, {}) };
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(input.preparation, proxyPorts),
    /private_installed_local_hermes_runtime_composer_refused/u); effects();
});

test("installed capture refuses array and sidecar accessors or proxies without executing them", async t => {
  const f = await fixture(t), input = installedComposerPackage(f); let traps = 0;
  const getterPreparation = structuredClone(input.preparation);
  const stages = getterPreparation.privateConfigurationData.settledInstallationPlan.stages;
  Object.defineProperty(stages, "0", { enumerable: true, configurable: true, get() { traps++; return {}; } });
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(getterPreparation, input.ports),
    /private_installed_local_hermes_runtime_composer_refused/u);
  assert.equal(traps, 0);
  const proxyArrayPreparation = structuredClone(input.preparation);
  const originalStages = proxyArrayPreparation.privateConfigurationData.settledInstallationPlan.stages;
  (proxyArrayPreparation.privateConfigurationData.settledInstallationPlan as { stages: unknown }).stages = new Proxy(originalStages,
    { get(target, property, receiver) { traps++; return Reflect.get(target, property, receiver); } });
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(proxyArrayPreparation, input.ports),
    /private_installed_local_hermes_runtime_composer_refused/u);
  assert.equal(traps, 0);
  const sidecarGetter = structuredClone(input.preparation);
  Object.defineProperty(sidecarGetter.nativeSidecar, "archiveSha256",
    { enumerable: true, configurable: true, get() { traps++; return d("trap"); } });
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(sidecarGetter, input.ports),
    /private_installed_local_hermes_runtime_composer_refused/u);
  assert.equal(traps, 0);
  const proxiedSidecar = { ...input.preparation, nativeSidecar: new Proxy(input.preparation.nativeSidecar, {
    ownKeys(target) { traps++; return Reflect.ownKeys(target); } }) };
  assert.throws(() => createPrivateInstalledLocalHermesRuntimeComposerV1(proxiedSidecar, input.ports),
    /private_installed_local_hermes_runtime_composer_refused/u);
  assert.equal(traps, 0);
});

test("post-compose caller mutation cannot alter the captured startup graph", async t => {
  const f = await fixture(t), input = installedComposerPackage(f);
  const composer = createPrivateInstalledLocalHermesRuntimeComposerV1(input.preparation, input.ports);
  const queueWorker = input.ports.startupBase.coordinator.queueWorker!;
  const original = queueWorker.concurrency;
  queueWorker.concurrency = original === 1 ? 2 : 1;
  const loaded = await composer.custody.loadPrivateConfiguration();
  assert.equal(loaded.assemblyInput.runnerInput.privateStartupConfiguration.coordinator.queueWorker?.concurrency,
    original);
  assert.equal(loaded.assemblyInput.operatorSettings.queueWorkerConcurrency, original);
});

test("installed identity recreates the same startup binding while source capabilities remain branded per composition", async t => {
  const f = await fixture(t), input = installedComposerPackage(f);
  const first = await createPrivateInstalledLocalHermesRuntimeComposerV1(input.preparation, input.ports)
    .custody.loadPrivateConfiguration();
  const second = await createPrivateInstalledLocalHermesRuntimeComposerV1(structuredClone(input.preparation), input.ports)
    .custody.loadPrivateConfiguration();
  assert.equal(first.assemblyInput.runnerInput.startupAdmissionBinding.compositionInstanceDigest,
    second.assemblyInput.runnerInput.startupAdmissionBinding.compositionInstanceDigest);
  assert.equal(first.assemblyInput.runnerInput.startupAdmissionBinding.bindingDigest,
    second.assemblyInput.runnerInput.startupAdmissionBinding.bindingDigest);
  assert.notEqual(first.assemblyInput.operatorTrustedInputs.hermes021Local,
    second.assemblyInput.operatorTrustedInputs.hermes021Local);
  assert.equal(f.hermesCalls(), 0); assert.equal(f.reads(), 0); assert.equal(f.appends(), 0);
});

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
  const captured = finalReviewConfiguration(f, effects, async context => {
    originalCalls += 1;
    return finalReviewConfirmation(context);
  });
  // The installed composer intentionally returns a frozen graph. This race
  // test exercises the operator's own capture boundary, so give it a mutable
  // caller-owned wrapper and mutate that wrapper after the awaited read begins.
  const loaded = { ...captured, assemblyInput: { ...captured.assemblyInput,
    runnerInput: { ...captured.assemblyInput.runnerInput,
      admissionPreparationInput: { ...captured.assemblyInput.runnerInput.admissionPreparationInput },
      privateStartupConfiguration: { ...captured.assemblyInput.runnerInput.privateStartupConfiguration,
        coordinator: { ...captured.assemblyInput.runnerInput.privateStartupConfiguration.coordinator } } } } };
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

async function additiveClaudePackage(f: Awaited<ReturnType<typeof fixture>>, options: Readonly<{
  installationId?: string; compositionAdapterId?: string;
}> = {}) {
  const admissionPreparation = f.runnerInput.admissionPreparationInput as unknown as {
    installationId: string; topologyInput: { databaseAuthorityDigest: string; schedulerAuthorityDigest: string;
      currentRoutes: readonly unknown[]; requestedRoutes: readonly unknown[] };
    installationBindingInput: { serviceObservation: unknown } };
  const installationId = options.installationId ?? admissionPreparation.installationId;
  const workerRoute = { kind: "local" as const, workerId: "worker:claude-additive",
    adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "revision-claude-additive-0001" };
  const transitionInput = { databaseAuthorityDigest: f.topology.databaseAuthorityDigest,
    schedulerAuthorityDigest: f.topology.schedulerAuthorityDigest,
    currentRoutes: admissionPreparation.topologyInput.requestedRoutes,
    requestedRoutes: [...admissionPreparation.topologyInput.requestedRoutes, workerRoute] };
  const topology = planInstallationTopologyV1(transitionInput);
  const processConfiguration = { schema: "control-room.claude-code-private-installed-process-host-configuration/v1" as const,
    process: { executablePath: "/private/bin/claude", args: ["--print"],
      workingDirectory: "/private/workspace", cleanupMs: 100 }, executableSha256: d("claude-executable"),
    workingDirectoryBindingDigest: d("claude-workspace"), qualificationDigest: d("claude-qualification"),
    startupDeadlineMs: 100, terminateDeadlineMs: 100, killDeadlineMs: 100 };
  const processConfigurationDigest = d({ purpose: "local-claude-installed-process-configuration/v1",
    configuration: processConfiguration });
  const processReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: topology.planDigest,
    proofs: (["installed_process_identity", "permission_boundary", "cancellation_and_restart_recovery"] as const)
      .map(proof => ({ proof, state: "passed" as const, evidenceDigest: d(`claude:${proof}`) })) });
  const processObservation = { state: "passed" as const, topologyPlanDigest: topology.planDigest,
    releaseDigest: f.plan.releaseDigest, workerRouteDigest: d(workerRoute),
    connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, processConfigurationDigest,
    processReadinessDigest: processReadiness.readinessDigest, observationDigest: d("claude-process-observation") };
  const protectedResultStorage = f.trusted.artifactStorage!;
  const serviceObservation = admissionPreparation.installationBindingInput.serviceObservation;
  const transitionId = "transition:add-local-claude";
  const reviewedMaterial = { installationId, originalInstallationPlanDigest: f.plan.planDigest,
    originalInstallationPlanRevision: f.plan.revision, originalTopologyPlanDigest: f.topology.planDigest,
    transitionId, transitionPlanDigest: topology.planDigest, databaseAuthorityDigest: topology.databaseAuthorityDigest,
    schedulerAuthorityDigest: topology.schedulerAuthorityDigest, requestedRouteDigest: topology.requestedRouteDigest,
    workerRouteDigest: d(workerRoute), workerId: workerRoute.workerId, adapterId: workerRoute.adapterId,
    adapterRevision: workerRoute.adapterRevision, connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    processConfigurationDigest, processReadinessDigest: processReadiness.readinessDigest,
    processObservationDigest: d(processObservation), protectedResultStorageDigest: d(protectedResultStorage),
    serviceObservationDigest: d(serviceObservation), releaseDigest: f.plan.releaseDigest,
    workspaceBindingDigest: processConfiguration.workingDirectoryBindingDigest };
  const evidenceDigest = d({ purpose: "local-claude-post-install-reviewed-evidence/v1", admission: reviewedMaterial });
  let transition = createInstallationTransitionV1({ transitionId, topologyPlan: topology, now: "2026-09-22T00:00:00.000Z" });
  for (const [action, second] of [["pause_admission", 1], ["record_drain", 2], ["verify_proofs", 3], ["commit", 4]] as const)
    transition = advanceInstallationTransitionV1(transition, { expectedRevision: transition.revision, action,
      now: `2026-09-22T00:00:0${second}.000Z`, evidenceDigest });
  let transitionReads = 0;
  const compositionAdapterId = options.compositionAdapterId ?? CLAUDE_CODE_LOCAL_ADAPTER_V1;
  return { transitionReads: () => transitionReads, claudePostInstall: {
    admissionInput: { installationId, originalInstallationPlan: f.plan,
      originalTopologyInput: admissionPreparation.topologyInput, transitionTopologyInput: transitionInput,
      transitionId, workerRoute, requestedRoutes: transitionInput.requestedRoutes,
      installedProcessConfiguration: processConfiguration, processReadiness, processObservation,
      protectedResultStorage, serviceObservation, permittedWorkspace: { workspaceId: "workspace:fixture",
        workingDirectory: processConfiguration.process.workingDirectory,
        bindingDigest: processConfiguration.workingDirectoryBindingDigest } },
    admissionRuntime: { async readOriginalInstallationHistory() { return f.history; },
      async readTransition() { transitionReads++; return transition; } },
    compositionInput: { tenantId: "tenant:fixture", installedProcessConfiguration: processConfiguration,
      ports: { async verifyInstallation() { throw new Error("not invoked during startup"); },
        launch() { throw new Error("not invoked during startup"); } },
      execution: { preparation: {} as never, runs: {} as never,
        delivery: { db: {} as never, integrityKey: new Uint8Array(32), binding: { workerId: workerRoute.workerId,
          adapterId: compositionAdapterId, adapterRevision: workerRoute.adapterRevision, authorityDigest: d("authority"),
          acceptanceProfileId: "profile:claude", acceptanceProfileDigest: d("acceptance") },
          authority: {} as never, receiptPort: {} as never, recheckBeforeAcquire: async () => {}, cleanupMs: 100,
          clock: () => 0 }, results: {} as never,
        protectedStorage: { async put() { throw new Error("not invoked during startup"); },
          async read() { throw new Error("not invoked during startup"); } } },
      assertCurrentProcess() {}, assertCurrentDelivery() {} } } };
}

test("additive Claude is reread, branded and carried through operator assembly to final startup while Hermes remains", async t => {
  const f = await fixture(t), sequence: string[] = [];
  const claude = await additiveClaudePackage(f);
  const settings = { ...f.settings, features: { ...f.settings.features, claudeCodeLocal: true } };
  const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: f.runnerInput,
    operatorSettings: settings, operatorTrustedInputs: f.trusted, claudePostInstall: claude.claudePostInstall },
  { journal: f.journal, startupDependencies: startupBoundaryDependencies(sequence) });
  assert.equal(assembly.status, "ready");
  if (assembly.status !== "ready") return;
  const prepared = await assembly.prepare();
  assert.equal(claude.transitionReads(), 1, "committed transition is reread before configuration exposure");
  assert.equal(isClaudeCodePrivateInstalledDeliverCapabilityV1(prepared.configuration.coordinator.claudeCodeLocal), true);
  assert.equal(prepared.configuration.coordinator.hermes021Local, f.delivery, "bootstrap Hermes remains exact");
  await assert.rejects(assembly.start(), /private_task_startup_prerequisites_failed/u);
  assert.equal(claude.transitionReads(), 2, "final startup performs a fresh transition reread");
  assert.deepEqual(sequence, ["artifact-storage"], "first startup effect occurs only after both rereads");
});

test("foreign installation and substituted Claude adapter refuse after transition reread and before startup effects", async t => {
  for (const mode of ["foreign", "adapter"] as const) {
    const f = await fixture(t), effects: string[] = [];
    const claude = await additiveClaudePackage(f, mode === "foreign" ? { installationId: "installation:foreign" }
      : { compositionAdapterId: "connector:substituted" });
    const assembly = createPrivateLocalInstallationRuntimeAssemblyV1({ runnerInput: f.runnerInput,
      operatorSettings: { ...f.settings, features: { ...f.settings.features, claudeCodeLocal: true } },
      operatorTrustedInputs: f.trusted, claudePostInstall: claude.claudePostInstall },
    { journal: f.journal, startupDependencies: dependencies(effects) });
    assert.equal(assembly.status, "ready");
    if (assembly.status === "ready") await assert.rejects(assembly.prepare(),
      /local_claude_post_install_admission_refused|private_local_installation_runtime_assembly_refused|claude_code_private_installation_composition_unavailable/u);
    assert.equal(claude.transitionReads(), mode === "foreign" ? 0 : 1, mode);
    assert.deepEqual(effects, [], mode);
  }
});
