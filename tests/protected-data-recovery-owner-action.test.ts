import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { prepareProtectedDataRecoveryOwnerActionV1 }
  from "../src/installer/v1/protected-data-recovery-owner-action";
import { prepareProtectedDataV1, protectedDataBindingDigestV1, protectedDataStageInputDigestV1,
  recoveryStageInputDigestV1 } from "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const protectedObservation = { observedState: "verified" as const, observationDigest: d("protected-observation") };
const topology = () => planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
const storage = () => captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1", storageClass: "local",
  storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results", maximumArtifacts: 100,
  maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
{ releaseId: "release:local", releaseDigest: d("release"), databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema") });

function fixture() {
  const topo = topology(), stored = storage(), storageConfigurationDigest = d({ purpose: "protected-artifact-storage-configuration/v1",
    local: stored.local, inventory: stored.inventory }), protectedDataBindingDigest = protectedDataBindingDigestV1({ storageConfiguration: stored,
    ...protectedObservation });
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "protected_data"
    ? protectedDataStageInputDigestV1({ releaseDigest: d("release"), storageConfigurationDigest,
      storageNamespaceDigest: stored.inventory.storageNamespaceDigest }) : stage === "recovery"
      ? recoveryStageInputDigestV1({ releaseDigest: d("release"), topologyPlanDigest: topo.planDigest, protectedDataBindingDigest,
        storageConfigurationDigest, storageNamespaceDigest: stored.inventory.storageNamespaceDigest,
        databaseAuthorityOutcomeDigest: d("database-outcome"), expectedDatabaseIdentityDigest: d("database-identity"),
        expectedDatabaseSchemaDigest: d("schema") }) : d(`input:${stage}`)]));
  return { topo, stored, protectedDataBindingDigest, plan: createInstallationPlanV1({ topologyPlan: topo, releaseDigest: d("release"), stageInputDigests }) };
}

function advance(base: ReturnType<typeof fixture>, target: "protected_data" | "recovery") {
  let plan: InstallationPlanV1 = base.plan;
  for (const stage of installationSetupStagesV1) {
    if (stage === target) return advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest:
      stage === "database_authority" ? d("database-outcome") : stage === "protected_data" ? base.protectedDataBindingDigest : d(`outcome:${stage}`) });
  }
  throw new Error("missing target");
}

function recoveryProof(topo: ReturnType<typeof topology>) {
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local", releaseDigest: d("release"),
    databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema"), storageNamespace: "artifacts:local",
    storageNamespaceDigest: storage().inventory.storageNamespaceDigest, entries: [{ artifactId: "artifact:local", contentHash: d("bytes"),
      sizeBytes: 5, manifestDigest: d("manifest"), receiptDigest: d("receipt") }] });
  return createLocalBackupRestoreReadinessV1({ planDigest: topo.planDigest, databaseRestore: { tenantId: "tenant:local",
    releaseId: "release:local", releaseDigest: d("release"), databaseIdentityDigest: d("database-identity"),
    databaseDumpDigest: d("database-dump"), databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema"),
    restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
  expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
  artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: structuredClone(inventory) }) });
}

test("prepares only redacted requests for the existing protected-storage and recovery tools", () => {
  const base = fixture(), protectedPlan = advance(base, "protected_data");
  const protectedInput = { installationPlan: protectedPlan, topologyPlan: base.topo, expectedPlanRevision: protectedPlan.revision,
    action: "protected_data", source: { storageConfiguration: base.stored, observedState: "missing", observationDigest: d("missing") } };
  const protectedAction = prepareInstallationActionV1(protectedInput);
  const preparedProtected = prepareProtectedDataV1({ installationPlan: protectedPlan, storageConfiguration: base.stored, ...protectedObservation });
  const recoveryPlan = advance(base, "recovery");
  const recoveryInput = { installationPlan: recoveryPlan, topologyPlan: base.topo, expectedPlanRevision: recoveryPlan.revision, action: "recovery",
    source: { protectedDataPreparation: preparedProtected, storageConfiguration: base.stored, protectedDataObservation: protectedObservation,
      databaseAuthorityOutcomeDigest: d("database-outcome"), expectedDatabaseIdentityDigest: d("database-identity"),
      expectedDatabaseSchemaDigest: d("schema"), observedState: "not_proven", observationDigest: d("not-proven") } };
  const protectedRequest = prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation: protectedAction, actionInput: protectedInput });
  const recoveryRequest = prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation: prepareInstallationActionV1(recoveryInput), actionInput: recoveryInput });
  assert.deepEqual([protectedRequest.operation, recoveryRequest.operation],
    ["owner_create_private_data_root", "owner_run_existing_backup_restore_rehearsal"]);
  assert.deepEqual(recoveryRequest.tool.entrypoints, ["deploy/postgres/backup-database.mjs", "deploy/postgres/restore-database.mjs",
    "scripts/backup/restic-retained-snapshot.ts", "src/artifacts/v1/artifact-backup-inventory.ts", "src/harness/v1/local-backup-restore-readiness.ts"]);
  for (const request of [protectedRequest, recoveryRequest]) {
    assert.equal(request.performsEffect, false); assert.equal(request.runsBackup, false); assert.equal(request.runsRestore, false);
    assert.doesNotMatch(JSON.stringify(request), /private\/owner|rootPath|password|credential|postgresql:\/\//i);
  }
});

test("refuses stale, forged, or non-I4 preparations without a stage transition", () => {
  const base = fixture(), plan = advance(base, "protected_data");
  const actionInput = { installationPlan: plan, topologyPlan: base.topo, expectedPlanRevision: plan.revision, action: "protected_data",
    source: { storageConfiguration: base.stored, ...protectedObservation } }, actionPreparation = prepareInstallationActionV1(actionInput);
  assert.throws(() => prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation, actionInput: { ...actionInput,
    expectedPlanRevision: plan.revision - 1 } }), /protected_data_recovery_owner_action_refused/);
  assert.throws(() => prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation: { ...actionPreparation, performsEffect: true }, actionInput }),
  /protected_data_recovery_owner_action_refused/);
  assert.throws(() => prepareProtectedDataRecoveryOwnerActionV1({ actionPreparation, actionInput: { ...actionInput, action: "postgres" } }),
  /protected_data_recovery_owner_action_refused/);
  assert.equal(recoveryProof(base.topo).promoted, false, "fixture proof remains the existing disposable format");
});
