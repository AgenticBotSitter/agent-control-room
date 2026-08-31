import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  buildOperationsBackupDryRunPlanV1,
  buildOperationsCleanHostFixtureV1,
  buildOperationsRecoveryPlanV1,
  buildOperationsSyntheticHealthSnapshotV1,
  buildOperationsSyntheticReleaseCandidateV1,
  buildOperationsSyntheticTopologyFixtureV1,
  createOperationsFakeRecoveryAdapterV1,
  createOperationsInMemoryBackupAdapterV1,
  OPERATIONS_BACKUP_RETENTION_CEILINGS_V1,
  OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
  OPERATIONS_RECOVERY_PHASE_IDS_V1,
  OperationsContractErrorV1,
  OperationsFakeRecoveryCoordinatorV1,
  parseOperationsBackupDryRunPlanV1,
  projectOperationsBackupDryRunV1,
  runOperationsBackupDryRunFakeV1,
  SqliteOperationsFakeLifecycleLedgerV1,
  verifyOperationsBackupManifestForPlanV1,
  type OperationsBackupDryRunPlanV1,
  type OperationsBackupManifestV1,
  type OperationsFakeRecoveryAdapterV1,
  type OperationsFakeRecoveryModeV1,
  type OperationsProductionTopologyV1,
  type OperationsReleaseCandidateV1,
} from "../src/operations/v1";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/rollback-checkpoint";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

const distinct = (label: string) => sha256Digest({ test: "operations-backup-recovery", label });
const clone = <T>(value: T): T => structuredClone(value);
const code = (safeCode: string) => (error: unknown) => error instanceof OperationsContractErrorV1 && error.safeCode === safeCode;
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}

type Base = { topology: OperationsProductionTopologyV1; release: OperationsReleaseCandidateV1; plan: OperationsBackupDryRunPlanV1 };
function base(): Base {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), release = buildOperationsSyntheticReleaseCandidateV1(topology);
  const plan = buildOperationsBackupDryRunPlanV1({ jobPlanId: "backup-job:operations:test:1", topology, release,
    objectLocationReferenceDigest: distinct("object-reference"), encryptionKeyReferenceDigest: distinct("key-reference"),
    manifestSignerReferenceDigest: distinct("signer-reference"),
    retention: { baseBackupCount: 14, walWindowHours: 72, manifestRetentionDays: 30 },
    resourceEstimate: { maximumEncryptedBytes: 16_777_216, maximumWalBytes: 4_194_304, maximumDurationSeconds: 3600 },
    plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T02:00:00.000Z" });
  return { topology, release, plan };
}

function adapterFor(item: Base, mode: "success" | "failed_after_marker" | "uncertain_after_marker" = "success") {
  return createOperationsInMemoryBackupAdapterV1({ topology: item.topology, release: item.release, plan: item.plan,
    backupId: "backup:operations:test:1", startedAt: "2026-08-30T00:10:00.000Z",
    completedAt: "2026-08-30T00:20:00.000Z", earliestRestorePointAt: "2026-08-30T00:10:00.000Z",
    latestRestorePointAt: "2026-08-30T00:19:59.000Z", declaredEncryptedBytes: 8_388_608, mode });
}

function privateLedger(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `control-room-${label}-`)); chmodSync(directory, 0o700);
  const path = join(directory, "fake-ledger.sqlite"), checkpointStore = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const ledgerIdentityDigest = distinct(`ledger:${label}`), integrityKey = new Uint8Array(32).fill(label.length + 17);
  const ledger = new SqliteOperationsFakeLifecycleLedgerV1(path, ledgerIdentityDigest,
    { mode: "create", integrityKey, checkpointStore, testOnly: true });
  return { directory, path, checkpointStore, ledgerIdentityDigest, integrityKey, ledger,
    reopen: () => new SqliteOperationsFakeLifecycleLedgerV1(path, ledgerIdentityDigest,
      { mode: "open", integrityKey, checkpointStore, testOnly: true }),
    remove: () => rmSync(directory, { recursive: true, force: true }) };
}

function successfulBackup(item = base()): { base: Base; manifest: OperationsBackupManifestV1 } {
  const local = privateLedger("successful-backup");
  try {
    const result = runOperationsBackupDryRunFakeV1({ plan: item.plan, adapter: adapterFor(item), ledger: local.ledger,
      claimedAt: "2026-08-30T00:01:00.000Z", markerAt: "2026-08-30T00:02:00.000Z",
      settledAt: "2026-08-30T00:21:00.000Z" });
    assert.equal(result.record.state, "succeeded"); assert.ok(result.manifest); return { base: item, manifest: result.manifest };
  } finally { local.ledger.close(); local.remove(); }
}

function recoveryFixture(mode: OperationsFakeRecoveryModeV1 = "success",
  recoveryPlanId = "recovery:operations:test:1", targetIdentityDigest = distinct("disposable-target")) {
  const backup = successfulBackup(), plan = buildOperationsRecoveryPlanV1({ recoveryPlanId, topology: backup.base.topology,
    release: backup.base.release, backup: backup.manifest, requestedRestorePointAt: "2026-08-30T00:19:00.000Z",
    targetIdentityDigest, targetRpoSeconds: 900, targetRtoSeconds: 3600,
    plannedAt: "2026-08-30T01:00:00.000Z", expiresAt: "2026-08-30T03:00:00.000Z" });
  const healthSnapshot = buildOperationsSyntheticHealthSnapshotV1(backup.base.topology), cleanHost = buildOperationsCleanHostFixtureV1({
    fixtureId: `fixture:${recoveryPlanId}`, targetIdentityDigest, observedAt: "2026-08-30T00:59:00.000Z" });
  const recoveryWorkerIdentityDigest = distinct(`worker:${recoveryPlanId}`), validatorIdentityDigest = distinct(`validator:${recoveryPlanId}`);
  const adapter = createOperationsFakeRecoveryAdapterV1({ plan, backup: backup.manifest, topology: backup.base.topology,
    healthSnapshot, cleanHost, recoveryWorkerIdentityDigest, independentValidatorIdentityDigest: validatorIdentityDigest,
    nodeJournalHeadDigests: [distinct("journal:mac"), distinct("journal:windows")], mode });
  return { ...backup, plan, healthSnapshot, cleanHost, recoveryWorkerIdentityDigest, validatorIdentityDigest, adapter };
}

function coordinator(fixture: ReturnType<typeof recoveryFixture>, ledger: SqliteOperationsFakeLifecycleLedgerV1,
  adapter: OperationsFakeRecoveryAdapterV1 = fixture.adapter) {
  return new OperationsFakeRecoveryCoordinatorV1({ plan: fixture.plan, backup: fixture.manifest,
    topology: fixture.base.topology, adapter, ledger, incidentObservedAt: "2026-08-30T00:25:00.000Z",
    startedAt: "2026-08-30T01:00:00.000Z" });
}

function at(minute: number, seconds = 0) { return new Date(Date.parse("2026-08-30T01:00:00.000Z") + minute * 60_000 + seconds * 1000).toISOString(); }
function initializeAndRun(coordinatorValue: OperationsFakeRecoveryCoordinatorV1, through = 10) {
  coordinatorValue.initialize(at(1), at(2));
  for (let position = 0; position <= through; position += 1) {
    coordinatorValue.advance(OPERATIONS_RECOVERY_PHASE_IDS_V1[position]!, at(3 + position * 2),
      at(3 + position * 2, 20), at(4 + position * 2));
  }
}

test("CR10A-OPS-050 builds an exact bounded no-command backup/WAL plan", () => {
  const item = base(), projection = projectOperationsBackupDryRunV1(item.plan);
  assert.deepEqual(parseOperationsBackupDryRunPlanV1(item.plan), item.plan);
  assert.equal(item.plan.scheduleMode, "continuous_wal_plus_daily_base");
  assert.equal(item.plan.requiredManifestProperties.join("|"), "immutable|encrypted|bounded_wal|external_audit_anchor|digest_only_references");
  assert.equal(item.plan.executableCommandPresent || item.plan.databaseClientPresent || item.plan.storageClientPresent
    || item.plan.networkClientPresent || item.plan.containsDatabaseBytes || item.plan.containsWalBytes
    || item.plan.containsObjectLocator || item.plan.containsCredentialMaterial || item.plan.backupAuthorized
    || item.plan.grantsBackupAuthority || item.plan.grantsExecutionAuthority, false);
  assert.deepEqual(projection.commandLines, []); assert.equal(projection.externalEffectControlsPresent, false);
  assert.equal(projection.summaryLines.some((line) => line.includes(item.plan.objectLocationReferenceDigest)), false);
});

test("CR10A-OPS-050 protected contract and CLI import no database, storage, network, or subprocess client", () => {
  const sources = ["src/operations/v1/backup-dry-run.ts", "scripts/operations-backup-dry-run.ts"]
    .map((path) => readFileSync(path, "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /node:(?:child_process|net|tls|http|https|fs)|from ["']postgres["']|@aws-sdk|cloudflare|fetch\s*\(/);
  }
});

test("CR10A-OPS-050 rejects retention and resource estimates above frozen ceilings", () => {
  const item = base();
  for (const mutation of [
    { retention: { ...item.plan.retention, baseBackupCount: OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumBaseBackupCount + 1 } },
    { retention: { ...item.plan.retention, walWindowHours: OPERATIONS_BACKUP_RETENTION_CEILINGS_V1.maximumWalWindowHours + 1 } },
    { resourceEstimate: { ...item.plan.resourceEstimate, maximumWalBytes: item.plan.resourceEstimate.maximumEncryptedBytes + 1 } },
  ]) {
    const input = { jobPlanId: "backup-job:operations:hostile", topology: item.topology, release: item.release,
      objectLocationReferenceDigest: distinct("hostile-object"), encryptionKeyReferenceDigest: distinct("hostile-key"),
      manifestSignerReferenceDigest: distinct("hostile-signer"), retention: item.plan.retention,
      resourceEstimate: item.plan.resourceEstimate, plannedAt: item.plan.plannedAt, expiresAt: item.plan.expiresAt, ...mutation };
    assert.throws(() => buildOperationsBackupDryRunPlanV1(input));
  }
});

test("CR10A-OPS-050 fake adapter emits digest-only immutable manifest and authenticated terminal receipt", () => {
  const item = base(), local = privateLedger("backup-success");
  try {
    const result = runOperationsBackupDryRunFakeV1({ plan: item.plan, adapter: adapterFor(item), ledger: local.ledger,
      claimedAt: "2026-08-30T00:01:00.000Z", markerAt: "2026-08-30T00:02:00.000Z",
      settledAt: "2026-08-30T00:21:00.000Z" });
    assert.equal(result.record.state, "succeeded"); assert.ok(result.record.marker); assert.ok(result.record.receipt);
    assert.equal(result.manifest?.immutable, true); assert.equal(result.manifest?.encrypted, true);
    assert.equal(result.manifest?.containsDatabaseBytes || result.manifest?.containsWalBytes
      || result.manifest?.containsObjectLocator || result.manifest?.containsCredentialMaterial, false);
    assert.equal(result.verification?.externalSignatureVerificationStillRequired, true);
    assert.equal(result.verification?.grantsRestoreAuthority || result.verification?.grantsExecutionAuthority, false);
  } finally { local.ledger.close(); local.remove(); }
});

test("CR10A-OPS-050 verifier refuses mutable, incomplete, cross-release, locator, and bytes-as-evidence manifests", () => {
  const successful = successfulBackup(), manifest = successful.manifest;
  for (const [field, value] of [["immutable", false], ["walEndDigest", undefined], ["containsDatabaseBytes", true],
    ["objectLocator", "synthetic://forbidden"]] as Array<[string, unknown]>) {
    const hostile = clone(manifest) as unknown as Record<string, unknown>;
    if (value === undefined) delete hostile[field]; else hostile[field] = value;
    if (field !== "objectLocator") Object.assign(hostile, resign(hostile, "backupDigest"));
    assert.throws(() => verifyOperationsBackupManifestForPlanV1(successful.base.plan, hostile));
  }
  const crossRelease = resign({ ...clone(manifest), releaseDigest: distinct("foreign-release") } as unknown as Record<string, unknown>, "backupDigest");
  assert.throws(() => verifyOperationsBackupManifestForPlanV1(successful.base.plan, crossRelease), code("scope_mismatch"));
});

test("CR10A-OPS-050 restart after a marker becomes terminal ambiguity and cannot dispatch again", () => {
  const item = base(), local = privateLedger("backup-ambiguous");
  try {
    const first = runOperationsBackupDryRunFakeV1({ plan: item.plan, adapter: adapterFor(item, "uncertain_after_marker"),
      ledger: local.ledger, claimedAt: "2026-08-30T00:01:00.000Z", markerAt: "2026-08-30T00:02:00.000Z",
      settledAt: "2026-08-30T00:03:00.000Z" });
    assert.equal(first.record.state, "marked"); local.ledger.close();
    const reopened = local.reopen();
    try {
      const record = reopened.requireRecord(item.plan.jobPlanId); assert.equal(record.state, "ambiguous");
      assert.equal(record.receipt?.safeCode, "ledger_reopened_after_effect_marker");
      assert.equal(reopened.claim(item.plan.jobPlanId, "2026-08-30T00:04:00.000Z").disposition, "terminal");
    } finally { reopened.close(); }
  } finally { local.remove(); }
});

test("CR10A-OPS-050 ledger detects a forged receipt and rejects reopening", () => {
  const item = base(), local = privateLedger("forged-receipt");
  try {
    runOperationsBackupDryRunFakeV1({ plan: item.plan, adapter: adapterFor(item), ledger: local.ledger,
      claimedAt: "2026-08-30T00:01:00.000Z", markerAt: "2026-08-30T00:02:00.000Z",
      settledAt: "2026-08-30T00:21:00.000Z" }); local.ledger.close();
    const db = new DatabaseSync(local.path); db.prepare("UPDATE operations_fake_lifecycle_records SET updated_at=? WHERE operation_id=?")
      .run("2026-08-30T00:22:00.000Z", item.plan.jobPlanId); db.close();
    assert.throws(() => local.reopen(), /integrity failed/);
  } finally { local.remove(); }
});

test("CR10A-OPS-050 ledger rejects Proxy operations without executing traps", () => {
  const item = base(), local = privateLedger("proxy-operation");
  try {
    const attack = observedProxy({ contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
      operationId: item.plan.jobPlanId, operationDigest: item.plan.operationDigest, kind: "backup_job" as const,
      markerRequired: true, authorizedAt: item.plan.plannedAt, expiresAt: item.plan.expiresAt,
      grantsApproval: false as const, grantsExecutionAuthority: false as const }, "throwing");
    assert.throws(() => local.ledger.authorize(attack.value)); assert.equal(attack.trapCount(), 0);
  } finally { local.ledger.close(); local.remove(); }
});

test("CR10A-OPS-060 executes exactly eleven fake phases, cleanup, and independent non-authorizing attestation", () => {
  const fixture = recoveryFixture(), local = privateLedger("recovery-success");
  try {
    const value = coordinator(fixture, local.ledger); initializeAndRun(value);
    assert.equal(value.progress().state, "cleanup_pending"); value.cleanup(at(25), at(25, 20), at(26));
    assert.equal(value.progress().state, "attestation_pending"); const attestation = value.attest(at(27), at(28));
    assert.equal(value.progress().state, "complete"); assert.equal(attestation.phaseReceiptDigests.length, 11);
    assert.equal(attestation.measuredRpoSeconds, 360); assert.equal(attestation.measuredRtoSeconds, 1680);
    assert.equal(attestation.rpoObjectiveMet && attestation.rtoObjectiveMet, true);
    assert.notEqual(attestation.recoveryWorkerIdentityDigest, attestation.independentValidatorIdentityDigest);
    assert.equal(attestation.ownerCutoverWindowOpened || attestation.productionReadinessEstablished
      || attestation.cutoverAttempted || attestation.nativeActionAttempted || attestation.grantsApproval
      || attestation.grantsRestoreAuthority || attestation.grantsCutoverAuthority
      || attestation.grantsProductionReadiness || attestation.grantsExecutionAuthority, false);
    const phases = local.ledger.list(fixture.plan.recoveryPlanId).filter((record) => record.operation.kind === "recovery_phase");
    assert.deepEqual(phases.map((record) => record.operation.position), [...Array(11).keys()]);
    assert.deepEqual(phases.filter((record) => record.marker).map((record) => record.operation.position), [4, 5]);
  } finally { local.ledger.close(); local.remove(); }
});

test("CR10A-OPS-060 refuses reordered phases and a second attempt against a consumed target", () => {
  const fixture = recoveryFixture(), local = privateLedger("recovery-order-target");
  try {
    const value = coordinator(fixture, local.ledger); value.initialize(at(1), at(2));
    assert.throws(() => value.advance("verify_topology_and_release", at(3), at(3, 20), at(4)), code("invalid_transition"));
    const second = recoveryFixture("success", "recovery:operations:test:second", fixture.plan.targetIdentityDigest);
    assert.throws(() => coordinator(second, local.ledger).initialize(at(3), at(4)), /target already used/);
  } finally { local.ledger.close(); local.remove(); }
});

test("CR10A-OPS-060 refuses production targets, wrong backup release, and restore points outside WAL bounds", () => {
  const successful = successfulBackup(), productionTarget = successful.base.topology.services[0]!.principalIdentityDigest;
  const common = { recoveryPlanId: "recovery:operations:hostile", topology: successful.base.topology,
    release: successful.base.release, backup: successful.manifest, requestedRestorePointAt: "2026-08-30T00:19:00.000Z",
    targetIdentityDigest: productionTarget, targetRpoSeconds: 900, targetRtoSeconds: 3600,
    plannedAt: "2026-08-30T01:00:00.000Z", expiresAt: "2026-08-30T03:00:00.000Z" };
  assert.throws(() => buildOperationsRecoveryPlanV1(common), code("scope_mismatch"));
  assert.throws(() => buildOperationsRecoveryPlanV1({ ...common, targetIdentityDigest: distinct("safe-target"),
    requestedRestorePointAt: "2026-08-30T00:20:00.000Z" }), code("scope_mismatch"));
  const wrong = resign({ ...clone(successful.manifest), releaseDigest: distinct("wrong-release") } as unknown as Record<string, unknown>, "backupDigest");
  assert.throws(() => buildOperationsRecoveryPlanV1({ ...common, targetIdentityDigest: distinct("safe-target"), backup: wrong }), code("scope_mismatch"));
});

for (const scenario of [
  { mode: "missing_anchor" as const, through: 7, expected: "external_audit_anchor_missing" },
  { mode: "overwrite_node_truth" as const, through: 8, expected: "node_truth_overwrite_refused" },
  { mode: "self_validation" as const, through: 9, expected: "self_validation_refused" },
]) {
  test(`CR10A-OPS-060 fails closed for ${scenario.mode.replaceAll("_", " ")}`, () => {
    const fixture = recoveryFixture(scenario.mode, `recovery:operations:${scenario.mode}`), local = privateLedger(`recovery-${scenario.mode}`);
    try {
      const value = coordinator(fixture, local.ledger); initializeAndRun(value, scenario.through);
      const progress = value.progress(); assert.equal(progress.state, "failed"); assert.equal(progress.blockingSafeCode, scenario.expected);
      assert.equal(progress.automaticRetryAllowed || progress.cutoverAvailable, false);
    } finally { local.ledger.close(); local.remove(); }
  });
}

test("CR10A-OPS-060 failed cleanup blocks attestation and leaves no reusable target", () => {
  const fixture = recoveryFixture("cleanup_failed", "recovery:operations:cleanup-failed"), local = privateLedger("recovery-cleanup-failed");
  try {
    const value = coordinator(fixture, local.ledger); initializeAndRun(value); value.cleanup(at(25), at(25, 20), at(26));
    assert.equal(value.progress().state, "failed"); assert.equal(value.progress().blockingSafeCode, "synthetic_cleanup_failed");
    assert.throws(() => value.attest(at(27), at(28)), code("invalid_transition"));
  } finally { local.ledger.close(); local.remove(); }
});

test("CR10A-OPS-060 restart after uncertain restore marker preserves terminal ambiguity", () => {
  const fixture = recoveryFixture("uncertain_restore_marker", "recovery:operations:uncertain"), local = privateLedger("recovery-uncertain");
  try {
    const value = coordinator(fixture, local.ledger); initializeAndRun(value, 4);
    assert.equal(value.progress().state, "in_progress");
    const restore = local.ledger.requireRecord(`${fixture.plan.recoveryPlanId}:phase:4`); assert.equal(restore.state, "marked");
    local.ledger.close(); const reopened = local.reopen();
    try {
      const resumed = coordinator(fixture, reopened); const progress = resumed.progress();
      assert.equal(progress.state, "ambiguous"); assert.equal(progress.blockingSafeCode, "ledger_reopened_after_effect_marker");
      assert.equal(progress.automaticRetryAllowed || progress.cutoverAvailable, false);
    } finally { reopened.close(); }
  } finally { local.remove(); }
});
