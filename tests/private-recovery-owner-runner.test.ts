import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1,
  runPrivateRecoveryOwnerActionV1, type PrivateRecoveryOwnerRuntimeV1, type PrivateRecoveryRunnerContextV1 } from
  "../src/installer/v1/private-recovery-owner-runner";
import { confirmRecoveryActionTerminalV1 } from "../src/installer/v1/recovery-action-transaction";
import { prepareProtectedDataV1, protectedDataBindingDigestV1, protectedDataStageInputDigestV1,
  recoveryStageInputDigestV1 } from "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const protectedObservation = { observedState: "verified" as const, observationDigest: d("protected-observation") };

function baseFixture() {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
    currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local",
      adapterRevision: "0000001" }] });
  const storage = captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
    storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results",
    maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
  { releaseId: "release:local", releaseDigest: d("release"), databaseSchemaVersion: "schema:76",
    databaseSchemaDigest: d("schema") });
  const storageConfigurationDigest = d({ purpose: "protected-artifact-storage-configuration/v1",
    local: storage.local, inventory: storage.inventory });
  const protectedDataBindingDigest = protectedDataBindingDigestV1({ storageConfiguration: storage, ...protectedObservation });
  const stageInputDigests = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "protected_data"
    ? protectedDataStageInputDigestV1({ releaseDigest: d("release"), storageConfigurationDigest,
      storageNamespaceDigest: storage.inventory.storageNamespaceDigest }) : stage === "recovery"
      ? recoveryStageInputDigestV1({ releaseDigest: d("release"), topologyPlanDigest: topology.planDigest,
        protectedDataBindingDigest, storageConfigurationDigest, storageNamespaceDigest: storage.inventory.storageNamespaceDigest,
        databaseAuthorityOutcomeDigest: d("database-outcome"), expectedDatabaseIdentityDigest: d("database-identity"),
        expectedDatabaseSchemaDigest: d("schema") }) : d(`input:${stage}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: d("release"), stageInputDigests });
  const history: InstallationPlanV1[] = [plan];
  for (const stage of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" }); history.push(plan);
    if (stage === "recovery") break;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest:
      stage === "database_authority" ? d("database-outcome") : stage === "protected_data"
        ? protectedDataBindingDigest : d(`outcome:${stage}`) }); history.push(plan);
  }
  const protectedDataPreparation = prepareProtectedDataV1({ installationPlan: history[7], storageConfiguration: storage,
    ...protectedObservation });
  const actionInput = { installationPlan: plan, topologyPlan: topology, expectedPlanRevision: plan.revision,
    action: "recovery" as const, source: { protectedDataPreparation, storageConfiguration: storage,
      protectedDataObservation: protectedObservation, databaseAuthorityOutcomeDigest: d("database-outcome"),
      expectedDatabaseIdentityDigest: d("database-identity"), expectedDatabaseSchemaDigest: d("schema"),
      observedState: "not_proven" as const, observationDigest: d("recovery:not-proven") } };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: d("release"), databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema"),
    storageNamespace: "artifacts:local", storageNamespaceDigest: storage.inventory.storageNamespaceDigest,
    entries: [{ artifactId: "artifact:local", contentHash: d("bytes"), sizeBytes: 5,
      manifestDigest: d("manifest"), receiptDigest: d("receipt") }] });
  const proof = createLocalBackupRestoreReadinessV1({ planDigest: topology.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local", releaseDigest: d("release"),
      databaseIdentityDigest: d("database-identity"), databaseDumpDigest: d("database-dump"),
      databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema"), restoredToDisposableTarget: true,
      promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory,
      restored: structuredClone(inventory) }) });
  return { topology, storage, protectedDataBindingDigest, stageInputDigests, history, actionInput,
    actionPreparation: prepareInstallationActionV1(actionInput), proof };
}

function runnerFixture() {
  const base = baseFixture(), controller = new AbortController(), calls: string[] = [];
  const binding = Object.freeze({ schema: PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: base.actionPreparation.installationPlanDigest,
    installationPlanRevision: base.actionPreparation.installationPlanRevision,
    topologyPlanDigest: base.actionPreparation.topologyPlanDigest, releaseDigest: base.actionPreparation.releaseDigest,
    protectedDataBindingDigest: base.protectedDataBindingDigest, databaseAuthorityOutcomeDigest: d("database-outcome") });
  const attached = (context: PrivateRecoveryRunnerContextV1) => Object.freeze({
    schema: PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1, installationId,
    requestDigest: context.requestDigest, installationPlanDigest: context.installationPlanDigest,
    installationPlanRevision: context.installationPlanRevision, topologyPlanDigest: context.topologyPlanDigest,
    releaseDigest: context.releaseDigest, protectedDataBindingDigest: context.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: context.databaseAuthorityOutcomeDigest, ownerAttached: true as const, confirmed: true as const });
  const runtime: PrivateRecoveryOwnerRuntimeV1 = { binding, signal: controller.signal, controlDeadlineMs: 300,
    async confirmOwnerAttachedTerminal(context) { calls.push("owner-attached"); return attached(context); },
    async runExistingBackupRestoreRehearsal() { calls.push("existing-rehearsal"); return base.proof; } };
  return { ...base, controller, calls, binding, attached, runtime };
}

async function journalFor(t: TestContext,
  history: readonly InstallationPlanV1[], id = installationId) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-private-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId: id, ownerUid: process.getuid!() });
  for (const plan of history) await journal.append(plan);
  return journal;
}

test("exact attached-owner rehearsal proof produces the only terminal confirmation and settles recovery", async t => {
  const f = runnerFixture(), result = await runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation,
    actionInput: f.actionInput }, f.runtime);
  assert.deepEqual(f.calls, ["owner-attached", "existing-rehearsal"]);
  assert.equal(result.backupRestoreProofDigest, f.proof.proofDigest);
  assert.equal(result.terminalConfirmation.backupRestoreProof.proofDigest, f.proof.proofDigest);
  assert.equal(result.runsBackup, false); assert.equal(result.runsRestore, false); assert.equal(result.promotesRestore, false);
  const journal = await journalFor(t, f.history);
  const settled = await confirmRecoveryActionTerminalV1({ installationId, actionPreparation: f.actionPreparation,
    actionInput: f.actionInput, terminalConfirmation: result.terminalConfirmation }, { journal });
  assert.equal(settled.replayed, false);
  assert.equal((await journal.readHistory()).at(-1)!.stages[5]!.outcomeDigest, f.proof.proofDigest);
  const replay = await confirmRecoveryActionTerminalV1({ installationId, actionPreparation: f.actionPreparation,
    actionInput: f.actionInput, terminalConfirmation: result.terminalConfirmation }, { journal });
  assert.equal(replay.replayed, true);
});

test("runtime callables and bindings are captured before asynchronous confirmation", async () => {
  const f = runnerFixture(); let replacementCalled = false;
  const mutable = { ...f.runtime };
  mutable.confirmOwnerAttachedTerminal = async context => {
    f.calls.push("owner-attached");
    mutable.binding = { ...f.binding, installationId: "different-installation" };
    mutable.runExistingBackupRestoreRehearsal = async () => { replacementCalled = true; throw new Error("replacement"); };
    return f.attached(context);
  };
  const result = await runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation, actionInput: f.actionInput }, mutable);
  assert.equal(replacementCalled, false); assert.equal(result.installationId, installationId);
  assert.deepEqual(f.calls, ["owner-attached", "existing-rehearsal"]);
});

test("binding and owner-confirmation changes refuse before the rehearsal", async () => {
  for (const changed of [{ releaseDigest: d("changed-release") }, { topologyPlanDigest: d("changed-topology") }, { installationPlanRevision: 999 },
    { protectedDataBindingDigest: d("changed-protected") }]) {
    const f = runnerFixture();
    await assert.rejects(runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation, actionInput: f.actionInput },
      { ...f.runtime, binding: { ...f.binding, ...changed } }), /private_recovery_owner_runner_refused/);
    assert.deepEqual(f.calls, []);
  }
  const f = runnerFixture();
  await assert.rejects(runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation, actionInput: f.actionInput },
    { ...f.runtime, async confirmOwnerAttachedTerminal(context: PrivateRecoveryRunnerContextV1) {
      f.calls.push("owner-attached"); return { ...f.attached(context), requestDigest: d("changed-request") } as never;
    } }), /private_recovery_owner_runner_refused/);
  assert.deepEqual(f.calls, ["owner-attached"]);
});

test("malformed proof, effect error, cancellation, and deadline are sanitized uncertainty", async () => {
  for (const kind of ["malformed", "error", "abort", "deadline"] as const) {
    const f = runnerFixture();
    await assert.rejects(runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation, actionInput: f.actionInput }, {
      ...f.runtime, controlDeadlineMs: kind === "deadline" ? 10 : 300,
      async runExistingBackupRestoreRehearsal() {
        f.calls.push("existing-rehearsal");
        if (kind === "malformed") return { ...f.proof, databaseDumpDigest: d("changed-dump") };
        if (kind === "error") throw new Error("credential at /private/restore");
        if (kind === "abort") { f.controller.abort(); return f.proof; }
        return new Promise<never>(() => {});
      },
    }), error => {
      assert.equal((error as Error).message, "private_recovery_owner_runner_uncertain");
      assert.equal((error as Error).stack, undefined); assert.doesNotMatch(String(error), /credential|private\/restore/i); return true;
    }, kind);
  }
});

test("concurrent identical settlement converges and cross-installation or competing evidence refuses", async t => {
  const f = runnerFixture(), terminal = (await runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation,
    actionInput: f.actionInput }, f.runtime)).terminalConfirmation;
  const journal = await journalFor(t, f.history);
  const input = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput, terminalConfirmation: terminal };
  const concurrent = await Promise.all([confirmRecoveryActionTerminalV1(input, { journal }),
    confirmRecoveryActionTerminalV1(input, { journal })]);
  assert.equal(concurrent.filter(item => item.replayed).length, 1);

  const other = await journalFor(t, f.history, "local-installation-two");
  await assert.rejects(confirmRecoveryActionTerminalV1({ ...input, installationId: "local-installation-two" }, { journal: other }),
    /recovery_action_transaction_refused/);
  const changedProof = { ...terminal, backupRestoreProof: { ...terminal.backupRestoreProof,
    databaseDumpDigest: d("competing-dump") } };
  await assert.rejects(confirmRecoveryActionTerminalV1({ ...input, terminalConfirmation: changedProof }, { journal }),
    /recovery_action_transaction_refused/);
});

test("a concurrent later refresh cannot be reported as a successful recovery settlement", async t => {
  const f = runnerFixture(), terminal = (await runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation,
    actionInput: f.actionInput }, f.runtime)).terminalConfirmation;
  const journal = await journalFor(t, f.history);
  let refreshed = false;
  const interleaved = {
    readHistory: journal.readHistory.bind(journal),
    async append(plan: InstallationPlanV1) {
      const result = await journal.append(plan);
      if (!refreshed && plan.stages.find(stage => stage.stage === "recovery")?.state === "passed") {
        refreshed = true;
        const changedInputs = { ...f.stageInputDigests, recovery: d("changed-recovery-input") };
        await journal.append(refreshInstallationPlanV1(plan, { topologyPlan: f.topology,
          releaseDigest: d("release"), stageInputDigests: changedInputs }));
      }
      return result;
    },
  };
  await assert.rejects(confirmRecoveryActionTerminalV1({ installationId, actionPreparation: f.actionPreparation,
    actionInput: f.actionInput, terminalConfirmation: terminal }, { journal: interleaved }),
  /recovery_action_transaction_refused/);
  assert.equal((await journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "not_started");
});

test("error recovery rereads after replay and cannot accept a concurrently invalidated tip", async t => {
  const f = runnerFixture(), terminal = (await runPrivateRecoveryOwnerActionV1({ actionPreparation: f.actionPreparation,
    actionInput: f.actionInput }, f.runtime)).terminalConfirmation;
  const journal = await journalFor(t, f.history);
  let passPersisted = false, refreshInjected = false;
  const interleaved = {
    readHistory: journal.readHistory.bind(journal),
    async append(plan: InstallationPlanV1) {
      const recovery = plan.stages.find(stage => stage.stage === "recovery")!;
      if (!passPersisted && recovery.state === "passed") {
        passPersisted = true;
        await journal.append(plan);
        throw new Error("lost-pass-reply");
      }
      const result = await journal.append(plan);
      if (passPersisted && !refreshInjected && recovery.state === "running") {
        refreshInjected = true;
        const current = (await journal.readHistory()).at(-1)!;
        await journal.append(refreshInstallationPlanV1(current, { topologyPlan: f.topology,
          releaseDigest: d("release"), stageInputDigests: { ...f.stageInputDigests,
            recovery: d("changed-after-lost-reply") } }));
      }
      return result;
    },
  };
  await assert.rejects(confirmRecoveryActionTerminalV1({ installationId, actionPreparation: f.actionPreparation,
    actionInput: f.actionInput, terminalConfirmation: terminal }, { journal: interleaved }),
  /recovery_action_transaction_refused/);
  assert.equal((await journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "not_started");
});

test("runner and settlement sources contain no live filesystem, database, credential, process, backup, or restore implementation", async () => {
  const runner = await readFile("src/installer/v1/private-recovery-owner-runner.ts", "utf8");
  const transaction = await readFile("src/installer/v1/recovery-action-transaction.ts", "utf8");
  assert.doesNotMatch(runner + transaction, /from "node:(?:fs|net|child_process)"|private-postgres|persistent-local-storage/i);
  assert.doesNotMatch(transaction, /backup-database|restore-database|restic-retained-snapshot/i);
});
