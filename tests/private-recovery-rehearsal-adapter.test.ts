import assert from "node:assert/strict";
import test from "node:test";
import { computeDatabaseRestoreIdentity } from "../deploy/postgres/restore-identity.mjs";
import { createArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createPrivateRecoveryRehearsalAdapterV1, type PrivateRecoveryRehearsalSessionV1 } from
  "../src/installer/v1/private-recovery-rehearsal-adapter";
import { PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1,
  type PrivateRecoveryRequestV1, type PrivateRecoveryRunnerContextV1 } from "../src/installer/v1/private-recovery-owner-runner";
import { sha256Digest as d } from "../src/security/canonical-digest";

function fixture() {
  const calls: string[] = [], controller = new AbortController();
  const identity = { ledgerDigest: d("ledger"), rolesDigest: d("roles"), membershipsDigest: d("memberships"),
    schemaDigest: d("schema"), rowsDigest: d("rows"), ownersDigest: d("owners"),
    ledgerRowsDigest: d("ledger-rows"), databaseOwnerDigest: d("database-owner") };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: d("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: identity.schemaDigest,
    storageNamespace: "artifacts:local", storageNamespaceDigest: d("namespace"),
    entries: [{ artifactId: "artifact:one", contentHash: d("bytes"), sizeBytes: 4,
      manifestDigest: d("manifest"), receiptDigest: d("receipt") }] });
  const request: PrivateRecoveryRequestV1 = { installationPlanDigest: d("plan"), installationPlanRevision: 8,
    topologyPlanDigest: d("topology"), releaseDigest: d("release"), preparationDigest: d("preparation"),
    protectedDataBindingDigest: d("protected"), storageConfigurationDigest: d("configuration"),
    storageNamespaceDigest: d("namespace"), databaseAuthorityOutcomeDigest: d("database"),
    expectedDatabaseIdentityDigest: computeDatabaseRestoreIdentity(identity).identityDigest,
    expectedDatabaseSchemaDigest: identity.schemaDigest, ownerActionRequestDigest: d("owner-action"),
    operation: "owner_run_existing_backup_restore_rehearsal", requestDigest: d("request") };
  const binding = { schema: PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, installationId: "installation-one",
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: 8,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    protectedDataBindingDigest: request.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest };
  const context: PrivateRecoveryRunnerContextV1 = { ...binding, requestDigest: request.requestDigest, signal: controller.signal };
  const target = { sourceTargetDigest: d("source-target"), disposableTargetDigest: d("disposable-target"),
    sourceReadOnly: true, disposableTargetEmpty: true, disposableTargetOwned: true, protectedRestoreTargetEmpty: true,
    clusterRolesIsolated: true, sourceQuiesced: true };
  const backup = { sourceTargetDigest: target.sourceTargetDigest, databaseDumpDigest: d("dump"),
    databaseIdentity: identity, artifactInventory: inventory, consistentDatabaseSnapshot: true, protectedArtifactsHeld: true };
  const restored = { disposableTargetDigest: target.disposableTargetDigest, databaseDumpDigest: backup.databaseDumpDigest,
    databaseIdentity: structuredClone(identity), artifactInventory: structuredClone(inventory) };
  const login = { disposableTargetDigest: target.disposableTargetDigest, applicationLoginSucceeded: true,
    requiredReadsSucceeded: true, forbiddenWritesRefused: true, privilegeEscalationRefused: true, schedulerBoundaryVerified: true };
  const cleanup = { retired: true, backupRetained: true, sourceUnchanged: true, disposableTargetAccountedFor: true };
  const session: PrivateRecoveryRehearsalSessionV1 = {
    async inspectDisposableTargets() { calls.push("inspect"); return target; },
    async backupDatabaseAndProtectedArtifacts() { calls.push("backup"); return backup; },
    async restoreExactBackup(selected) { calls.push("restore"); assert.deepEqual(selected,
      { databaseDumpDigest: backup.databaseDumpDigest, artifactInventoryDigest: inventory.inventoryDigest }); return restored; },
    async verifyRestrictedLogins() { calls.push("login"); return login; },
    async close(signal) { calls.push("close"); assert.equal(signal.aborted, false); return cleanup; },
  };
  const input = { request, runtime: { binding, signal: controller.signal, controlDeadlineMs: 500,
    async confirmOwnerAttachedTerminal(ctx: PrivateRecoveryRunnerContextV1) {
      const { signal: _signal, ...fields } = ctx;
      return { ...fields, schema: PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1, ownerAttached: true as const, confirmed: true as const };
    } }, ports: { async open() { calls.push("open"); return session; } }, cleanupDeadlineMs: 50 };
  return { calls, controller, context, input, session, target, backup, restored, login, cleanup };
}

test("joins the exact backup, disposable restore and restricted-login evidence; retains backup and retires session", async () => {
  const f = fixture(), adapter = createPrivateRecoveryRehearsalAdapterV1(f.input);
  assert.deepEqual(f.calls, []);
  const proof = await adapter.runExistingBackupRestoreRehearsal(f.context) as { databaseDumpDigest: string; promoted: boolean };
  assert.equal(proof.databaseDumpDigest, f.backup.databaseDumpDigest);
  assert.equal(proof.promoted, false);
  assert.deepEqual(f.calls, ["open", "inspect", "backup", "inspect", "restore", "login", "close"]);
  await assert.rejects(adapter.runExistingBackupRestoreRehearsal(f.context), /refused/);
  assert.equal(f.calls.filter(call => call === "backup").length, 1);
});

test("wrong request and cancelled context refuse before custody or effects", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture(), adapter = createPrivateRecoveryRehearsalAdapterV1(f.input);
    if (cancelled) f.controller.abort();
    await assert.rejects(adapter.runExistingBackupRestoreRehearsal({ ...f.context,
      requestDigest: cancelled ? f.context.requestDigest : d("wrong") }), /refused/);
    assert.deepEqual(f.calls, []);
  }
});

for (const field of ["disposableTargetEmpty", "disposableTargetOwned", "protectedRestoreTargetEmpty",
  "sourceReadOnly", "clusterRolesIsolated", "sourceQuiesced"] as const) {
  test(`refuses ${field} before backup/restore and releases custody`, async () => {
    const f = fixture(); f.target[field] = false;
    await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /refused/);
    assert.deepEqual(f.calls, ["open", "inspect", "close"]);
  });
}
test("refuses a source/restore alias before backup", async () => {
  const f = fixture(); f.target.disposableTargetDigest = f.target.sourceTargetDigest;
  await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /refused/);
  assert.deepEqual(f.calls, ["open", "inspect", "close"]);
});

for (const field of ["rolesDigest", "membershipsDigest", "ownersDigest", "rowsDigest", "databaseOwnerDigest",
  "schemaDigest", "ledgerRowsDigest", "ledgerDigest"] as const) {
  test(`restored ${field} mismatch withholds proof`, async () => {
    const f = fixture(); f.restored.databaseIdentity[field] = d("wrong");
    await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
    assert.equal(f.calls.includes("login"), false);
    assert.equal(f.calls.at(-1), "close");
  });
}
test("changed target between backup and restore prevents restore", async () => {
  const f = fixture(); let observations = 0;
  f.input.ports.open = async () => ({ ...f.session, async inspectDisposableTargets() {
    return ++observations === 1 ? f.target : { ...f.target, disposableTargetDigest: d("substituted") };
  } });
  await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
  assert.equal(f.calls.includes("restore"), false);
});
test("dump substitution and protected artifact corruption refuse completion", async () => {
  for (const kind of ["dump", "artifact"]) {
    const f = fixture();
    if (kind === "dump") f.restored.databaseDumpDigest = d("different-dump");
    else f.restored.artifactInventory.entries[0]!.contentHash = d("different-bytes");
    await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
    assert.equal(f.calls.at(-1), "close");
  }
});
for (const field of ["applicationLoginSucceeded", "requiredReadsSucceeded", "forbiddenWritesRefused",
  "privilegeEscalationRefused", "schedulerBoundaryVerified"] as const) {
  test(`failed ${field} withholds proof`, async () => {
    const f = fixture(); f.login[field] = false;
    await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
  });
}
test("uncertain cleanup cannot convert a successful restore to readiness", async () => {
  const f = fixture(); f.cleanup.retired = false;
  await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
  assert.deepEqual(f.calls, ["open", "inspect", "backup", "inspect", "restore", "login", "close"]);
});
test("interrupted backup retires with fresh cleanup signal, gives no proof and never retries", async () => {
  const f = fixture(); f.input.ports.open = async () => ({ ...f.session,
    async backupDatabaseAndProtectedArtifacts() { f.calls.push("backup"); f.controller.abort(); throw new Error("private detail"); } });
  const adapter = createPrivateRecoveryRehearsalAdapterV1(f.input);
  await assert.rejects(adapter.runExistingBackupRestoreRehearsal(f.context), /^Error: private_recovery_rehearsal_uncertain$/);
  assert.deepEqual(f.calls, ["inspect", "backup", "close"]);
  await assert.rejects(adapter.runExistingBackupRestoreRehearsal(f.context), /refused/);
});

test("captures installation inputs and refuses accessor configuration before invocation", async () => {
  const f = fixture(); let getters = 0;
  assert.throws(() => createPrivateRecoveryRehearsalAdapterV1({ ...f.input,
    get ports() { getters += 1; return f.input.ports; } }), /refused/);
  assert.equal(getters, 0);
  const adapter = createPrivateRecoveryRehearsalAdapterV1(f.input);
  f.input.ports.open = async () => { throw new Error("changed after capture"); };
  f.input.runtime.binding.installationId = "changed-installation";
  await adapter.runExistingBackupRestoreRehearsal(f.context);
  assert.equal(f.calls.includes("restore"), true);
});

test("a hung backup is bounded and invokes retirement before returning uncertainty", async () => {
  const f = fixture(); f.input.runtime.controlDeadlineMs = 15;
  f.input.ports.open = async () => ({ ...f.session,
    async backupDatabaseAndProtectedArtifacts() { f.calls.push("backup"); return new Promise(() => {}); } });
  await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
  assert.deepEqual(f.calls, ["inspect", "backup", "close"]);
});

test("hung retirement is bounded and never yields readiness", async () => {
  const f = fixture(); f.input.cleanupDeadlineMs = 15;
  f.input.ports.open = async () => ({ ...f.session,
    async close() { f.calls.push("close"); return new Promise(() => {}); } });
  await assert.rejects(createPrivateRecoveryRehearsalAdapterV1(f.input).runExistingBackupRestoreRehearsal(f.context), /uncertain/);
  assert.equal(f.calls.at(-1), "close");
});
