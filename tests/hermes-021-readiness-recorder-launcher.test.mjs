import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology.ts";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness.ts";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory.ts";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness.ts";
import { sha256Digest } from "../src/security/canonical-digest.ts";

const run = promisify(execFile);
const route = { kind: "local", workerId: "worker:local-hermes", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" };
const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
  currentRoutes: [route], requestedRoutes: [route] });
const report = { qualified: true, exitCode: 0, exitSignal: null, terminalResultObserved: true,
  sessionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", inputTokens: 804, outputTokens: 71,
  totalTokens: 877, durationMs: 14_904, stderrBytes: 36, failureStage: "none", failureReason: "none",
  profileOverrideUsed: true, modelOverrideUsed: true, providerOverrideUsed: true, retryRequiresFreshOwnerAuthorization: false };

function backupRestoreProof(planDigest) {
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local", releaseDigest: sha256Digest("release"),
    databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"), storageNamespace: "artifact-namespace:local",
    storageNamespaceDigest: sha256Digest("namespace"), entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
      manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }] });
  return createLocalBackupRestoreReadinessV1({ planDigest, databaseRestore: { tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseIdentityDigest: sha256Digest("database-identity"), databaseDumpDigest: sha256Digest("database-dump"),
    databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"), restoredToDisposableTarget: true, promoted: false,
    startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory,
    restoredArtifactInventory: structuredClone(inventory), artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
}

test("readiness recorder emits only opaque readiness for a qualified text report", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acr-readiness-recorder-"));
  const planPath = path.join(directory, "plan.json");
  const reportPath = path.join(directory, "report.json");
  try {
    await writeFile(planPath, JSON.stringify(plan));
    await writeFile(reportPath, JSON.stringify(report));
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-hermes-readiness.ts",
      "--kind", "text", "--plan", planPath, "--report", reportPath], { cwd: process.cwd() });
    assert.equal(stderr, "");
    const readiness = JSON.parse(stdout);
    assert.equal(readiness.planDigest, plan.planDigest);
    assert.equal(readiness.proofs.find(item => item.proof === "local_owner_qualification")?.state, "passed");
    assert.doesNotMatch(stdout, /local-hermes|00570550|804|877|bbbbbbbb/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("readiness recorder fails closed without echoing a private input path", async () => {
  const privatePath = "/private/owner/qualification-report.json";
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-hermes-readiness.ts",
    "--kind", "text", "--plan", privatePath, "--report", privatePath], { cwd: process.cwd() })
    .catch(error => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.match(stdout, /qualification_record_invalid/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /private\/owner/);
});

test("readiness recorder preserves other already-recorded proof states", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acr-readiness-recorder-"));
  const planPath = path.join(directory, "plan.json");
  const reportPath = path.join(directory, "report.json");
  const readinessPath = path.join(directory, "readiness.json");
  try {
    await Promise.all([
      writeFile(planPath, JSON.stringify(plan)), writeFile(reportPath, JSON.stringify(report)),
      writeFile(readinessPath, JSON.stringify(createInstallationReadinessV1({ planDigest: plan.planDigest,
        proofs: [{ proof: "backup_restore", state: "not_started" }, { proof: "local_owner_qualification", state: "not_started" },
          { proof: "local_runner_bridge", state: "not_started" }] }))),
    ]);
    const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-hermes-readiness.ts",
      "--kind", "text", "--plan", planPath, "--report", reportPath, "--readiness", readinessPath], { cwd: process.cwd() });
    const readiness = JSON.parse(stdout);
    assert.equal(readiness.proofs.find(item => item.proof === "backup_restore")?.state, "not_started");
    assert.equal(readiness.proofs.find(item => item.proof === "local_owner_qualification")?.state, "passed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backup recorder prints only the opaque readiness update from a verified restore proof", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acr-readiness-backup-"));
  const planPath = path.join(directory, "plan.json"), proofPath = path.join(directory, "proof.json");
  try {
    const proof = backupRestoreProof(plan.planDigest);
    await Promise.all([writeFile(planPath, JSON.stringify(plan)), writeFile(proofPath, JSON.stringify(proof))]);
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-hermes-readiness.ts",
      "--kind", "backup", "--plan", planPath, "--report", proofPath], { cwd: process.cwd() });
    assert.equal(stderr, "");
    const readiness = JSON.parse(stdout);
    assert.equal(readiness.proofs.find(item => item.proof === "backup_restore")?.state, "passed");
    assert.doesNotMatch(stdout, /tenant:local|artifact-namespace|database-dump|release:local/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
