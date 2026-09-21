import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1, verifyLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../src/security";

const planDigest = sha256Digest("reviewed-local-installation-plan");
const inventory = () => createArtifactBackupInventoryV1({
  tenantId: "tenant:local", releaseId: "release:local", releaseDigest: sha256Digest("release"),
  databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
  storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
  entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
    manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }],
});

function input() {
  const expectedArtifactInventory = inventory();
  const restoredArtifactInventory = structuredClone(expectedArtifactInventory);
  return {
    planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local",
      releaseDigest: sha256Digest("release"),
      databaseIdentityDigest: sha256Digest("database-identity"), databaseDumpDigest: sha256Digest("database-dump"),
      databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
      restoredToDisposableTarget: true as const, promoted: false as const, startsWork: false as const,
      grantsExecutionAuthority: false as const, permitsRetry: false as const, permitsCleanup: false as const },
    expectedArtifactInventory, restoredArtifactInventory,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: expectedArtifactInventory, restored: restoredArtifactInventory }),
  };
}

test("binds one reviewed plan to already-verified local database and artifact restore evidence without authority", () => {
  const proof = createLocalBackupRestoreReadinessV1(input());
  assert.equal(proof.planDigest, planDigest);
  assert.equal(proof.restoredToDisposableTarget, true);
  for (const field of ["promoted", "startsWork", "grantsExecutionAuthority", "permitsRetry", "permitsCleanup"] as const)
    assert.equal(proof[field], false);
  assert.deepEqual(verifyLocalBackupRestoreReadinessV1(proof), proof);
  assert.equal(Object.isFrozen(proof), true);
});

test("refuses substituted plans, mismatched inventory/verification, non-disposable or promoted restore claims, and changed proof bytes", () => {
  const base = input();
  const original = base.expectedArtifactInventory;
  const mismatched = createArtifactBackupInventoryV1({ tenantId: original.tenantId, releaseId: original.releaseId,
    releaseDigest: original.releaseDigest, databaseSchemaVersion: original.databaseSchemaVersion,
    databaseSchemaDigest: original.databaseSchemaDigest, storageNamespace: original.storageNamespace,
    storageNamespaceDigest: original.storageNamespaceDigest,
    entries: [{ ...original.entries[0]!, contentHash: sha256Digest("different-bytes") }],
  });
  const variants: unknown[] = [
    { ...base, restoredArtifactInventory: mismatched },
    { ...base, databaseRestore: { ...base.databaseRestore, restoredToDisposableTarget: false } },
    { ...base, databaseRestore: { ...base.databaseRestore, promoted: true } },
    { ...base, databaseRestore: { ...base.databaseRestore, startsWork: true } },
    { ...base, databaseRestore: { ...base.databaseRestore, databaseSchemaDigest: sha256Digest("other-schema") } },
    { ...base, databaseRestore: { ...base.databaseRestore, releaseDigest: sha256Digest("other-release") } },
  ];
  for (const value of variants) assert.throws(() => createLocalBackupRestoreReadinessV1(value), /local_backup_restore_readiness_unavailable/);
  const proof = createLocalBackupRestoreReadinessV1(base);
  for (const changed of [{ ...proof, planDigest: "sha256:" + "0".repeat(64) }, { ...proof, promoted: true }])
    assert.throws(() => verifyLocalBackupRestoreReadinessV1(changed), /local_backup_restore_readiness_unavailable/);
});
