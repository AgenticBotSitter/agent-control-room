import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1/connector-profile";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1, HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from "../src/harness/hermes-021-v1/runner-qualification-evidence";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { localHermesInstallationStageInputDigestV1, localHermesRunnerConfigurationDigestV1,
  localHermesServiceObservationDigestV1, prepareLocalHermesInstallationBindingV1,
  verifyLocalHermesInstallationBindingV1 } from "../src/installer/v1/local-hermes-installation-binding";

const d = (value: unknown) => sha256Digest(value);
function fixture(remote = false) {
  const workerBinding = { localServiceId: "service:hermes", workerId: "worker:hermes", expectedVersion: "0.21.3",
    sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyInput = { databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"), currentRoutes: [],
    requestedRoutes: [{ kind: "local", workerId: workerBinding.workerId, adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
      adapterRevision: workerBinding.sourceRevision }, ...(remote ? [{ kind: "remote", workerId: "worker:remote",
      adapterId: "connector:remote", adapterRevision: "0000001" }] : [])] };
  const topology = planInstallationTopologyV1(topologyInput), releaseDigest = d("release");
  const runnerConfiguration = { executablePath: "/fixture/bin/hermes", profile: "private-profile", model: "private-model",
    provider: "private-provider", workingDirectory: "/fixture/private-project" };
  const runnerQualificationReport = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1,
    qualified: true, terminalResultObserved: true, sessionDigest: d("session"), inputTokens: 5, outputTokens: 3,
    totalTokens: 8, durationMs: 100, failureReason: "none", retryRequiresFreshOwnerAuthorization: false };
  const qualificationEvidenceDigest = createHermes021MacosLocalRunnerQualificationEvidenceV1(runnerQualificationReport).evidenceDigest;
  const qualificationObservation = { state: "passed", topologyPlanDigest: topology.planDigest, releaseDigest,
    workerBindingDigest: d(workerBinding), runnerConfigurationDigest: localHermesRunnerConfigurationDigestV1(runnerConfiguration),
    qualificationEvidenceDigest, observationDigest: d("qualification-observation") };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:fixture", releaseId: "release:fixture", releaseDigest,
    databaseSchemaVersion: "schema:fixture", databaseSchemaDigest: d("schema"),
    storageNamespace: "storage:fixture", storageNamespaceDigest: d("storage"), entries: [] });
  const backupRestoreProof = createLocalBackupRestoreReadinessV1({ planDigest: topology.planDigest,
    databaseRestore: { tenantId: inventory.tenantId, releaseId: inventory.releaseId, releaseDigest,
      databaseIdentityDigest: d("database-identity"), databaseDumpDigest: d("dump"),
      databaseSchemaVersion: inventory.databaseSchemaVersion, databaseSchemaDigest: inventory.databaseSchemaDigest,
      restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false,
      permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: inventory,
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
    serviceObservationDigest: localHermesServiceObservationDigestV1(serviceObservation) };
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
      stage === "agent_readiness" ? localHermesInstallationStageInputDigestV1(bound) : d(stage)])) });
  for (const stage of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("agent_readiness"))) {
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "start" });
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "pass",
      outcomeDigest: stage === "recovery" ? backupRestoreProof.proofDigest : stage === "platform_service"
        ? bound.serviceObservationDigest : stage === "protected_data" ? serviceObservation.protectedDataBindingDigest : d(`outcome:${stage}`) });
  }
  installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage: "agent_readiness", action: "start" });
  return { installationPlan, topologyInput, workerBinding, runnerConfiguration, runnerQualificationReport,
    qualificationObservation, installationReadiness, supervisorReadiness, serviceObservation, backupRestoreProof };
}
const refuses = (run: () => unknown) => assert.throws(run, /^Error: local_hermes_installation_binding_refused$/);

test("joins the existing local installation evidence without enabling or starting Hermes", () => {
  const input = fixture(), before = structuredClone(input), prepared = prepareLocalHermesInstallationBindingV1(input);
  assert.equal(prepared.taskClass, "text_review");
  assert.equal(prepared.stage, "agent_readiness");
  assert.equal(prepared.nextOperation, "owner_review_local_hermes_enablement");
  for (const key of ["startsWork", "enablesWorker", "grantsExecutionAuthority", "createsCallback"] as const) assert.equal(prepared[key], false);
  assert.deepEqual(input, before);
  assert.deepEqual(verifyLocalHermesInstallationBindingV1(prepared, input), prepared);
  assert.equal(input.installationPlan.stages.find(item => item.stage === "agent_readiness")?.state, "running");
  assert.doesNotMatch(JSON.stringify(prepared), /fixture|private-profile|private-model|private-provider|worker:|service:|session|executablePath|workingDirectory/);
});

test("local readiness still works in a mixed topology without claiming remote proof", () => {
  const input = fixture(true), prepared = prepareLocalHermesInstallationBindingV1(input);
  assert.equal(prepared.enablesWorker, false);
  assert.equal(input.installationReadiness.proofs.length, 3);
});

test("rejects configuration changes even with an unchanged successful runner report", () => {
  const input = fixture(), prepared = prepareLocalHermesInstallationBindingV1(input);
  for (const [key, value] of Object.entries({ executablePath: "/different/hermes", profile: "other", model: "other",
    provider: "other", workingDirectory: "/different/work", maximumRunBudgetSeconds: 15 })) {
    refuses(() => verifyLocalHermesInstallationBindingV1(prepared,
      { ...input, runnerConfiguration: { ...input.runnerConfiguration, [key]: value } }));
  }
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    qualificationObservation: { ...input.qualificationObservation, workerBindingDigest: d("other") } }));
});

test("refuses changed runner success evidence and failed or withdrawn qualification", () => {
  const input = fixture();
  for (const state of ["failed", "uncertain", "revoked"]) refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    qualificationObservation: { ...input.qualificationObservation, state } }));
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    runnerQualificationReport: { ...input.runnerQualificationReport, qualified: false } }));
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    runnerQualificationReport: { ...input.runnerQualificationReport, sessionDigest: d("another-session") } }));
});

test("refuses stopped, revoked, uncertain, failed and changed service observations", () => {
  const input = fixture();
  for (const state of ["stopped", "failed", "uncertain", "revoked"]) refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    serviceObservation: { ...input.serviceObservation, state } }));
  for (const key of ["releaseDigest", "databaseAuthorityDigest", "serviceIdentityDigest", "protectedDataBindingDigest",
    "supervisorReadinessDigest", "observationDigest"]) refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    serviceObservation: { ...input.serviceObservation, [key]: d("changed") } }));
});

test("refuses missing, failed, unavailable and mismatched readiness or recovery", () => {
  const input = fixture();
  for (const proof of ["local_owner_qualification", "local_runner_bridge", "backup_restore"] as const) {
    for (const state of ["not_started", "failed", "unavailable"] as const) {
      const installationReadiness = createInstallationReadinessV1({ planDigest: input.installationReadiness.planDigest,
        proofs: input.installationReadiness.proofs.map(item => item.proof === proof ? { proof, state } : item) });
      refuses(() => prepareLocalHermesInstallationBindingV1({ ...input, installationReadiness }));
    }
  }
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input, backupRestoreProof: undefined }));
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    backupRestoreProof: { ...input.backupRestoreProof, releaseDigest: d("changed") } }));
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: input.supervisorReadiness.planDigest, proofs: [] });
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input, supervisorReadiness }));
});

test("refuses topology changes, wrong worker and unreviewed Hermes source revision", () => {
  const input = fixture();
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    topologyInput: { ...input.topologyInput, schedulerAuthorityDigest: d("another-scheduler") } }));
  for (const change of [{ workerId: "worker:other" }, { sourceRevision: "a".repeat(40) }, { localServiceId: "service:other" }]) {
    refuses(() => prepareLocalHermesInstallationBindingV1({ ...input, workerBinding: { ...input.workerBinding, ...change } }));
  }
});

test("refuses stage completion, uncertainty and changed saved preparation", () => {
  const input = fixture(), prepared = prepareLocalHermesInstallationBindingV1(input);
  for (const action of ["pass", "fail", "uncertain"] as const) {
    const installationPlan = advanceInstallationPlanV1(input.installationPlan, { expectedRevision: input.installationPlan.revision,
      stage: "agent_readiness", action, outcomeDigest: d("outcome") });
    refuses(() => verifyLocalHermesInstallationBindingV1(prepared, { ...input, installationPlan }));
  }
  refuses(() => verifyLocalHermesInstallationBindingV1({ ...prepared, enablesWorker: true }, input));
  const { preparationDigest: _old, ...changed } = { ...prepared, serviceObservationDigest: d("changed") };
  refuses(() => verifyLocalHermesInstallationBindingV1({ ...changed, preparationDigest: d(changed) }, input));
});

test("invalid private inputs produce only a constant redacted error", () => {
  const input = fixture();
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    runnerConfiguration: { ...input.runnerConfiguration, provider: "SECRET INVALID VALUE" } }));
  refuses(() => prepareLocalHermesInstallationBindingV1({ ...input,
    qualificationObservation: { ...input.qualificationObservation, secret: "private" } }));
});
