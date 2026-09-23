import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";
import { HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from
  "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  prepareLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";
import { prepareLocalHermesAdmissionV1 } from "../src/installer/v1/local-hermes-admission-preparation";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { macosServiceIdentityDigestV1 } from "../src/installer/v1/macos-service-owner-action";
import { PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_FIRST_OWNER_CLEANUP_V1,
  PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1, PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
  type PrivateFirstOwnerRunnerContextV1, type PrivateFirstOwnerRuntimeV1 } from
  "../src/installer/v1/private-first-owner-runner";
import { dispatchPrivateLocalSetupStageV1 } from "../src/installer/v1/private-local-setup-orchestrator";
import { PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1,
  type PrivateRecoveryOwnerRuntimeV1, type PrivateRecoveryRunnerContextV1 } from
  "../src/installer/v1/private-recovery-owner-runner";
import { PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, PRIVATE_MACOS_SERVICE_LABEL_V1,
  PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1 } from
  "../src/installer/v1/private-macos-service-owner-runner";
import { PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1,
  createPrivateMacosServiceToolAdapterV1, type PrivateMacosServiceNativeStepRequestV1 } from
  "../src/installer/v1/private-macos-service-tool-adapter";
import { platformServiceStageInputDigestV1, preparePlatformServiceLifecycleV1 } from
  "../src/installer/v1/platform-service-lifecycle";
import { PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
  type PrivateLocalHermesAdmissionRunnerContextV1 } from "../src/installer/v1/private-local-hermes-admission-runner";
import { PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
  type PrivateInstallationFinalReviewContextV1 } from "../src/installer/v1/private-installation-final-review";
import { prepareProtectedDataV1, protectedDataBindingDigestV1, protectedDataStageInputDigestV1,
  protectedDataStorageBindingsV1, recoveryStageInputDigestV1 } from
  "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivateHermes021LocalInstallationDeliveryV1,
  createPrivateHermes021LocalStartupAdmissionBindingV1 } from
  "../src/web/v1/hermes-021-private-installation-composition";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const releaseDigest = d("exact-release");
const databaseOutcome = d("database-outcome");
const protectedOutcome = d("protected-outcome");
const ownerSource = Object.freeze({ databaseAuthorityOutcomeDigest: databaseOutcome,
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject"), observedOwnerState: "empty" as const,
  observationDigest: d("empty-owner-observation") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"),
  schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [] });


async function fixture() {
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(name => [name, d(`placeholder:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history: InstallationPlanV1[] = [plan];
  for (const selected of ["release_preflight", "private_placement", "database_authority", "protected_data"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome
        : selected === "protected_data" ? protectedOutcome : d(`outcome:${selected}`) }); history.push(plan);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-local-orchestrator-"))); await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  for (const item of history) await journal.append(item);
  const ownerInputDigest = firstOwnerStageInputDigestV1({ releaseDigest,
    databaseAuthorityOutcomeDigest: ownerSource.databaseAuthorityOutcomeDigest,
    bootstrapConfigurationDigest: ownerSource.bootstrapConfigurationDigest,
    trustConfigurationDigest: ownerSource.trustConfigurationDigest,
    expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "first_owner" ? ownerInputDigest : item.inputDigest])) });
  const running = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision,
    stage: "first_owner", action: "start" });
  return { root, journal, plan, running, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function runtimeFor(running: InstallationPlanV1, calls: string[], ceremonyFails = false): PrivateFirstOwnerRuntimeV1 {
  const binding = Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: running.planDigest, installationPlanRevision: running.revision, releaseDigest,
    databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  return Object.freeze({ binding, signal: new AbortController().signal, controlDeadlineMs: 500, cleanupDeadlineMs: 100,
    async confirmOwnerAttachedTerminal(context: PrivateFirstOwnerRunnerContextV1) {
      calls.push("owner-attached"); return { schema: PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, installationId,
        requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerAttached: true as const, confirmed: true as const };
    },
    async runRetainedOwnerBootstrapCeremony() {
      calls.push("ceremony"); if (ceremonyFails) throw new Error("lost ceremony reply");
      return { schema: "control-room.owner-bootstrap-complete/v1" as const, ownerCreated: true as const,
        normalApplicationAvailable: true as const, physicalGatewayAcceptanceComplete: false as const };
    },
    async verifyExistingOwner(context) {
      calls.push("verify-existing-owner"); return { schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
        installationId, requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerConfirmed: true as const, ownerState: "existing" as const, ownerProofDigest: d("owner-proof"),
        ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified" as const };
    },
    async cleanupRetainedOwnerBootstrapCeremony(context) {
      calls.push("cleanup"); return { schema: PRIVATE_FIRST_OWNER_CLEANUP_V1, installationId,
        requestDigest: context.requestDigest, scope: "retained_owner_bootstrap_ceremony" as const,
        outcome: "confirmed" as const };
    },
  });
}

async function recoveryFixture() {
  const schemaDigest = d("recovery-schema"), databaseIdentityDigest = d("recovery-database-identity");
  const protectedObservation = Object.freeze({ observedState: "verified" as const,
    observationDigest: d("verified-protected-root") });
  const storage = captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
    storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results",
    maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
  { releaseId: "release:local", releaseDigest, databaseSchemaVersion: "schema:76", databaseSchemaDigest: schemaDigest });
  const storageBindings = protectedDataStorageBindingsV1(storage);
  const protectedDataBindingDigest = protectedDataBindingDigestV1({ storageConfiguration: storage, ...protectedObservation });
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(name => [name, name === "protected_data"
    ? protectedDataStageInputDigestV1(storageBindings) : name === "recovery"
      ? recoveryStageInputDigestV1({ releaseDigest, topologyPlanDigest: topology.planDigest,
        protectedDataBindingDigest, storageConfigurationDigest: storageBindings.storageConfigurationDigest,
        storageNamespaceDigest: storageBindings.storageNamespaceDigest, databaseAuthorityOutcomeDigest: databaseOutcome,
        expectedDatabaseIdentityDigest: databaseIdentityDigest, expectedDatabaseSchemaDigest: schemaDigest })
      : d(`recovery-placeholder:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history: InstallationPlanV1[] = [plan];
  let protectedDataPreparation: ReturnType<typeof prepareProtectedDataV1> | undefined;
  for (const selected of ["release_preflight", "private_placement", "database_authority", "protected_data", "first_owner"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    history.push(plan);
    if (selected === "protected_data") protectedDataPreparation = prepareProtectedDataV1({ installationPlan: plan,
      storageConfiguration: storage, ...protectedObservation });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome
        : selected === "protected_data" ? protectedDataBindingDigest : d(`recovery-outcome:${selected}`) });
    history.push(plan);
  }
  if (!protectedDataPreparation) throw new Error("protected_data_preparation_missing");
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-local-recovery-orchestrator-")));
  await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  for (const item of history) await journal.append(item);
  const source = Object.freeze({ protectedDataPreparation, storageConfiguration: storage,
    protectedDataObservation: protectedObservation, databaseAuthorityOutcomeDigest: databaseOutcome,
    expectedDatabaseIdentityDigest: databaseIdentityDigest, expectedDatabaseSchemaDigest: schemaDigest,
    observedState: "not_proven" as const, observationDigest: d("recovery-not-proven") });
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest, databaseSchemaVersion: "schema:76", databaseSchemaDigest: schemaDigest,
    storageNamespace: "artifacts:local", storageNamespaceDigest: storageBindings.storageNamespaceDigest,
    entries: [{ artifactId: "artifact:local", contentHash: d("artifact-bytes"), sizeBytes: 5,
      manifestDigest: d("artifact-manifest"), receiptDigest: d("artifact-receipt") }] });
  const proof = createLocalBackupRestoreReadinessV1({ planDigest: topology.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local", releaseDigest,
      databaseIdentityDigest, databaseDumpDigest: d("database-dump"), databaseSchemaVersion: "schema:76",
      databaseSchemaDigest: schemaDigest, restoredToDisposableTarget: true, promoted: false, startsWork: false,
      grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory,
      restored: structuredClone(inventory) }) });
  const running = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "recovery", action: "start" });
  return { root, journal, plan, running, source, proof, protectedDataBindingDigest, stageInputs,
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function recoveryRuntimeFor(fixture: Awaited<ReturnType<typeof recoveryFixture>>, calls: string[], fails = false):
  PrivateRecoveryOwnerRuntimeV1 {
  const binding = Object.freeze({ schema: PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: fixture.running.planDigest, installationPlanRevision: fixture.running.revision,
    topologyPlanDigest: topology.planDigest, releaseDigest, protectedDataBindingDigest: fixture.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: databaseOutcome });
  return Object.freeze({ binding, signal: new AbortController().signal, controlDeadlineMs: 500,
    async confirmOwnerAttachedTerminal(context: PrivateRecoveryRunnerContextV1) {
      calls.push("owner-attached"); return { schema: PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1, installationId,
        requestDigest: context.requestDigest, installationPlanDigest: context.installationPlanDigest,
        installationPlanRevision: context.installationPlanRevision, topologyPlanDigest: context.topologyPlanDigest,
        releaseDigest: context.releaseDigest, protectedDataBindingDigest: context.protectedDataBindingDigest,
        databaseAuthorityOutcomeDigest: context.databaseAuthorityOutcomeDigest,
        ownerAttached: true as const, confirmed: true as const };
    },
    async runExistingBackupRestoreRehearsal() {
      calls.push("existing-rehearsal"); if (fails) throw new Error("lost recovery reply"); return fixture.proof;
    },
  });
}

function memoryJournal(initial: readonly InstallationPlanV1[], authenticatedInstallationId = installationId) {
  const history = [...initial];
  return { history, journal: {
    async readHistory() { return Object.freeze([...history]); },
    async append(plan: InstallationPlanV1) {
      const existing = history[plan.revision];
      if (existing) {
        if (existing.planDigest !== plan.planDigest) throw new Error("journal_conflict");
        return { schema: "control-room.installation-plan-journal/v1" as const,
          installationId: authenticatedInstallationId, revision: plan.revision, planDigest: plan.planDigest,
          replayed: true, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
      }
      if (plan.revision !== history.length) throw new Error("journal_conflict");
      history.push(plan);
      return { schema: "control-room.installation-plan-journal/v1" as const,
        installationId: authenticatedInstallationId, revision: plan.revision, planDigest: plan.planDigest,
        replayed: false, enablesAuthority: false as const, startsService: false as const, startsWorker: false as const };
    },
  } };
}

const servicePackageInput = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1,
  nodePath: "/reviewed/node/bin/node", launcherPath: "/reviewed/releases/v1/run.mjs",
  configurationPath: "/reviewed/protected/config.mjs", workingDirectory: "/reviewed/releases/v1",
  standardOutPath: "/reviewed/protected/service.out.log",
  standardErrorPath: "/reviewed/protected/service.err.log" });

function platformFixture(variant = "current") {
  const package_ = createMacosLocalServicePackageV1(servicePackageInput);
  const authorityDatabaseDigest = d(`service-database-authority:${variant}`),
    protectedDataDigest = d(`service-protected-data:${variant}`);
  const observation = Object.freeze({ state: "not_installed" as const, observationDigest: d(`not-installed:${variant}`) });
  const bindings = Object.freeze({ action: "install" as const, platform: "macos_launchd" as const,
    serviceIdentityDigest: macosServiceIdentityDigestV1(servicePackageInput), authorityDatabaseDigest,
    protectedDataDigest, observation, targetReleaseDigest: releaseDigest,
    targetServiceDefinitionDigest: d(package_.plist) });
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(name => [name,
    name === "platform_service" ? platformServiceStageInputDigestV1({ ...bindings, releaseDigest })
      : d(`service:${variant}:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests });
  const history: InstallationPlanV1[] = [plan];
  for (const name of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("platform_service"))) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: name, action: "pass",
      outcomeDigest: d(`service-proof:${name}`) }); history.push(plan);
  }
  const current = plan;
  const running = advanceInstallationPlanV1(current, { expectedRevision: current.revision,
    stage: "platform_service", action: "start" });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: running.planDigest,
    proofs: (["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure",
      "upgrade_and_rollback_procedure"] as const).map(proof => ({ proof, state: "passed" as const,
      evidenceDigest: d(`service-readiness:${proof}`) })) });
  const lifecycleInput = Object.freeze({ ...bindings, installationPlan: running, supervisorReadiness });
  const lifecycle = preparePlatformServiceLifecycleV1(lifecycleInput);
  const source = Object.freeze({ lifecycle, lifecycleInput, servicePackageInput });
  const store = memoryJournal(history), calls: string[] = [];
  const nativePort = {
    schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1,
    async performStep(request: PrivateMacosServiceNativeStepRequestV1) {
      calls.push(request.operation);
      return { schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1, operation: request.operation,
        outcome: "succeeded" as const, label: request.label, launchAgentPath: request.launchAgentPath,
        requestDigest: request.requestDigest, lifecycleDigest: request.lifecycleDigest, releaseDigest: request.releaseDigest,
        serviceDefinitionDigest: request.serviceDefinitionDigest,
        definitionParentIdentityDigest: request.expectedDefinitionParentIdentityDigest,
        definitionIdentityDigest: request.operation === "install_service_definition"
          ? d("installed-service-definition-identity") : request.expectedDefinitionIdentityDigest,
        serviceIdentityDigest: request.expectedServiceIdentityDigest };
    },
    async observeInstalledService(request: any) {
      calls.push("observe");
      return { schema: PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, requestDigest: request.requestDigest,
        lifecycleDigest: request.lifecycleDigest, installedServiceDefinitionDigest: request.expectedServiceDefinitionDigest,
        serviceObservation: { state: "running", topologyPlanDigest: running.topologyPlanDigest,
          releaseDigest, serviceIdentityDigest: bindings.serviceIdentityDigest, databaseAuthorityDigest: authorityDatabaseDigest,
          protectedDataBindingDigest: protectedDataDigest, supervisorReadinessDigest: supervisorReadiness.readinessDigest,
          observationDigest: d("running-service-observation") } };
    },
    async cleanup() { calls.push("cleanup"); return { outcome: "confirmed" as const }; },
  };
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest: lifecycle.lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: d("launch-agents-parent"), servicePackageInput,
    ownerHome: "/Users/owner", launchAgentPath: `/Users/owner/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`,
    nativePort });
  const runtime = Object.freeze({ signal: new AbortController().signal, controlDeadlineMs: 1_000,
    cleanupDeadlineMs: 200, reviewedServicePackageInput: servicePackageInput,
    async confirmOwnerAttachedTerminal(context: any) {
      calls.push("owner"); return { schema: PRIVATE_MACOS_SERVICE_OWNER_ATTACHED_TERMINAL_V1,
        requestDigest: context.requestDigest, lifecycleDigest: context.lifecycleDigest, action: "install" as const,
        ownerAttached: true as const, confirmed: true as const };
    }, tool });
  return { current, running, source, runtime, store, calls, lifecycle };
}

async function admissionFixture(t: { after(fn: () => unknown): void }) {
  const workerBinding = { localServiceId: "service:hermes", workerId: "worker:hermes", expectedVersion: "0.21.3",
    sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyInput = { databaseAuthorityDigest: d("admission-database"), schedulerAuthorityDigest: d("admission-scheduler"),
    currentRoutes: [], requestedRoutes: [{ kind: "local" as const, workerId: workerBinding.workerId,
      adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: workerBinding.sourceRevision }] };
  const admissionTopology = planInstallationTopologyV1(topologyInput);
  const runnerConfiguration = { executablePath: "/fixture/bin/hermes", profile: "private-profile", model: "private-model",
    provider: "private-provider", workingDirectory: "/fixture/private-project" };
  const runnerQualificationReport = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
    qualified: true, terminalResultObserved: true, sessionDigest: d("admission-session"), inputTokens: 2, outputTokens: 3,
    totalTokens: 5, durationMs: 10, failureReason: "none" as const, retryRequiresFreshOwnerAuthorization: false };
  const qualificationEvidenceDigest = createHermes021MacosLocalRunnerQualificationEvidenceV1(
    runnerQualificationReport).evidenceDigest;
  const qualificationObservation = { state: "passed", topologyPlanDigest: admissionTopology.planDigest, releaseDigest,
    workerBindingDigest: d(workerBinding), runnerConfigurationDigest: localHermesRunnerConfigurationDigestV1(runnerConfiguration),
    qualificationEvidenceDigest, observationDigest: d("admission-qualification") };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:fixture", releaseId: "release:fixture", releaseDigest,
    databaseSchemaVersion: "schema:fixture", databaseSchemaDigest: d("admission-schema"),
    storageNamespace: "storage:fixture", storageNamespaceDigest: d("admission-storage"), entries: [] });
  const backupRestoreProof = createLocalBackupRestoreReadinessV1({ planDigest: admissionTopology.planDigest,
    databaseRestore: { tenantId: inventory.tenantId, releaseId: inventory.releaseId, releaseDigest,
      databaseIdentityDigest: d("admission-database-identity"), databaseDumpDigest: d("admission-dump"),
      databaseSchemaVersion: inventory.databaseSchemaVersion, databaseSchemaDigest: inventory.databaseSchemaDigest,
      restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false,
      permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory,
    restoredArtifactInventory: inventory,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
  const installationReadiness = createInstallationReadinessV1({ planDigest: admissionTopology.planDigest, proofs: [
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: d("admission-owner-proof") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: qualificationEvidenceDigest },
    { proof: "backup_restore", state: "passed", evidenceDigest: backupRestoreProof.proofDigest },
  ] });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: admissionTopology.planDigest,
    proofs: (["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure",
      "upgrade_and_rollback_procedure"] as const).map(proof => ({ proof, state: "passed" as const,
      evidenceDigest: d(`admission:${proof}`) })) });
  const serviceObservation = { state: "running", topologyPlanDigest: admissionTopology.planDigest, releaseDigest,
    serviceIdentityDigest: d("admission-service"), databaseAuthorityDigest: admissionTopology.databaseAuthorityDigest,
    protectedDataBindingDigest: d("admission-protected-data"),
    supervisorReadinessDigest: supervisorReadiness.readinessDigest, observationDigest: d("admission-service-observation") };
  const bound = { topologyPlanDigest: admissionTopology.planDigest, releaseDigest, workerBindingDigest: d(workerBinding),
    runnerConfigurationDigest: qualificationObservation.runnerConfigurationDigest, qualificationEvidenceDigest,
    qualificationObservationDigest: d(qualificationObservation), installationReadinessDigest: installationReadiness.readinessDigest,
    recoveryProofDigest: backupRestoreProof.proofDigest, supervisorReadinessDigest: supervisorReadiness.readinessDigest,
    serviceObservationDigest: localPlatformServiceObservationDigestV1(serviceObservation) };
  let current = createInstallationPlanV1({ topologyPlan: admissionTopology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(name => [name,
      name === "agent_readiness" ? localHermesInstallationStageInputDigestV1(bound) : d(`admission:${name}`)])) });
  const history: InstallationPlanV1[] = [current];
  for (const name of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("agent_readiness"))) {
    current = advanceInstallationPlanV1(current, { expectedRevision: current.revision, stage: name, action: "start" });
    history.push(current);
    current = advanceInstallationPlanV1(current, { expectedRevision: current.revision, stage: name, action: "pass",
      outcomeDigest: name === "protected_data" ? serviceObservation.protectedDataBindingDigest
        : name === "recovery" ? backupRestoreProof.proofDigest
          : name === "platform_service" ? bound.serviceObservationDigest : d(`admission-outcome:${name}`) });
    history.push(current);
  }
  const running = advanceInstallationPlanV1(current, { expectedRevision: current.revision,
    stage: "agent_readiness", action: "start" });
  const installationBindingInput = { installationPlan: running, topologyInput, workerBinding, runnerConfiguration,
    runnerQualificationReport, qualificationObservation, installationReadiness, backupRestoreProof,
    supervisorReadiness, serviceObservation };
  const installationBinding = prepareLocalHermesInstallationBindingV1(installationBindingInput);
  const admissionPreparationInput = { installationId, installationPlan: running, topologyInput, workerBinding,
    installationBinding, installationBindingInput };
  const preparedStore = memoryJournal([...history, running]);
  const preparation = await prepareLocalHermesAdmissionV1(admissionPreparationInput, { journal: preparedStore.journal });
  assert.ok(preparation.admissionRequestDigest);
  const application = await privateAgentTaskCompositionFixture(); t.after(() => application.close());
  const scenario = application.scenario(); let hermesCalls = 0;
  const delivery = createPrivateHermes021LocalInstallationDeliveryV1({ tenantId: scenario.configuration.web.tenantId,
    execution: { preparation: {}, runs: {}, delivery: { binding: workerBinding, db: {}, integrityKey: new Uint8Array(32),
      policy: { assertAdmitted() {} }, terminalResultStorage: {} } }, results: {},
    assertAuthority() { hermesCalls++; }, subprocess: runnerConfiguration });
  const privateStartupConfiguration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined,
    planning: { ...scenario.configuration.coordinator.planning,
      localAdapterAdmission: { enabledAdapters: [HERMES_021_MACOS_LOCAL_ADAPTER_V1] } }, hermes021Local: delivery,
  }, web: { ...scenario.configuration.web, installationTopologyPlan: admissionTopology, installationReadiness,
    localBackupRestoreReadiness: backupRestoreProof, localSupervisorReadiness: supervisorReadiness } };
  const startupAdmissionBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({ delivery,
    queueWorker: privateStartupConfiguration.coordinator.queueWorker, installationBinding,
    topologyPlanDigest: preparation.topologyPlanDigest, releaseDigest: preparation.releaseDigest,
    admissionRequestDigest: preparation.admissionRequestDigest });
  const source = { admissionPreparationInput, privateStartupConfiguration, startupAdmissionBinding };
  const calls: string[] = [];
  const runtime = { signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttachedTerminal(context: PrivateLocalHermesAdmissionRunnerContextV1) {
      calls.push("owner-admission"); return { schema: PRIVATE_LOCAL_HERMES_OWNER_ATTACHED_TERMINAL_V1,
        installationId, requestDigest: context.requestDigest, admissionRequestDigest: context.admissionRequestDigest,
        privateStartupBindingDigest: context.privateStartupBindingDigest,
        installationPlanDigest: context.installationPlanDigest,
        installationPlanRevision: context.installationPlanRevision, ownerAttached: true as const, confirmed: true as const };
    } };
  return { admissionTopology, current, running, history, source, runtime, calls, hermesCalls: () => hermesCalls,
    store: memoryJournal(history) };
}

function input(plan: InstallationPlanV1, requestedStage: "first_owner" | "recovery" | "platform_service"
  | "agent_readiness" | "final_review",
  source: unknown = ownerSource, topologyPlan = topology) {
  return { installationId, expectedPlanRevision: plan.revision, expectedPlanDigest: plan.planDigest,
    expectedReleaseDigest: releaseDigest, requestedStage, topologyPlan, source };
}

test("dispatches the exact next owner stage, settles it once, then exposes the missing recovery seam", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls) });
    assert.equal(result.status, "completed");
    assert.equal(result.installationPlan.stages[4]!.state, "passed");
    assert.deepEqual(calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
    assert.equal(result.createsStateMachine, false); assert.equal(result.createsReceiptStore, false);
    assert.equal(result.exposesBrowserEffect, false); assert.equal(result.suppliesNativeEffect, false);
    const before = (await f.journal.readHistory()).length;
    const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "recovery", {}), { journal: f.journal });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "recovery_private_adapter_missing");
    assert.equal((await f.journal.readHistory()).length, before);
  } finally { await f.cleanup(); }
});

test("installation, release, revision, digest, stage, and runtime substitution refuse before owner confirmation", async () => {
  for (const mutate of [
    (value: ReturnType<typeof input>) => ({ ...value, installationId: "other-installation" }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanRevision: value.expectedPlanRevision + 1 }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanDigest: d("other-plan") }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedReleaseDigest: d("other-release") }),
    (value: ReturnType<typeof input>) => ({ ...value, requestedStage: "recovery" as const, source: {} }),
  ]) {
    const f = await fixture(), calls: string[] = [];
    try {
      await assert.rejects(dispatchPrivateLocalSetupStageV1(mutate(input(f.plan, "first_owner")),
        { journal: f.journal, firstOwner: runtimeFor(f.running, calls) }), /private_local_setup_orchestrator_refused/);
      assert.deepEqual(calls, []);
      assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, f.plan.planDigest);
    } finally { await f.cleanup(); }
  }
});

test("an uncertain owner effect remains running and cannot be dispatched again", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls, true) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "ceremony", "cleanup"]);
    const retained = (await f.journal.readHistory()).at(-1)!;
    assert.equal(retained.stages[4]!.state, "running");
    const retryCalls: string[] = [];
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(retained, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(retained, retryCalls) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(retryCalls, []);
    assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, retained.planDigest);
  } finally { await f.cleanup(); }
});

test("dispatches and settles recovery only through the explicit injected existing-rehearsal runtime", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor(f, calls) });
    assert.equal(result.status, "completed");
    assert.equal(result.installationPlan.stages.find(stage => stage.stage === "recovery")!.state, "passed");
    assert.equal(result.installationPlan.stages.find(stage => stage.stage === "recovery")!.outcomeDigest, f.proof.proofDigest);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal(result.retriesUncertainEffect, false); assert.equal(result.suppliesNativeEffect, false);
    const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "platform_service", {}),
      { journal: f.journal });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "macos_native_service_port_missing");
  } finally { await f.cleanup(); }
});

test("an uncertain recovery remains running and the dispatcher cannot invoke a replacement runtime", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor(f, calls, true) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    const retained = (await f.journal.readHistory()).at(-1)!;
    assert.equal(retained.stages.find(stage => stage.stage === "recovery")!.state, "running");
    const retryCalls: string[] = [];
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(retained, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor({ ...f, running: retained }, retryCalls) }),
    /private_local_setup_orchestrator_refused/);
    assert.deepEqual(retryCalls, []);
  } finally { await f.cleanup(); }
});

test("a later journal refresh cannot be reported as completed recovery", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    let refreshed = false;
    const interleaved = {
      append: f.journal.append.bind(f.journal),
      async readHistory() {
        const history = await f.journal.readHistory(), current = history.at(-1)!;
        if (!refreshed && current.stages.find(stage => stage.stage === "recovery")?.state === "passed") {
          refreshed = true;
          await f.journal.append(refreshInstallationPlanV1(current, { topologyPlan: topology, releaseDigest,
            stageInputDigests: { ...f.stageInputs, recovery: d("changed-after-recovery-settlement") } }));
        }
        return history;
      },
    };
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: interleaved, recovery: recoveryRuntimeFor(f, calls) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state,
      "not_started");
  } finally { await f.cleanup(); }
});

test("simultaneous recovery dispatch publishes one running revision and invokes one rehearsal", async () => {
  const f = await recoveryFixture(), leftCalls: string[] = [], rightCalls: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
        { journal: f.journal, recovery: recoveryRuntimeFor(f, leftCalls) }),
      dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
        { journal: f.journal, recovery: recoveryRuntimeFor(f, rightCalls) }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal([...leftCalls, ...rightCalls].filter(item => item === "existing-rehearsal").length, 1);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "passed");
  } finally { await f.cleanup(); }
});

test("recovery source and runtime methods are captured before journal awaits", async () => {
  const f = await recoveryFixture(), calls: string[] = [], source = structuredClone(f.source) as unknown as Record<string, unknown>;
  let replacementCalled = false, mutated = false;
  const runtime = { ...recoveryRuntimeFor(f, calls) };
  const journal = {
    append: f.journal.append.bind(f.journal),
    async readHistory() {
      const pending = f.journal.readHistory();
      if (!mutated) {
        mutated = true;
        source.observationDigest = d("mutated-after-dispatch");
        runtime.runExistingBackupRestoreRehearsal = async () => {
          replacementCalled = true; throw new Error("replacement must not run");
        };
      }
      return pending;
    },
  };
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", source), { journal, recovery: runtime });
    assert.equal(result.status, "completed"); assert.equal(replacementCalled, false);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
  } finally { await f.cleanup(); }
});

test("malformed recovery source or runtime refuses before publishing running", async () => {
  for (const variant of ["source", "binding", "callable"] as const) {
    const f = await recoveryFixture(), calls: string[] = [];
    try {
      const before = await f.journal.readHistory(), source = structuredClone(f.source) as unknown as Record<string, unknown>;
      const runtime: Record<string, unknown> = { ...recoveryRuntimeFor(f, calls) };
      if (variant === "source") source.observedState = "verified";
      if (variant === "binding") runtime.binding = { ...(runtime.binding as object), releaseDigest: d("wrong-release") };
      if (variant === "callable") runtime.runExistingBackupRestoreRehearsal = "not-callable";
      await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", source),
        { journal: f.journal, recovery: runtime as never }), /private_local_setup_orchestrator_refused/);
      const after = await f.journal.readHistory();
      assert.equal(after.length, before.length, variant);
      assert.equal(after.at(-1)!.planDigest, before.at(-1)!.planDigest, variant);
      assert.deepEqual(calls, [], variant);
    } finally { await f.cleanup(); }
  }
});

test("a lost recovery settlement reply is recovered without rerunning the rehearsal", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    let lost = false;
    const journal = {
      readHistory: f.journal.readHistory.bind(f.journal),
      async append(plan: InstallationPlanV1) {
        if (!lost && plan.stages.find(stage => stage.stage === "recovery")?.state === "passed") {
          lost = true; await f.journal.append(plan); throw new Error("lost-settlement-reply");
        }
        return f.journal.append(plan);
      },
    };
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal, recovery: recoveryRuntimeFor(f, calls) });
    assert.equal(result.status, "completed"); assert.equal(lost, true);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "passed");
  } finally { await f.cleanup(); }
});

test("platform service dispatch uses the exact accepted adapter sequence and advances only that stage", async () => {
  const f = platformFixture();
  const result = await dispatchPrivateLocalSetupStageV1(input(f.current, "platform_service", f.source),
    { journal: f.store.journal, platformService: f.runtime });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.calls, ["owner", ...f.lifecycle.steps.map(step => step.operation), "observe", "cleanup"]);
  assert.equal(result.installationPlan.stages.find(item => item.stage === "platform_service")?.state, "passed");
  assert.equal(result.installationPlan.stages.find(item => item.stage === "agent_readiness")?.state, "not_started");
  assert.equal(result.invokesHermes, false);
  const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "agent_readiness", {}),
    { journal: f.store.journal });
  assert.equal(blocked.blocker, "local_hermes_admission_runtime_missing");
});

test("platform service missing runtime blocks without a journal change; concurrent and lost settlement invoke one adapter", async () => {
  {
    const f = platformFixture(), before = f.store.history.length;
    const blocked = await dispatchPrivateLocalSetupStageV1(input(f.current, "platform_service", {}),
      { journal: f.store.journal });
    assert.equal(blocked.blocker, "macos_native_service_port_missing");
    assert.equal(f.store.history.length, before); assert.deepEqual(f.calls, []);
  }
  {
    const left = platformFixture(), right = platformFixture();
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(left.current, "platform_service", left.source),
        { journal: left.store.journal, platformService: left.runtime }),
      dispatchPrivateLocalSetupStageV1(input(left.current, "platform_service", right.source),
        { journal: left.store.journal, platformService: right.runtime }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal([...left.calls, ...right.calls].filter(item => item === "owner").length, 1);
  }
  {
    const f = platformFixture(); let lost = false;
    const journal = { readHistory: f.store.journal.readHistory,
      async append(plan: InstallationPlanV1) {
        if (!lost && plan.stages.find(item => item.stage === "platform_service")?.state === "passed") {
          lost = true; await f.store.journal.append(plan); throw new Error("lost-platform-settlement");
        }
        return f.store.journal.append(plan);
      } };
    const result = await dispatchPrivateLocalSetupStageV1(input(f.current, "platform_service", f.source),
      { journal, platformService: f.runtime });
    assert.equal(result.status, "completed"); assert.equal(lost, true);
    assert.equal(f.calls.filter(item => item === "owner").length, 1);
  }
});

test("malformed or valid-but-stale service preparation refuses before journal I/O or callbacks", async () => {
  for (const variant of ["malformed", "stale"] as const) {
    const current = platformFixture(), stale = platformFixture("stale");
    let reads = 0, appends = 0;
    const journal = {
      async readHistory() { reads++; return current.store.journal.readHistory(); },
      async append(plan: InstallationPlanV1) { appends++; return current.store.journal.append(plan); },
    };
    const source = variant === "stale" ? stale.source : { ...current.source,
      lifecycle: { ...current.source.lifecycle, lifecycleDigest: d("malformed-lifecycle") } };
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(current.current, "platform_service", source),
      { journal, platformService: current.runtime }), /private_local_setup_orchestrator_refused/u);
    assert.equal(reads, 0, variant); assert.equal(appends, 0, variant);
    assert.deepEqual(current.calls, [], variant); assert.deepEqual(stale.calls, [], variant);
  }
});

test("agent readiness uses the exact factory binding without invoking Hermes, then final review alone completes", async t => {
  const f = await admissionFixture(t);
  const readiness = await dispatchPrivateLocalSetupStageV1(
    input(f.current, "agent_readiness", f.source, f.admissionTopology),
    { journal: f.store.journal, agentReadiness: f.runtime });
  assert.equal(readiness.status, "completed"); assert.deepEqual(f.calls, ["owner-admission"]);
  assert.equal(f.hermesCalls(), 0); assert.equal(readiness.invokesHermes, false);
  assert.equal(readiness.installationPlan.stages.find(item => item.stage === "agent_readiness")?.state, "passed");
  assert.equal(readiness.installationPlan.stages.find(item => item.stage === "final_review")?.state, "not_started");
  const blocked = await dispatchPrivateLocalSetupStageV1(
    input(readiness.installationPlan, "final_review", {}, f.admissionTopology), { journal: f.store.journal });
  assert.equal(blocked.blocker, "final_review_runtime_missing");
  const reviewCalls: string[] = [];
  const reviewed = await dispatchPrivateLocalSetupStageV1(
    input(readiness.installationPlan, "final_review", {}, f.admissionTopology), { journal: f.store.journal,
      finalReview: { signal: new AbortController().signal, controlDeadlineMs: 1_000,
        async confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1) {
          reviewCalls.push("owner-final-review");
          return { schema: PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
            installationId, installationPlanDigest: context.installationPlanDigest,
            installationPlanRevision: context.installationPlanRevision,
            finalReviewInputDigest: context.finalReviewInputDigest, ownerAttached: true as const, confirmed: true as const };
        } } });
  assert.deepEqual(reviewCalls, ["owner-final-review"]); assert.equal(f.hermesCalls(), 0);
  assert.equal(reviewed.installationPlan.stages.find(item => item.stage === "final_review")?.state, "passed");
});

test("stale factory binding and foreign admission identity refuse before journal I/O or owner callback", async t => {
  const f = await admissionFixture(t);
  const startup = f.source.privateStartupConfiguration;
  const admission = f.source.admissionPreparationInput;
  const staleFactoryBinding = createPrivateHermes021LocalStartupAdmissionBindingV1({
    delivery: startup.coordinator.hermes021Local, queueWorker: startup.coordinator.queueWorker,
    installationBinding: admission.installationBinding, topologyPlanDigest: f.admissionTopology.planDigest,
    releaseDigest, admissionRequestDigest: d("stale-factory-admission-request"),
  });
  for (const [variant, changed] of [
    ["stale-factory-binding", { ...f.source, startupAdmissionBinding: staleFactoryBinding }],
    ["foreign-installation", { ...f.source, admissionPreparationInput: {
      ...admission, installationId: "foreign-installation" } }],
  ] as const) {
    let reads = 0, appends = 0;
    const journal = {
      async readHistory() { reads++; return f.store.journal.readHistory(); },
      async append(plan: InstallationPlanV1) { appends++; return f.store.journal.append(plan); },
    };
    await assert.rejects(dispatchPrivateLocalSetupStageV1(
      input(f.current, "agent_readiness", changed, f.admissionTopology),
      { journal, agentReadiness: f.runtime }), /private_local_setup_orchestrator_refused/u);
    assert.equal(reads, 0, variant); assert.equal(appends, 0, variant);
    assert.deepEqual(f.calls, [], variant); assert.equal(f.hermesCalls(), 0, variant);
    assert.equal(f.store.history.at(-1)?.planDigest, f.current.planDigest, variant);
  }
});

test("agent source and owner callback are captured before isolated replay yields", async t => {
  const f = await admissionFixture(t);
  const source = { ...f.source };
  const runtime = { ...f.runtime };
  let replacementCalled = false;
  const pending = dispatchPrivateLocalSetupStageV1(
    input(f.current, "agent_readiness", source, f.admissionTopology),
    { journal: f.store.journal, agentReadiness: runtime });
  source.admissionPreparationInput = { ...source.admissionPreparationInput,
    installationId: "foreign-after-capture" };
  source.privateStartupConfiguration = { ...source.privateStartupConfiguration,
    coordinator: { ...source.privateStartupConfiguration.coordinator, hermes021Local: { async deliver() {} } } };
  source.startupAdmissionBinding = { ...source.startupAdmissionBinding,
    bindingDigest: d("binding-replaced-after-capture") };
  runtime.confirmOwnerAttachedTerminal = async () => {
    replacementCalled = true; throw new Error("replacement callback must not run");
  };
  const result = await pending;
  assert.equal(result.status, "completed"); assert.equal(replacementCalled, false);
  assert.deepEqual(f.calls, ["owner-admission"]); assert.equal(f.hermesCalls(), 0);
  assert.equal(result.installationPlan.stages.find(item => item.stage === "agent_readiness")?.state, "passed");
});

test("concurrent agent admission has one owner confirmation and lost settlement converges without invoking Hermes twice", async t => {
  {
    const left = await admissionFixture(t), right = await admissionFixture(t);
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(left.current, "agent_readiness", left.source, left.admissionTopology),
        { journal: left.store.journal, agentReadiness: left.runtime }),
      dispatchPrivateLocalSetupStageV1(input(left.current, "agent_readiness", right.source, right.admissionTopology),
        { journal: left.store.journal, agentReadiness: right.runtime }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal([...left.calls, ...right.calls].filter(item => item === "owner-admission").length, 1);
    assert.equal(left.hermesCalls() + right.hermesCalls(), 0);
  }
  {
    const f = await admissionFixture(t); let lost = false;
    const journal = { readHistory: f.store.journal.readHistory,
      async append(plan: InstallationPlanV1) {
        if (!lost && plan.stages.find(item => item.stage === "agent_readiness")?.state === "passed") {
          lost = true; await f.store.journal.append(plan); throw new Error("lost-agent-settlement");
        }
        return f.store.journal.append(plan);
      } };
    const result = await dispatchPrivateLocalSetupStageV1(
      input(f.current, "agent_readiness", f.source, f.admissionTopology),
      { journal, agentReadiness: f.runtime });
    assert.equal(result.status, "completed"); assert.equal(lost, true);
    assert.deepEqual(f.calls, ["owner-admission"]); assert.equal(f.hermesCalls(), 0);
  }
});

test("final review concurrency and lost settlement never re-run owner review", async t => {
  const f = await admissionFixture(t);
  const readiness = await dispatchPrivateLocalSetupStageV1(
    input(f.current, "agent_readiness", f.source, f.admissionTopology),
    { journal: f.store.journal, agentReadiness: f.runtime });
  let confirmations = 0;
  const review = { signal: new AbortController().signal, controlDeadlineMs: 1_000,
    async confirmOwnerAttached(context: PrivateInstallationFinalReviewContextV1) {
      confirmations++;
      return { schema: PRIVATE_INSTALLATION_FINAL_REVIEW_OWNER_CONFIRMATION_V1,
        installationId, installationPlanDigest: context.installationPlanDigest,
        installationPlanRevision: context.installationPlanRevision,
        finalReviewInputDigest: context.finalReviewInputDigest, ownerAttached: true as const, confirmed: true as const };
    } };
  let lost = false;
  const journal = { readHistory: f.store.journal.readHistory,
    async append(plan: InstallationPlanV1) {
      if (!lost && plan.stages.find(item => item.stage === "final_review")?.state === "passed") {
        lost = true; await f.store.journal.append(plan); throw new Error("lost-final-settlement");
      }
      return f.store.journal.append(plan);
    } };
  const outcomes = await Promise.allSettled([
    dispatchPrivateLocalSetupStageV1(input(readiness.installationPlan, "final_review", {}, f.admissionTopology),
      { journal, finalReview: review }),
    dispatchPrivateLocalSetupStageV1(input(readiness.installationPlan, "final_review", {}, f.admissionTopology),
      { journal, finalReview: review }),
  ]);
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(confirmations, 1); assert.equal(lost, true); assert.equal(f.hermesCalls(), 0);
});

test("simultaneous dispatch elects one fresh running revision before any owner effect", async () => {
  const f = await fixture(), leftCalls: string[] = [], rightCalls: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, leftCalls) }),
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, rightCalls) }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal([...leftCalls, ...rightCalls].filter(item => item === "owner-attached").length, 1);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[4]!.state, "passed");
  } finally { await f.cleanup(); }
});

test("source directly reuses accepted transactions and runners and imports no browser, scheduler, database, or native effect", async () => {
  const source = await readFile("src/installer/v1/private-local-setup-orchestrator.ts", "utf8");
  for (const retained of ["startPostgresOwnerActionV1",
    "runPrivatePostgresOwnerActionV1", "confirmPostgresOwnerActionTerminalV1",
    "runPrivateProtectedRootOwnerActionV1", "confirmProtectedDataActionTerminalV1",
    "runPrivateFirstOwnerActionV1", "confirmFirstOwnerActionTerminalV1",
    "capturePrivateRecoveryOwnerRuntimePortV1", "verifyPrivateRecoveryOwnerRuntimeV1",
    "runPrivateRecoveryOwnerActionV1", "confirmRecoveryActionTerminalV1",
    "runPrivateMacosServiceOwnerActionV1", "confirmPrivateMacosServiceOwnerActionTerminalV1",
    "runPrivateLocalHermesAdmissionV1", "confirmLocalHermesAdmissionTerminalV1",
    "runPrivateInstallationFinalReviewV1", "confirmPrivateInstallationFinalReviewV1"])
    assert.match(source, new RegExp(retained));
  assert.doesNotMatch(source, /from "(?:node:fs|node:child_process|node:net)"|pg-boss|private-app|launchctl|createServer|setInterval/i);
});
