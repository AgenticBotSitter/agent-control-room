import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { prepareProtectedDataV1, prepareRecoveryV1, protectedDataBindingDigestV1,
  protectedDataStageInputDigestV1, recoveryNextOperationV1, recoveryStageInputDigestV1,
  verifyProtectedDataPreparationV1, verifyRecoveryPreparationV1 } from "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const protectedObservation = { observedState: "verified" as const, observationDigest: d("private-root-observation") };
const topology = () => planInstallationTopologyV1({ databaseAuthorityDigest: d("db"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
const storage = () => captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
  storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/var/control-room/results",
  maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
{ releaseId: "release:local", releaseDigest: d("release"), databaseSchemaVersion: "schema:76",
  databaseSchemaDigest: d("schema") });
const storageDigests = () => { const value = storage(); return { releaseDigest: value.inventory.releaseDigest,
  storageConfigurationDigest: d({ purpose: "protected-artifact-storage-configuration/v1", local: value.local, inventory: value.inventory }),
  storageNamespaceDigest: value.inventory.storageNamespaceDigest }; };

function initialPlan() {
  const topo = topology(), captured = storage(), protectedDataBindingDigest = protectedDataBindingDigestV1({
    storageConfiguration: captured, ...protectedObservation });
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
    stage === "protected_data" ? protectedDataStageInputDigestV1(storageDigests())
      : stage === "recovery" ? recoveryStageInputDigestV1({ releaseDigest: captured.inventory.releaseDigest,
        topologyPlanDigest: topo.planDigest, protectedDataBindingDigest,
        storageConfigurationDigest: storageDigests().storageConfigurationDigest,
        storageNamespaceDigest: captured.inventory.storageNamespaceDigest,
        databaseAuthorityOutcomeDigest: d("proof:database_authority"),
        expectedDatabaseIdentityDigest: d("database-identity"), expectedDatabaseSchemaDigest: d("schema") })
        : d(`input:${stage}`)]));
  return { topo, stageInputDigests,
    plan: createInstallationPlanV1({ topologyPlan: topo, releaseDigest: d("release"), stageInputDigests }) };
}

function runningProtected() {
  const fixture = initialPlan(); let plan = fixture.plan;
  for (const stage of ["release_preflight", "private_placement", "database_authority"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: d(`proof:${stage}`) });
  }
  return { ...fixture, plan: advanceInstallationPlanV1(plan, { expectedRevision: plan.revision,
    stage: "protected_data", action: "start" }) };
}

function runningRecovery() {
  const fixture = runningProtected();
  const protectedData = prepareProtectedDataV1({ installationPlan: fixture.plan, storageConfiguration: storage(),
    ...protectedObservation });
  let plan = advanceInstallationPlanV1(fixture.plan, { expectedRevision: fixture.plan.revision,
    stage: "protected_data", action: "pass", outcomeDigest: protectedData.protectedDataBindingDigest });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "first_owner", action: "start" });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "first_owner", action: "pass",
    outcomeDigest: d("proof:first_owner") });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "recovery", action: "start" });
  return { ...fixture, plan, protectedData };
}

test("prepares a redacted private-data operation only for the active protected-data stage", () => {
  const fixture = runningProtected(), input = { installationPlan: fixture.plan, storageConfiguration: storage(),
    ...protectedObservation }, prepared = prepareProtectedDataV1(input);
  assert.equal(prepared.nextOperation, "bind_verified_protected_storage");
  assert.equal(prepared.createsDirectory, false); assert.equal(prepared.opensStorage, false);
  assert.equal(prepared.exposesPath, false); assert.equal(prepared.grantsStorageAuthority, false);
  assert.doesNotMatch(JSON.stringify(prepared), /private\/var|rootPath|password|credential/i);
  assert.deepEqual(verifyProtectedDataPreparationV1(prepared, fixture.plan, storage(), protectedObservation), prepared);
});

test("distinguishes missing, unverified and verified roots without performing filesystem work", () => {
  const fixture = runningProtected();
  const operations = (["missing", "present_unverified", "verified"] as const).map(observedState =>
    prepareProtectedDataV1({ installationPlan: fixture.plan, storageConfiguration: storage(), observedState,
      observationDigest: d(`observation:${observedState}`) }).nextOperation);
  assert.deepEqual(operations, ["owner_create_private_data_root", "verify_owner_private_data_root", "bind_verified_protected_storage"]);
});

test("refuses a stale stage, changed private root binding, and forged observation", () => {
  const fixture = runningProtected(), prepared = prepareProtectedDataV1({ installationPlan: fixture.plan,
    storageConfiguration: storage(), observedState: "verified", observationDigest: d("observation") });
  assert.throws(() => verifyProtectedDataPreparationV1(prepared, fixture.plan, storage(),
    { observedState: "missing", observationDigest: d("observation") }), /refused/);
  const changed = captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
    storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/var/control-room/other",
    maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
  { releaseId: "release:local", releaseDigest: d("release"), databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema") });
  assert.throws(() => verifyProtectedDataPreparationV1(prepared, fixture.plan, changed,
    { observedState: "verified", observationDigest: d("observation") }), /refused/);
  assert.throws(() => prepareProtectedDataV1({ installationPlan: initialPlan().plan, storageConfiguration: storage(),
    observedState: "verified", observationDigest: d("observation") }), /refused/);
});

function backupProof(topo = topology(), identity: Readonly<{ releaseId: string; schemaVersion: string }> = {
  releaseId: "release:local", schemaVersion: "schema:76" }) {
  const expected = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: identity.releaseId,
    releaseDigest: d("release"), databaseSchemaVersion: identity.schemaVersion, databaseSchemaDigest: d("schema"),
    storageNamespace: "artifacts:local", storageNamespaceDigest: storage().inventory.storageNamespaceDigest,
    entries: [{ artifactId: "artifact:local", contentHash: d("bytes"), sizeBytes: 5,
      manifestDigest: d("manifest"), receiptDigest: d("receipt") }] });
  return createLocalBackupRestoreReadinessV1({ planDigest: topo.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: identity.releaseId, releaseDigest: d("release"),
      databaseIdentityDigest: d("database-identity"), databaseDumpDigest: d("database-dump"),
      databaseSchemaVersion: identity.schemaVersion, databaseSchemaDigest: d("schema"), restoredToDisposableTarget: true,
      promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: expected, restoredArtifactInventory: structuredClone(expected),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected, restored: structuredClone(expected) }) });
}

test("requests a rehearsal without claiming proof and binds verified recovery evidence when supplied", () => {
  const fixture = runningRecovery(), common = { installationPlan: fixture.plan, topologyPlan: fixture.topo,
    protectedDataPreparation: fixture.protectedData, storageConfiguration: storage(),
    protectedDataObservation: protectedObservation, expectedDatabaseIdentityDigest: d("database-identity"),
    expectedDatabaseSchemaDigest: d("schema"), databaseAuthorityOutcomeDigest: d("proof:database_authority") };
  const unproven = prepareRecoveryV1({ ...common, observedState: "not_proven", observationDigest: d("recovery:not-proven") });
  assert.equal(unproven.nextOperation, "owner_run_existing_backup_restore_rehearsal");
  assert.equal(unproven.backupRestoreProofDigest, undefined);
  const proof = backupProof(fixture.topo), verifiedInput = { ...common, observedState: "verified",
    observationDigest: d("recovery:verified"), backupRestoreProof: proof }, verified = prepareRecoveryV1(verifiedInput);
  assert.equal(verified.nextOperation, "record_verified_backup_restore_evidence");
  assert.equal(verified.backupRestoreProofDigest, proof.proofDigest);
  assert.equal(verified.artifactInventoryDigest, proof.artifactInventoryDigest);
  assert.equal(verified.runsBackup, false); assert.equal(verified.runsRestore, false);
  assert.equal(verified.promotesRestore, false); assert.equal(verified.exposesCredentials, false);
  const recoveryObservation = { observedState: "verified", observationDigest: d("recovery:verified"),
    backupRestoreProofDigest: proof.proofDigest };
  assert.deepEqual(verifyRecoveryPreparationV1(verified, verifiedInput, recoveryObservation), verified);
  assert.deepEqual(recoveryNextOperationV1(verified, verifiedInput, recoveryObservation), {
    stage: "recovery", operation: "record_verified_backup_restore_evidence",
    precondition: "verified_disposable_restore_only", performsEffect: false, runsBackup: false, runsRestore: false });
  assert.doesNotMatch(JSON.stringify(verified), /private\/var|rootPath|password|postgresql:\/\//i);
});

test("recovery refuses wrong database, schema, topology, protected observation, and retagged proof", () => {
  const fixture = runningRecovery(), proof = backupProof(fixture.topo), base = { installationPlan: fixture.plan,
    topologyPlan: fixture.topo, protectedDataPreparation: fixture.protectedData, storageConfiguration: storage(),
    protectedDataObservation: protectedObservation, expectedDatabaseIdentityDigest: d("database-identity"),
    expectedDatabaseSchemaDigest: d("schema"), observedState: "verified", observationDigest: d("recovery:verified"),
    databaseAuthorityOutcomeDigest: d("proof:database_authority"), backupRestoreProof: proof };
  assert.throws(() => prepareRecoveryV1({ ...base, expectedDatabaseIdentityDigest: d("other-db") }), /refused/);
  assert.throws(() => prepareRecoveryV1({ ...base, expectedDatabaseSchemaDigest: d("other-schema") }), /refused/);
  assert.throws(() => prepareRecoveryV1({ ...base, databaseAuthorityOutcomeDigest: d("other-database-stage") }), /refused/);
  assert.throws(() => prepareRecoveryV1({ ...base,
    backupRestoreProof: backupProof(fixture.topo, { releaseId: "release:other", schemaVersion: "schema:76" }) }), /refused/);
  assert.throws(() => prepareRecoveryV1({ ...base,
    backupRestoreProof: backupProof(fixture.topo, { releaseId: "release:local", schemaVersion: "schema:other" }) }), /refused/);
  assert.throws(() => prepareRecoveryV1({ ...base, protectedDataObservation: { ...protectedObservation,
    observationDigest: d("other-observation") } }), /refused/);
  const otherTopology = planInstallationTopologyV1({ databaseAuthorityDigest: d("other-db"), schedulerAuthorityDigest: d("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
  assert.throws(() => prepareRecoveryV1({ ...base, topologyPlan: otherTopology }), /refused/);
  const prepared = prepareRecoveryV1(base);
  const trusted = { observedState: "verified", observationDigest: d("recovery:verified"),
    backupRestoreProofDigest: proof.proofDigest };
  assert.throws(() => verifyRecoveryPreparationV1({ ...prepared, databaseDumpDigest: d("forged") }, base, trusted), /refused/);
  const unprovenInput = { ...base, observedState: "not_proven", observationDigest: d("recovery:not-proven"),
    backupRestoreProof: undefined }, unproven = prepareRecoveryV1(unprovenInput);
  const retaggedInput = { ...base, observedState: "verified", observationDigest: d("recovery:verified"),
    backupRestoreProof: proof }, retagged = prepareRecoveryV1(retaggedInput);
  assert.equal(unproven.observedState, "not_proven");
  assert.throws(() => verifyRecoveryPreparationV1(retagged, retaggedInput, {
    observedState: "not_proven", observationDigest: d("recovery:not-proven") }), /refused/,
  "a fully recomputed verified record cannot override the independently trusted not-proven observation");
  assert.throws(() => refreshInstallationPlanV1(fixture.plan, { topologyPlan: fixture.topo,
    releaseDigest: d("release"), stageInputDigests: { ...fixture.stageInputDigests,
      recovery: d("changed-recovery-input") } }), /installation_plan_conflict/,
  "a running recovery cannot be refreshed underneath an existing trusted observation");
});
