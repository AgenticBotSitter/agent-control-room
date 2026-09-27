import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1, verifyLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { localBackupRestoreEvidenceDigestForInstallationPlanV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security";
import { createMacLocalDatabaseBackupV1 } from "../scripts/ops/backup-database.mjs";
import { verifyMacLocalDatabaseBackupV1 } from "../scripts/ops/verify-database-backup.mjs";

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

test("accepts backup evidence only for the exact reviewed unified installation plan", () => {
  const proof = createLocalBackupRestoreReadinessV1(input());
  const routes = [{ kind: "local" as const, workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }];
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: routes, requestedRoutes: routes });
  const bound = { ...proof, planDigest: plan.planDigest };
  const usable = createLocalBackupRestoreReadinessV1({ ...input(), planDigest: plan.planDigest });
  assert.equal(localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, usable), usable.proofDigest);
  assert.throws(() => localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, bound), /local_backup_restore_readiness_unavailable/);
  const changed = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database:changed"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: routes, requestedRoutes: routes });
  assert.throws(() => localBackupRestoreEvidenceDigestForInstallationPlanV1(changed, usable), /local_backup_restore_readiness_unavailable/);
});

test("writes a secret-free digest manifest and refuses a tampered dump before starting PostgreSQL", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-backup-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityDigest = sha256Digest("restore-identity"), ledgerDigest = sha256Digest("ledger");
  const manifest = await createMacLocalDatabaseBackupV1({
    source: "postgresql://operator:private-password@127.0.0.1/control_room", out: root,
    pgBin: "/unused/postgres/bin", now: () => "2026-09-27T00:00:00.000Z",
    backup: async ({ out }) => {
      await mkdir(out!, { recursive: true });
      await writeFile(join(out!, "database.dump"), "custom-format-backup");
      await writeFile(join(out!, "metadata.json"), JSON.stringify({ version: 1, ledgerDigest,
        identity: { identityDigest }, evidence: { roles: [{ rolname: "control_room_schema_owner" }],
          ledger: [{ filename: "db/migrations/0090_test.sql", digest: sha256Digest("head"), ledger_order: 90 }] } }));
      return { planned: false, identityDigest };
    },
  });
  const encoded = JSON.stringify(manifest);
  assert.doesNotMatch(encoded, /private-password|postgresql|operator/u);
  assert.equal(manifest.restoreIdentityDigest, identityDigest);
  await writeFile(join(root, "database.dump"), "tampered-custom-format-backup");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: root, port: 15620,
    pgBin: "/unused/postgres/bin" }), /database_backup_digest_refused/u);
});
