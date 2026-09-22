import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_FIRST_OWNER_CLEANUP_V1,
  PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1, PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
  type PrivateFirstOwnerRunnerContextV1, type PrivateFirstOwnerRuntimeV1 } from
  "../src/installer/v1/private-first-owner-runner";
import { dispatchPrivateLocalSetupStageV1 } from "../src/installer/v1/private-local-setup-orchestrator";
import { PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1,
  type PrivateRecoveryOwnerRuntimeV1, type PrivateRecoveryRunnerContextV1 } from
  "../src/installer/v1/private-recovery-owner-runner";
import { prepareProtectedDataV1, protectedDataBindingDigestV1, protectedDataStageInputDigestV1,
  protectedDataStorageBindingsV1, recoveryStageInputDigestV1 } from
  "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const releaseDigest = d("exact-release");
const databaseOutcome = d("database-outcome");
const protectedOutcome = d("protected-outcome");
const ownerSource = Object.freeze({ databaseAuthorityOutcomeDigest: databaseOutcome,
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject"), observedOwnerState: "empty" as const,
  observationDigest: d("empty-owner-observation") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"),
  schedulerAuthorityDigest: d("scheduler"), currentRoutes: [], requestedRoutes: [] });


async function fixture() {
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(name => [name, d(`placeholder:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history: InstallationPlanV1[] = [plan];
  for (const selected of ["release_preflight", "private_placement", "database_authority", "protected_data"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" }); history.push(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome
        : selected === "protected_data" ? protectedOutcome : d(`outcome:${selected}`) }); history.push(plan);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-local-orchestrator-"))); await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  for (const item of history) await journal.append(item);
  const ownerInputDigest = firstOwnerStageInputDigestV1({ releaseDigest,
    databaseAuthorityOutcomeDigest: ownerSource.databaseAuthorityOutcomeDigest,
    bootstrapConfigurationDigest: ownerSource.bootstrapConfigurationDigest,
    trustConfigurationDigest: ownerSource.trustConfigurationDigest,
    expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology, releaseDigest,
    stageInputDigests: Object.fromEntries(plan.stages.map(item => [item.stage,
      item.stage === "first_owner" ? ownerInputDigest : item.inputDigest])) });
  const running = advanceInstallationPlanV1(refreshed, { expectedRevision: refreshed.revision,
    stage: "first_owner", action: "start" });
  return { root, journal, plan, running, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function runtimeFor(running: InstallationPlanV1, calls: string[], ceremonyFails = false): PrivateFirstOwnerRuntimeV1 {
  const binding = Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: running.planDigest, installationPlanRevision: running.revision, releaseDigest,
    databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest });
  return Object.freeze({ binding, signal: new AbortController().signal, controlDeadlineMs: 500, cleanupDeadlineMs: 100,
    async confirmOwnerAttachedTerminal(context: PrivateFirstOwnerRunnerContextV1) {
      calls.push("owner-attached"); return { schema: PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, installationId,
        requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerAttached: true as const, confirmed: true as const };
    },
    async runRetainedOwnerBootstrapCeremony() {
      calls.push("ceremony"); if (ceremonyFails) throw new Error("lost ceremony reply");
      return { schema: "control-room.owner-bootstrap-complete/v1" as const, ownerCreated: true as const,
        normalApplicationAvailable: true as const, physicalGatewayAcceptanceComplete: false as const };
    },
    async verifyExistingOwner(context) {
      calls.push("verify-existing-owner"); return { schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
        installationId, requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest,
        databaseAuthorityOutcomeDigest: databaseOutcome, expectedOwnerSubjectDigest: ownerSource.expectedOwnerSubjectDigest,
        ownerConfirmed: true as const, ownerState: "existing" as const, ownerProofDigest: d("owner-proof"),
        ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified" as const };
    },
    async cleanupRetainedOwnerBootstrapCeremony(context) {
      calls.push("cleanup"); return { schema: PRIVATE_FIRST_OWNER_CLEANUP_V1, installationId,
        requestDigest: context.requestDigest, scope: "retained_owner_bootstrap_ceremony" as const,
        outcome: "confirmed" as const };
    },
  });
}

async function recoveryFixture() {
  const schemaDigest = d("recovery-schema"), databaseIdentityDigest = d("recovery-database-identity");
  const protectedObservation = Object.freeze({ observedState: "verified" as const,
    observationDigest: d("verified-protected-root") });
  const storage = captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1",
    storageClass: "local", storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results",
    maximumArtifacts: 100, maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
  { releaseId: "release:local", releaseDigest, databaseSchemaVersion: "schema:76", databaseSchemaDigest: schemaDigest });
  const storageBindings = protectedDataStorageBindingsV1(storage);
  const protectedDataBindingDigest = protectedDataBindingDigestV1({ storageConfiguration: storage, ...protectedObservation });
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(name => [name, name === "protected_data"
    ? protectedDataStageInputDigestV1(storageBindings) : name === "recovery"
      ? recoveryStageInputDigestV1({ releaseDigest, topologyPlanDigest: topology.planDigest,
        protectedDataBindingDigest, storageConfigurationDigest: storageBindings.storageConfigurationDigest,
        storageNamespaceDigest: storageBindings.storageNamespaceDigest, databaseAuthorityOutcomeDigest: databaseOutcome,
        expectedDatabaseIdentityDigest: databaseIdentityDigest, expectedDatabaseSchemaDigest: schemaDigest })
      : d(`recovery-placeholder:${name}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history: InstallationPlanV1[] = [plan];
  let protectedDataPreparation: ReturnType<typeof prepareProtectedDataV1> | undefined;
  for (const selected of ["release_preflight", "private_placement", "database_authority", "protected_data", "first_owner"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    history.push(plan);
    if (selected === "protected_data") protectedDataPreparation = prepareProtectedDataV1({ installationPlan: plan,
      storageConfiguration: storage, ...protectedObservation });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome
        : selected === "protected_data" ? protectedDataBindingDigest : d(`recovery-outcome:${selected}`) });
    history.push(plan);
  }
  if (!protectedDataPreparation) throw new Error("protected_data_preparation_missing");
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-local-recovery-orchestrator-")));
  await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  for (const item of history) await journal.append(item);
  const source = Object.freeze({ protectedDataPreparation, storageConfiguration: storage,
    protectedDataObservation: protectedObservation, databaseAuthorityOutcomeDigest: databaseOutcome,
    expectedDatabaseIdentityDigest: databaseIdentityDigest, expectedDatabaseSchemaDigest: schemaDigest,
    observedState: "not_proven" as const, observationDigest: d("recovery-not-proven") });
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest, databaseSchemaVersion: "schema:76", databaseSchemaDigest: schemaDigest,
    storageNamespace: "artifacts:local", storageNamespaceDigest: storageBindings.storageNamespaceDigest,
    entries: [{ artifactId: "artifact:local", contentHash: d("artifact-bytes"), sizeBytes: 5,
      manifestDigest: d("artifact-manifest"), receiptDigest: d("artifact-receipt") }] });
  const proof = createLocalBackupRestoreReadinessV1({ planDigest: topology.planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local", releaseDigest,
      databaseIdentityDigest, databaseDumpDigest: d("database-dump"), databaseSchemaVersion: "schema:76",
      databaseSchemaDigest: schemaDigest, restoredToDisposableTarget: true, promoted: false, startsWork: false,
      grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false },
    expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory,
      restored: structuredClone(inventory) }) });
  const running = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "recovery", action: "start" });
  return { root, journal, plan, running, source, proof, protectedDataBindingDigest, stageInputs,
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

function recoveryRuntimeFor(fixture: Awaited<ReturnType<typeof recoveryFixture>>, calls: string[], fails = false):
  PrivateRecoveryOwnerRuntimeV1 {
  const binding = Object.freeze({ schema: PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, installationId,
    installationPlanDigest: fixture.running.planDigest, installationPlanRevision: fixture.running.revision,
    topologyPlanDigest: topology.planDigest, releaseDigest, protectedDataBindingDigest: fixture.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: databaseOutcome });
  return Object.freeze({ binding, signal: new AbortController().signal, controlDeadlineMs: 500,
    async confirmOwnerAttachedTerminal(context: PrivateRecoveryRunnerContextV1) {
      calls.push("owner-attached"); return { schema: PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1, installationId,
        requestDigest: context.requestDigest, installationPlanDigest: context.installationPlanDigest,
        installationPlanRevision: context.installationPlanRevision, topologyPlanDigest: context.topologyPlanDigest,
        releaseDigest: context.releaseDigest, protectedDataBindingDigest: context.protectedDataBindingDigest,
        databaseAuthorityOutcomeDigest: context.databaseAuthorityOutcomeDigest,
        ownerAttached: true as const, confirmed: true as const };
    },
    async runExistingBackupRestoreRehearsal() {
      calls.push("existing-rehearsal"); if (fails) throw new Error("lost recovery reply"); return fixture.proof;
    },
  });
}

function input(plan: InstallationPlanV1, requestedStage: "first_owner" | "recovery" | "platform_service",
  source: unknown = ownerSource) {
  return { installationId, expectedPlanRevision: plan.revision, expectedPlanDigest: plan.planDigest,
    expectedReleaseDigest: releaseDigest, requestedStage, topologyPlan: topology, source };
}

test("dispatches the exact next owner stage, settles it once, then exposes the missing recovery seam", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls) });
    assert.equal(result.status, "completed");
    assert.equal(result.installationPlan.stages[4]!.state, "passed");
    assert.deepEqual(calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
    assert.equal(result.createsStateMachine, false); assert.equal(result.createsReceiptStore, false);
    assert.equal(result.exposesBrowserEffect, false); assert.equal(result.suppliesNativeEffect, false);
    const before = (await f.journal.readHistory()).length;
    const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "recovery", {}), { journal: f.journal });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "recovery_private_adapter_missing");
    assert.equal((await f.journal.readHistory()).length, before);
  } finally { await f.cleanup(); }
});

test("installation, release, revision, digest, stage, and runtime substitution refuse before owner confirmation", async () => {
  for (const mutate of [
    (value: ReturnType<typeof input>) => ({ ...value, installationId: "other-installation" }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanRevision: value.expectedPlanRevision + 1 }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedPlanDigest: d("other-plan") }),
    (value: ReturnType<typeof input>) => ({ ...value, expectedReleaseDigest: d("other-release") }),
    (value: ReturnType<typeof input>) => ({ ...value, requestedStage: "recovery" as const, source: {} }),
  ]) {
    const f = await fixture(), calls: string[] = [];
    try {
      await assert.rejects(dispatchPrivateLocalSetupStageV1(mutate(input(f.plan, "first_owner")),
        { journal: f.journal, firstOwner: runtimeFor(f.running, calls) }), /private_local_setup_orchestrator_refused/);
      assert.deepEqual(calls, []);
      assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, f.plan.planDigest);
    } finally { await f.cleanup(); }
  }
});

test("an uncertain owner effect remains running and cannot be dispatched again", async () => {
  const f = await fixture(), calls: string[] = [];
  try {
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(f.running, calls, true) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "ceremony", "cleanup"]);
    const retained = (await f.journal.readHistory()).at(-1)!;
    assert.equal(retained.stages[4]!.state, "running");
    const retryCalls: string[] = [];
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(retained, "first_owner"),
      { journal: f.journal, firstOwner: runtimeFor(retained, retryCalls) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(retryCalls, []);
    assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, retained.planDigest);
  } finally { await f.cleanup(); }
});

test("dispatches and settles recovery only through the explicit injected existing-rehearsal runtime", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor(f, calls) });
    assert.equal(result.status, "completed");
    assert.equal(result.installationPlan.stages.find(stage => stage.stage === "recovery")!.state, "passed");
    assert.equal(result.installationPlan.stages.find(stage => stage.stage === "recovery")!.outcomeDigest, f.proof.proofDigest);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal(result.retriesUncertainEffect, false); assert.equal(result.suppliesNativeEffect, false);
    const blocked = await dispatchPrivateLocalSetupStageV1(input(result.installationPlan, "platform_service", {}),
      { journal: f.journal });
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blocker, "macos_native_service_port_missing");
  } finally { await f.cleanup(); }
});

test("an uncertain recovery remains running and the dispatcher cannot invoke a replacement runtime", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor(f, calls, true) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    const retained = (await f.journal.readHistory()).at(-1)!;
    assert.equal(retained.stages.find(stage => stage.stage === "recovery")!.state, "running");
    const retryCalls: string[] = [];
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(retained, "recovery", f.source),
      { journal: f.journal, recovery: recoveryRuntimeFor({ ...f, running: retained }, retryCalls) }),
    /private_local_setup_orchestrator_refused/);
    assert.deepEqual(retryCalls, []);
  } finally { await f.cleanup(); }
});

test("a later journal refresh cannot be reported as completed recovery", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    let refreshed = false;
    const interleaved = {
      append: f.journal.append.bind(f.journal),
      async readHistory() {
        const history = await f.journal.readHistory(), current = history.at(-1)!;
        if (!refreshed && current.stages.find(stage => stage.stage === "recovery")?.state === "passed") {
          refreshed = true;
          await f.journal.append(refreshInstallationPlanV1(current, { topologyPlan: topology, releaseDigest,
            stageInputDigests: { ...f.stageInputs, recovery: d("changed-after-recovery-settlement") } }));
        }
        return history;
      },
    };
    await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal: interleaved, recovery: recoveryRuntimeFor(f, calls) }), /private_local_setup_orchestrator_refused/);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state,
      "not_started");
  } finally { await f.cleanup(); }
});

test("simultaneous recovery dispatch publishes one running revision and invokes one rehearsal", async () => {
  const f = await recoveryFixture(), leftCalls: string[] = [], rightCalls: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
        { journal: f.journal, recovery: recoveryRuntimeFor(f, leftCalls) }),
      dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
        { journal: f.journal, recovery: recoveryRuntimeFor(f, rightCalls) }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal([...leftCalls, ...rightCalls].filter(item => item === "existing-rehearsal").length, 1);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "passed");
  } finally { await f.cleanup(); }
});

test("recovery source and runtime methods are captured before journal awaits", async () => {
  const f = await recoveryFixture(), calls: string[] = [], source = structuredClone(f.source) as unknown as Record<string, unknown>;
  let replacementCalled = false, mutated = false;
  const runtime = { ...recoveryRuntimeFor(f, calls) };
  const journal = {
    append: f.journal.append.bind(f.journal),
    async readHistory() {
      const pending = f.journal.readHistory();
      if (!mutated) {
        mutated = true;
        source.observationDigest = d("mutated-after-dispatch");
        runtime.runExistingBackupRestoreRehearsal = async () => {
          replacementCalled = true; throw new Error("replacement must not run");
        };
      }
      return pending;
    },
  };
  try {
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", source), { journal, recovery: runtime });
    assert.equal(result.status, "completed"); assert.equal(replacementCalled, false);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
  } finally { await f.cleanup(); }
});

test("malformed recovery source or runtime refuses before publishing running", async () => {
  for (const variant of ["source", "binding", "callable"] as const) {
    const f = await recoveryFixture(), calls: string[] = [];
    try {
      const before = await f.journal.readHistory(), source = structuredClone(f.source) as unknown as Record<string, unknown>;
      const runtime: Record<string, unknown> = { ...recoveryRuntimeFor(f, calls) };
      if (variant === "source") source.observedState = "verified";
      if (variant === "binding") runtime.binding = { ...(runtime.binding as object), releaseDigest: d("wrong-release") };
      if (variant === "callable") runtime.runExistingBackupRestoreRehearsal = "not-callable";
      await assert.rejects(dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", source),
        { journal: f.journal, recovery: runtime as never }), /private_local_setup_orchestrator_refused/);
      const after = await f.journal.readHistory();
      assert.equal(after.length, before.length, variant);
      assert.equal(after.at(-1)!.planDigest, before.at(-1)!.planDigest, variant);
      assert.deepEqual(calls, [], variant);
    } finally { await f.cleanup(); }
  }
});

test("a lost recovery settlement reply is recovered without rerunning the rehearsal", async () => {
  const f = await recoveryFixture(), calls: string[] = [];
  try {
    let lost = false;
    const journal = {
      readHistory: f.journal.readHistory.bind(f.journal),
      async append(plan: InstallationPlanV1) {
        if (!lost && plan.stages.find(stage => stage.stage === "recovery")?.state === "passed") {
          lost = true; await f.journal.append(plan); throw new Error("lost-settlement-reply");
        }
        return f.journal.append(plan);
      },
    };
    const result = await dispatchPrivateLocalSetupStageV1(input(f.plan, "recovery", f.source),
      { journal, recovery: recoveryRuntimeFor(f, calls) });
    assert.equal(result.status, "completed"); assert.equal(lost, true);
    assert.deepEqual(calls, ["owner-attached", "existing-rehearsal"]);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages.find(stage => stage.stage === "recovery")!.state, "passed");
  } finally { await f.cleanup(); }
});

test("simultaneous dispatch elects one fresh running revision before any owner effect", async () => {
  const f = await fixture(), leftCalls: string[] = [], rightCalls: string[] = [];
  try {
    const outcomes = await Promise.allSettled([
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, leftCalls) }),
      dispatchPrivateLocalSetupStageV1(input(f.plan, "first_owner"),
        { journal: f.journal, firstOwner: runtimeFor(f.running, rightCalls) }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.equal([...leftCalls, ...rightCalls].filter(item => item === "owner-attached").length, 1);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[4]!.state, "passed");
  } finally { await f.cleanup(); }
});

test("source directly reuses accepted transactions and runners and imports no browser, scheduler, database, or native effect", async () => {
  const source = await readFile("src/installer/v1/private-local-setup-orchestrator.ts", "utf8");
  for (const retained of ["startPostgresOwnerActionV1",
    "runPrivatePostgresOwnerActionV1", "confirmPostgresOwnerActionTerminalV1",
    "runPrivateProtectedRootOwnerActionV1", "confirmProtectedDataActionTerminalV1",
    "runPrivateFirstOwnerActionV1", "confirmFirstOwnerActionTerminalV1",
    "capturePrivateRecoveryOwnerRuntimePortV1", "verifyPrivateRecoveryOwnerRuntimeV1",
    "runPrivateRecoveryOwnerActionV1", "confirmRecoveryActionTerminalV1"]) assert.match(source, new RegExp(retained));
  assert.doesNotMatch(source, /from "(?:node:fs|node:child_process|node:net)"|pg-boss|private-app|launchctl|createServer|setInterval/i);
});
