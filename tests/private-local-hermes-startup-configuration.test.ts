import assert from "node:assert/strict";
import test from "node:test";
import { validatePrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { sha256Digest } from "../src/security/canonical-digest";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1, localBackupRestoreEvidenceDigestForInstallationPlanV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";

function readyLocalHermesInstallation() {
  const route = { kind: "local" as const, workerId: "worker:local-hermes",
    adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "revision:test" };
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("local-db"),
    schedulerAuthorityDigest: sha256Digest("local-scheduler"), currentRoutes: [route], requestedRoutes: [route] });
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
    entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
      manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }] });
  const backup = createLocalBackupRestoreReadinessV1({ planDigest: plan.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local", releaseDigest: sha256Digest("release"),
      databaseIdentityDigest: sha256Digest("database"), databaseDumpDigest: sha256Digest("dump"),
      databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"), restoredToDisposableTarget: true,
      promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, backup) },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("text") },
    { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("runner") },
  ] });
  const supervisor = createLocalSupervisorReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("launch") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("rollback") },
  ] });
  return { installationTopologyPlan: plan, installationReadiness: readiness,
    localBackupRestoreReadiness: backup, localSupervisorReadiness: supervisor };
}

/** The final server-only gate must make Claude prove its own installed-process
 * boundary. Hermes proof records are intentionally not interchangeable. */
function readyLocalClaudeInstallation() {
  const route = { kind: "local" as const, workerId: "worker:local-claude",
    adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "source-123" };
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("local-claude-db"),
    schedulerAuthorityDigest: sha256Digest("local-claude-scheduler"), currentRoutes: [route], requestedRoutes: [route] });
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
    entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
      manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }] });
  const backup = createLocalBackupRestoreReadinessV1({ planDigest: plan.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local", releaseDigest: sha256Digest("release"),
      databaseIdentityDigest: sha256Digest("database"), databaseDumpDigest: sha256Digest("dump"),
      databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"), restoredToDisposableTarget: true,
      promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, backup) },
  ] });
  const supervisor = createLocalSupervisorReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("launch") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("rollback") },
  ] });
  const process = createClaudeCodeLocalProcessReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("identity") },
    { proof: "permission_boundary", state: "passed", evidenceDigest: sha256Digest("permission") },
    { proof: "cancellation_and_restart_recovery", state: "passed", evidenceDigest: sha256Digest("recovery") },
  ] });
  return { installationTopologyPlan: plan, installationReadiness: readiness,
    localBackupRestoreReadiness: backup, localSupervisorReadiness: supervisor, claudeCodeLocalProcessReadiness: process };
}

test("a local Hermes queue route is captured without requiring a remote session transport", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const scenario = fixture.scenario();
  let called = 0;
  const configuration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined,
    hermes021Local: { async deliver() { called++; } },
  }, web: { ...scenario.configuration.web, ...readyLocalHermesInstallation() } };
  const captured = validatePrivateTaskStartupConfiguration(configuration);
  assert.equal(typeof captured.hermes021Local?.deliver, "function");
  await captured.hermes021Local!.deliver({} as never, new AbortController().signal);
  assert.equal(called, 1);
});

test("a bare local Hermes callback cannot bypass the final installation-proof gate", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const scenario = fixture.scenario();
  const configuration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined,
    hermes021Local: { async deliver() {} },
  } };
  assert.throws(() => validatePrivateTaskStartupConfiguration(configuration), /private_task_startup_config_invalid/);
});

test("a bare local Claude callback is refused even with the legacy proof set", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const scenario = fixture.scenario();
  let called = 0;
  const configuration = { ...scenario.configuration, coordinator: {
    ...scenario.configuration.coordinator, sessions: undefined, nativeHttp: undefined, hermes021Local: undefined,
    claudeCodeLocal: { async deliver() { called++; } },
  }, web: { ...scenario.configuration.web, ...readyLocalClaudeInstallation() } };
  assert.throws(() => validatePrivateTaskStartupConfiguration(configuration), /private_task_startup_config_invalid/);
  assert.equal(called, 0);
});
