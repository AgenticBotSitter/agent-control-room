import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { advanceDatabaseRelocationPreparationV1, createDatabaseRelocationPreparationV1,
  databaseRelocationPreparationSchemaV1, verifyDatabaseRelocationPreparationV1 } from "../src/harness/v1/database-relocation-preparation";
import { advanceInstallationTransitionV1, createInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security";

const digest = (value: string) => sha256Digest(value);
const at = (seconds: number) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const inventory = () => createArtifactBackupInventoryV1({ tenantId: "tenant:relocation", releaseId: "release:relocation",
  releaseDigest: digest("release"), databaseSchemaVersion: "schema:84", databaseSchemaDigest: digest("schema"),
  storageNamespace: "artifact-namespace:relocation", storageNamespaceDigest: digest("namespace"), entries: [] });
const transition = () => {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("source-authority"), schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:source", adapterId: "adapter:source", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:target", adapterId: "adapter:target", adapterRevision: "0000001" }] });
  let record = createInstallationTransitionV1({ transitionId: "transition:relocation", topologyPlan: topology, now: at(0) });
  record = advanceInstallationTransitionV1(record, { expectedRevision: 0, action: "pause_admission", now: at(1), evidenceDigest: digest("paused") });
  return advanceInstallationTransitionV1(record, { expectedRevision: 1, action: "record_drain", now: at(2), evidenceDigest: digest("drained"), drainStatus: "all_drained" });
};
const create = () => {
  const sourceInventory = inventory();
  return createDatabaseRelocationPreparationV1({ relocationId: "relocation:fixture", tenantId: "tenant:relocation",
    sourceAuthorityDigest: digest("source-authority"), targetAuthorityDigest: digest("target-authority"), schedulerAuthorityDigest: digest("scheduler"),
    sourceReleaseDigest: digest("release"), targetReleaseDigest: digest("release"),
    sourceDatabaseSchemaDigest: digest("schema"), targetDatabaseSchemaDigest: digest("schema"),
    sourceRestrictedRoleProofDigest: digest("roles"), targetRestrictedRoleProofDigest: digest("roles"),
    verifiedArtifactInventory: sourceInventory,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: sourceInventory, restored: structuredClone(sourceInventory) }),
    externalRollbackCheckpointDigest: digest("external-checkpoint"), installationTransition: transition(), now: at(3) });
};

test("binds equal release, schema and role proofs with verified inventory, checkpoint and drain evidence", () => {
  const record = create();
  assert.equal(record.state, "preflight");
  assert.equal(record.drainEvidenceDigest, digest("drained"));
  assert.equal(record.schedulerAuthorityDigest, digest("scheduler"));
  assert.equal(record.performsBackup, false);
  assert.equal(record.performsRestore, false);
  assert.equal(record.readsExternalCheckpoint, false);
  assert.equal(record.startsOrFencesServices, false);
  assert.equal(record.configuresAuthority, false);
  assert.equal(record.activatesController, false);
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(verifyDatabaseRelocationPreparationV1(record), record);
});

test("only a valid preflight plan becomes ready; failure stays terminal and tampering refuses", () => {
  const preflight = create();
  const ready = advanceDatabaseRelocationPreparationV1(preflight, { expectedRevision: 0, action: "mark_ready", now: at(4) });
  assert.equal(ready.state, "ready");
  assert.throws(() => advanceDatabaseRelocationPreparationV1(ready, { expectedRevision: 1, action: "mark_ready", now: at(5) }), /unavailable/);
  const failed = advanceDatabaseRelocationPreparationV1(create(), { expectedRevision: 0, action: "fail", failureDigest: digest("interrupted"), now: at(4) });
  assert.equal(failed.state, "failed");
  assert.throws(() => advanceDatabaseRelocationPreparationV1(create(), { expectedRevision: 0, action: "fail", now: at(4) }), /unavailable/);
  assert.throws(() => verifyDatabaseRelocationPreparationV1({ ...ready, targetAuthorityDigest: digest("other") }), /unavailable/);
  assert.equal(databaseRelocationPreparationSchemaV1.safeParse({ ...ready, startsOrFencesServices: true }).success, false);
});

test("refuses unequal proof bindings, same authority, unverified artifacts, and non-drained transitions", () => {
  const base = create();
  const input = { relocationId: base.relocationId, tenantId: base.tenantId, sourceAuthorityDigest: base.sourceAuthorityDigest,
    targetAuthorityDigest: base.targetAuthorityDigest, sourceReleaseDigest: base.releaseDigest, targetReleaseDigest: base.releaseDigest,
    schedulerAuthorityDigest: base.schedulerAuthorityDigest,
    sourceDatabaseSchemaDigest: base.databaseSchemaDigest, targetDatabaseSchemaDigest: base.databaseSchemaDigest,
    sourceRestrictedRoleProofDigest: base.restrictedRoleProofDigest, targetRestrictedRoleProofDigest: base.restrictedRoleProofDigest,
    verifiedArtifactInventory: inventory(), externalRollbackCheckpointDigest: base.externalRollbackCheckpointDigest,
    installationTransition: transition(), now: at(3) };
  const verification = verifyRestoredArtifactBackupInventoryV1({ expected: input.verifiedArtifactInventory, restored: structuredClone(input.verifiedArtifactInventory) });
  for (const changed of [
    { ...input, targetReleaseDigest: digest("other-release"), artifactRestoreVerification: verification },
    { ...input, targetDatabaseSchemaDigest: digest("other-schema"), artifactRestoreVerification: verification },
    { ...input, targetRestrictedRoleProofDigest: digest("other-roles"), artifactRestoreVerification: verification },
    { ...input, targetAuthorityDigest: input.sourceAuthorityDigest, artifactRestoreVerification: verification },
    { ...input, artifactRestoreVerification: { ...verification, verificationDigest: digest("forged") } },
    { ...input, artifactRestoreVerification: verification, now: at(1) },
    { ...input, artifactRestoreVerification: verification, installationTransition: createInstallationTransitionV1({ transitionId: "transition:not-drained", topologyPlan: planInstallationTopologyV1({ databaseAuthorityDigest: digest("d"), schedulerAuthorityDigest: digest("s"), currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:undrained", adapterId: "adapter:undrained", adapterRevision: "0000001" }] }), now: at(0) }) },
  ]) assert.throws(() => createDatabaseRelocationPreparationV1(changed), /unavailable/);
});

test("refuses a relocation plan from another authority, scheduler, or an uncertain drain", () => {
  const base = create();
  const shared = { relocationId: base.relocationId, tenantId: base.tenantId, sourceAuthorityDigest: base.sourceAuthorityDigest,
    targetAuthorityDigest: base.targetAuthorityDigest, schedulerAuthorityDigest: base.schedulerAuthorityDigest,
    sourceReleaseDigest: base.releaseDigest, targetReleaseDigest: base.releaseDigest,
    sourceDatabaseSchemaDigest: base.databaseSchemaDigest, targetDatabaseSchemaDigest: base.databaseSchemaDigest,
    sourceRestrictedRoleProofDigest: base.restrictedRoleProofDigest, targetRestrictedRoleProofDigest: base.restrictedRoleProofDigest,
    verifiedArtifactInventory: inventory(), externalRollbackCheckpointDigest: base.externalRollbackCheckpointDigest, now: at(3) };
  const artifactRestoreVerification = verifyRestoredArtifactBackupInventoryV1({ expected: shared.verifiedArtifactInventory,
    restored: structuredClone(shared.verifiedArtifactInventory) });
  const uncertain = (() => {
    const topology = planInstallationTopologyV1({ databaseAuthorityDigest: base.sourceAuthorityDigest,
      schedulerAuthorityDigest: base.schedulerAuthorityDigest, currentRoutes: [], requestedRoutes: [{ kind: "remote", workerId: "worker:uncertain", adapterId: "adapter:remote", adapterRevision: "0000001" }] });
    let record = createInstallationTransitionV1({ transitionId: "transition:uncertain", topologyPlan: topology, now: at(0) });
    record = advanceInstallationTransitionV1(record, { expectedRevision: 0, action: "pause_admission", now: at(1), evidenceDigest: digest("pause") });
    return advanceInstallationTransitionV1(record, { expectedRevision: 1, action: "record_drain", now: at(2), evidenceDigest: digest("uncertain"), drainStatus: "uncertain_work_recorded" });
  })();
  for (const changed of [
    { ...shared, artifactRestoreVerification, installationTransition: transition(), sourceAuthorityDigest: digest("foreign") },
    { ...shared, artifactRestoreVerification, installationTransition: transition(), schedulerAuthorityDigest: digest("foreign-scheduler") },
    { ...shared, artifactRestoreVerification, installationTransition: uncertain },
  ]) assert.throws(() => createDatabaseRelocationPreparationV1(changed), /unavailable/);
});
