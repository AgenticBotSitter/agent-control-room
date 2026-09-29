import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest as d } from "../src/security/canonical-digest";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 } from "../src/harness/claude-code-v1/task-planning-contract";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { localClaudeInstallationStageInputDigestV1, localClaudeProcessConfigurationDigestV1,
  prepareLocalClaudeInstallationBindingV1, verifyLocalClaudeInstallationBindingV1 } from "../src/installer/v1/local-claude-installation-binding";

function fixture() {
  const workerRoute = { kind: "local", workerId: "worker:claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "fixture-revision" };
  const topologyInput = { databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [workerRoute] };
  const topology = planInstallationTopologyV1(topologyInput), releaseDigest = d("release");
  const connectorProfileDigest = CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1;
  const processConfiguration = { executablePath: "/fixture/bin/claude", args: ["--fixture-only"], workingDirectory: "/fixture/private", cleanupMs: 2000 };
  const processReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: topology.planDigest,
    proofs: (["installed_process_identity", "permission_boundary", "cancellation_and_restart_recovery"] as const)
      .map(proof => ({ proof, state: "passed", evidenceDigest: d(proof) })) });
  const processObservation = { state: "passed", topologyPlanDigest: topology.planDigest, releaseDigest,
    workerRouteDigest: d(workerRoute), connectorProfileDigest,
    processConfigurationDigest: localClaudeProcessConfigurationDigestV1(processConfiguration),
    processReadinessDigest: processReadiness.readinessDigest, observationDigest: d("process-observation") };
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
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: processReadiness.readinessDigest },
    { proof: "backup_restore", state: "passed", evidenceDigest: backupRestoreProof.proofDigest },
  ] });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: topology.planDigest,
    proofs: (["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure",
      "upgrade_and_rollback_procedure"] as const).map(proof => ({ proof, state: "passed", evidenceDigest: d(proof) })) });
  const serviceObservation = { state: "running", topologyPlanDigest: topology.planDigest, releaseDigest,
    serviceIdentityDigest: d("service"), databaseAuthorityDigest: topology.databaseAuthorityDigest,
    protectedDataBindingDigest: d("protected-data"), supervisorReadinessDigest: supervisorReadiness.readinessDigest,
    observationDigest: d("service-observation") };
  const bound = { topologyPlanDigest: topology.planDigest, releaseDigest, workerRouteDigest: d(workerRoute),
    connectorProfileDigest, processConfigurationDigest: processObservation.processConfigurationDigest,
    processReadinessDigest: processReadiness.readinessDigest, processObservationDigest: d(processObservation),
    installationReadinessDigest: installationReadiness.readinessDigest, recoveryProofDigest: backupRestoreProof.proofDigest,
    supervisorReadinessDigest: supervisorReadiness.readinessDigest, serviceObservationDigest: localPlatformServiceObservationDigestV1(serviceObservation) };
  let installationPlan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
      stage === "agent_readiness" ? localClaudeInstallationStageInputDigestV1(bound) : d(stage)])) });
  for (const stage of installationSetupStagesV1.slice(0, installationSetupStagesV1.indexOf("agent_readiness"))) {
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "start" });
    installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage, action: "pass",
      outcomeDigest: stage === "recovery" ? backupRestoreProof.proofDigest : stage === "platform_service"
        ? bound.serviceObservationDigest : stage === "protected_data" ? serviceObservation.protectedDataBindingDigest : d(`outcome:${stage}`) });
  }
  installationPlan = advanceInstallationPlanV1(installationPlan, { expectedRevision: installationPlan.revision, stage: "agent_readiness", action: "start" });
  return { installationPlan, topologyInput, workerRoute, connectorProfileDigest, processConfiguration, processReadiness,
    processObservation, installationReadiness, supervisorReadiness, serviceObservation, backupRestoreProof };
}
const refuses = (run: () => unknown) => assert.throws(run, /^Error: local_claude_installation_binding_refused$/);

test("Claude installer binds exact existing evidence but creates no process or admission", () => {
  const input = fixture(), before = structuredClone(input), prepared = prepareLocalClaudeInstallationBindingV1(input);
  assert.deepEqual(verifyLocalClaudeInstallationBindingV1(prepared, input), prepared);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(prepared));
  assert.equal(prepared.nextOperation, "qualified_private_process_host_required");
  for (const flag of ["startsWork", "enablesWorker", "grantsExecutionAuthority", "createsCallback", "permitsRetry", "permitsResume"] as const)
    assert.equal(prepared[flag], false);
  assert.doesNotMatch(JSON.stringify(prepared), /fixture|worker:|executablePath|workingDirectory|args/);
  input.processConfiguration.args.push("--changed");
  refuses(() => verifyLocalClaudeInstallationBindingV1(prepared, input));
});

test("Claude refuses private configuration drift and resume before considering passed proof", () => {
  const input = fixture(), prepared = prepareLocalClaudeInstallationBindingV1(input);
  for (const change of [{ executablePath: "/other/claude" }, { workingDirectory: "/other/private" },
    { args: ["--other"] }, { cleanupMs: 1000 }, { args: ["--resume"] }, { environment: { SECRET: "private" } }]) {
    refuses(() => verifyLocalClaudeInstallationBindingV1(prepared, { ...input, processConfiguration: { ...input.processConfiguration, ...change } }));
  }
});

test("Claude refuses missing, changed, revoked or uncertain process observations", () => {
  const input = fixture();
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, processObservation: undefined }));
  for (const state of ["failed", "uncertain", "revoked"]) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    processObservation: { ...input.processObservation, state } }));
  for (const key of ["topologyPlanDigest", "releaseDigest", "workerRouteDigest", "connectorProfileDigest",
    "processConfigurationDigest", "processReadinessDigest", "observationDigest"]) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    processObservation: { ...input.processObservation, [key]: d("changed") } }));
});

test("Claude refuses every incomplete process proof and coherent evidence replacement", () => {
  const input = fixture();
  for (const proof of input.processReadiness.proofs) {
    for (const state of ["not_started", "failed", "unavailable"] as const) {
      const processReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: input.processReadiness.planDigest,
        proofs: input.processReadiness.proofs.map(item => item.proof === proof.proof
          ? { proof: item.proof, state, ...(state === "failed" ? { evidenceDigest: d(`failed:${item.proof}`) } : {}) }
          : item) });
      refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, processReadiness }));
    }
  }
  const processReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: input.processReadiness.planDigest,
    proofs: input.processReadiness.proofs.map(item => ({ ...item, evidenceDigest: d("replacement") })) });
  const processObservation = { ...input.processObservation, processReadinessDigest: processReadiness.readinessDigest };
  const installationReadiness = createInstallationReadinessV1({ planDigest: input.installationReadiness.planDigest,
    proofs: input.installationReadiness.proofs.map(item => item.proof === "local_runner_bridge"
      ? { ...item, evidenceDigest: processReadiness.readinessDigest } : item) });
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, processReadiness, processObservation, installationReadiness }));
});

test("Claude refuses wrong route, connector, authority and release", () => {
  const input = fixture();
  for (const change of [{ kind: "remote" }, { workerId: "worker:other" }, { adapterId: "connector:other" }, { adapterRevision: "changed-revision" }])
    refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, workerRoute: { ...input.workerRoute, ...change } }));
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, connectorProfileDigest: d("other") }));
  for (const key of ["databaseAuthorityDigest", "schedulerAuthorityDigest"]) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    topologyInput: { ...input.topologyInput, [key]: d("other") } }));
  const { planDigest: _old, ...changed } = { ...input.installationPlan, releaseDigest: d("other") };
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, installationPlan: { ...changed, planDigest: d(changed) } }));
});

test("Claude refuses unavailable recovery, installation and supervisor proof", () => {
  const input = fixture();
  for (const key of ["backupRestoreProof", "supervisorReadiness", "installationReadiness"]) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, [key]: undefined }));
  for (const proof of input.installationReadiness.proofs) {
    const installationReadiness = createInstallationReadinessV1({ planDigest: input.installationReadiness.planDigest,
      proofs: input.installationReadiness.proofs.map(item => item.proof === proof.proof ? { proof: item.proof, state: "unavailable" } : item) });
    refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, installationReadiness }));
  }
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    supervisorReadiness: createLocalSupervisorReadinessV1({ planDigest: input.supervisorReadiness.planDigest, proofs: [] }) }));
});

test("Claude refuses changed health, stopped service and stale installation revision", () => {
  const input = fixture(), prepared = prepareLocalClaudeInstallationBindingV1(input);
  for (const state of ["stopped", "failed", "uncertain", "revoked"]) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    serviceObservation: { ...input.serviceObservation, state } }));
  for (const key of Object.keys(input.serviceObservation).filter(key => key !== "state")) refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input,
    serviceObservation: { ...input.serviceObservation, [key]: d("changed") } }));
  for (const action of ["pass", "fail", "uncertain"] as const) {
    const installationPlan = advanceInstallationPlanV1(input.installationPlan, { expectedRevision: input.installationPlan.revision,
      stage: "agent_readiness", action, outcomeDigest: d("outcome") });
    refuses(() => verifyLocalClaudeInstallationBindingV1(prepared, { ...input, installationPlan }));
  }
});

test("Claude refuses rehashed output edits, unknown fields and leaks no malformed input", () => {
  const input = fixture(), prepared = prepareLocalClaudeInstallationBindingV1(input);
  const { preparationDigest: _old, ...changed } = { ...prepared, processConfigurationDigest: d("other") };
  refuses(() => verifyLocalClaudeInstallationBindingV1({ ...changed, preparationDigest: d(changed) }, input));
  refuses(() => verifyLocalClaudeInstallationBindingV1({ ...prepared, enablesWorker: true }, input));
  refuses(() => prepareLocalClaudeInstallationBindingV1({ ...input, processObservation: { ...input.processObservation, secret: "PRIVATE" } }));
  refuses(() => localClaudeProcessConfigurationDigestV1({ executablePath: "PRIVATE" }));
});
