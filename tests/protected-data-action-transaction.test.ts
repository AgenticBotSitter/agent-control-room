import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureArtifactStorageConfigurationV1 } from "../src/config/v1/artifact-storage";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1, confirmProtectedDataActionTerminalV1,
  prepareProtectedDataActionTransactionRequestV1 }
  from "../src/installer/v1/protected-data-action-transaction";
import { PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1 } from "../src/installer/v1/private-protected-root-owner-runner";
import { protectedDataBindingDigestV1, protectedDataStageInputDigestV1 }
  from "../src/installer/v1/protected-data-recovery-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const releaseDigest = d("release");
const databaseOutcome = d("database-outcome");
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:hermes",
    adapterRevision: "0000001" }] });
const storage = captureArtifactStorageConfigurationV1({ schema: "control-room.artifact-storage-settings/v1", storageClass: "local",
  storageNamespace: "artifacts:local", rootPath: "/private/owner/control-room/results", maximumArtifacts: 100,
  maximumFileBytes: 65_536, maximumTotalBytes: 6_553_600, operationTimeoutMs: 2_000 },
{ releaseId: "release:local", releaseDigest, databaseSchemaVersion: "schema:76", databaseSchemaDigest: d("schema") });
const storageConfigurationDigest = d({ purpose: "protected-artifact-storage-configuration/v1",
  local: storage.local, inventory: storage.inventory });

function stageInputs(storageDigest = storageConfigurationDigest) {
  return Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "protected_data"
    ? protectedDataStageInputDigestV1({ releaseDigest, storageConfigurationDigest: storageDigest,
      storageNamespaceDigest: storage.inventory.storageNamespaceDigest }) : d(`input:${stage}`)]));
}

function runningPlan() {
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs() });
  for (const selected of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    if (selected === "protected_data") return plan;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome : d(`outcome:${selected}`) });
  }
  throw new Error("protected_data_missing");
}

function actionFor(plan = runningPlan()) {
  const actionInput = { installationPlan: plan, topologyPlan: topology, expectedPlanRevision: plan.revision,
    action: "protected_data" as const, source: { storageConfiguration: storage, observedState: "missing" as const,
      observationDigest: d("missing-root") } };
  return { actionInput, actionPreparation: prepareInstallationActionV1(actionInput) };
}

async function fixture(selectedInstallationId = installationId) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-protected-data-transaction-")));
  await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root,
    installationId: selectedInstallationId, ownerUid: process.getuid!() });
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs() });
  await journal.append(plan);
  for (const selected of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    await journal.append(plan);
    if (selected === "protected_data") break;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? databaseOutcome : d(`outcome:${selected}`) });
    await journal.append(plan);
  }
  const action = actionFor(plan), request = prepareProtectedDataActionTransactionRequestV1(action);
  const ownerObservation = (observationDigest = d("verified-private-root")) => ({
    schema: PRIVATE_PROTECTED_ROOT_OWNER_RUNNER_V1, requestDigest: request.ownerActionRequestDigest,
    operation: request.operation, observedState: "verified" as const, observationDigest,
    protectedDataBindingDigest: protectedDataBindingDigestV1({ storageConfiguration: storage,
      observedState: "verified", observationDigest }), storageConfigurationDigest,
    storageNamespaceDigest: storage.inventory.storageNamespaceDigest, preflightReceiptDigest: d({ observationDigest, kind: "preflight" }),
    createdDirectory: true,
  });
  const terminalObservation = (observationDigest = d("verified-private-root")) => ({
    schema: PROTECTED_DATA_ACTION_TERMINAL_CONFIRMATION_V1, installationId: selectedInstallationId,
    transactionRequestDigest: d({ purpose: "protected-data-action-transaction-request/v1", request }),
    ownerObservation: ownerObservation(observationDigest), terminalState: "confirmed" as const,
  });
  return { root, journal, plan, ...action, request, ownerObservation, terminalObservation,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("terminal private-root evidence appends the protected binding and restart replays it", async () => {
  const f = await fixture();
  try {
    const input = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalObservation: f.terminalObservation() };
    const first = await confirmProtectedDataActionTerminalV1(input, { journal: f.journal });
    const restarted = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId,
      ownerUid: process.getuid!() });
    const replay = await confirmProtectedDataActionTerminalV1(input, { journal: restarted });
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
    const settled = (await restarted.readHistory()).at(-1)!.stages.find(item => item.stage === "protected_data")!;
    assert.equal(settled.state, "passed");
    assert.equal(settled.outcomeDigest, first.receipt.protectedDataBindingDigest);
    assert.notEqual(settled.outcomeDigest, first.receipt.receiptDigest);
    assert.equal(first.receipt.databaseAuthorityOutcomeDigest, databaseOutcome);
    assert.equal(first.performsEffect, false); assert.equal(first.touchesFilesystem, false);
    assert.doesNotMatch(JSON.stringify(first), /rootPath|private\/owner|password|credential|postgresql:\/\//i);
  } finally { await f.cleanup(); }
});

test("simultaneous exact terminal observations publish one binding", async () => {
  const f = await fixture();
  try {
    const input = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalObservation: f.terminalObservation() };
    const [left, right] = await Promise.all([confirmProtectedDataActionTerminalV1(input, { journal: f.journal }),
      confirmProtectedDataActionTerminalV1(input, { journal: f.journal })]);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    assert.deepEqual(left.receipt, right.receipt);
    assert.equal((await f.journal.readHistory()).length, f.plan.revision + 2);
  } finally { await f.cleanup(); }
});

test("simultaneous changed terminal observations cannot both settle", async () => {
  const f = await fixture();
  try {
    const base = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput };
    const outcomes = await Promise.allSettled([
      confirmProtectedDataActionTerminalV1({ ...base, terminalObservation: f.terminalObservation(d("left-root")) }, { journal: f.journal }),
      confirmProtectedDataActionTerminalV1({ ...base, terminalObservation: f.terminalObservation(d("right-root")) }, { journal: f.journal }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    assert.match(String((outcomes.find(item => item.status === "rejected") as PromiseRejectedResult).reason),
      /protected_data_action_transaction_refused/);
    const accepted = outcomes.find(item => item.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof confirmProtectedDataActionTerminalV1>>>;
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[3]!.outcomeDigest,
      accepted.value.receipt.protectedDataBindingDigest);
  } finally { await f.cleanup(); }
});

test("journal method substitution after the first async boundary cannot change the captured port", async () => {
  const f = await fixture();
  try {
    const port = { append: f.journal.append.bind(f.journal), readHistory: async () => {
      const history = await f.journal.readHistory();
      port.append = async () => { throw new Error("substituted_append_must_not_run"); };
      return history;
    } };
    const result = await confirmProtectedDataActionTerminalV1({ installationId,
      actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalObservation: f.terminalObservation() }, { journal: port });
    assert.equal(result.replayed, false);
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[3]!.state, "passed");
  } finally { await f.cleanup(); }
});

test("preparation and malformed, substituted, or foreign terminal evidence cannot pass", async () => {
  const first = await fixture("local-installation-one"), second = await fixture("local-installation-two");
  try {
    const base = { installationId, actionPreparation: first.actionPreparation, actionInput: first.actionInput };
    await assert.rejects(() => confirmProtectedDataActionTerminalV1({ ...base,
      terminalObservation: first.actionPreparation }, { journal: first.journal }), /protected_data_action_transaction_refused/);
    for (const terminalObservation of [
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), observedState: "present_unverified" } },
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), requestDigest: d("other-request") } },
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), storageConfigurationDigest: d("other-storage") } },
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), protectedDataBindingDigest: d("forged-binding") } },
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), operation: "verify_owner_private_data_root" } },
      { ...first.terminalObservation(), ownerObservation: { ...first.ownerObservation(), createdDirectory: false } },
      { ...first.terminalObservation(), unexpected: true },
    ]) await assert.rejects(() => confirmProtectedDataActionTerminalV1({ ...base, terminalObservation }, { journal: first.journal }),
      /protected_data_action_transaction_refused/);
    await assert.rejects(() => confirmProtectedDataActionTerminalV1({ installationId: "local-installation-two",
      actionPreparation: second.actionPreparation, actionInput: second.actionInput,
      terminalObservation: first.terminalObservation() }, { journal: second.journal }), /protected_data_action_transaction_refused/);
    assert.equal((await first.journal.readHistory()).at(-1)!.stages[3]!.state, "running");
    assert.equal((await second.journal.readHistory()).at(-1)!.stages[3]!.state, "running");
  } finally { await first.cleanup(); await second.cleanup(); }
});

test("stale, changed, and uncertain journal state refuses without repair or retry", async () => {
  const uncertain = await fixture();
  try {
    const changed = advanceInstallationPlanV1(uncertain.plan, { expectedRevision: uncertain.plan.revision,
      stage: "protected_data", action: "uncertain", outcomeDigest: d("lost-private-root-outcome") });
    await uncertain.journal.append(changed);
    await assert.rejects(() => confirmProtectedDataActionTerminalV1({ installationId,
      actionPreparation: uncertain.actionPreparation, actionInput: uncertain.actionInput,
      terminalObservation: uncertain.terminalObservation() }, { journal: uncertain.journal }),
    /protected_data_action_transaction_refused/);
  } finally { await uncertain.cleanup(); }

  const stale = await fixture();
  try {
    const input = { installationId, actionPreparation: stale.actionPreparation, actionInput: stale.actionInput,
      terminalObservation: stale.terminalObservation() };
    await confirmProtectedDataActionTerminalV1(input, { journal: stale.journal });
    const settled = (await stale.journal.readHistory()).at(-1)!;
    const refreshed = refreshInstallationPlanV1(settled, { topologyPlan: topology, releaseDigest,
      stageInputDigests: stageInputs(d("replacement-storage-configuration")) });
    await stale.journal.append(refreshed);
    assert.equal(refreshed.stages[3]!.state, "not_started");
    await assert.rejects(() => confirmProtectedDataActionTerminalV1(input, { journal: stale.journal }),
      /protected_data_action_transaction_refused/);
  } finally { await stale.cleanup(); }
});

test("transaction source has only journal, plan, preparation, request, runner-schema, and digest dependencies", async () => {
  const source = await readFile("src/installer/v1/protected-data-action-transaction.ts", "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gmu)].map(match => match[1]);
  assert.deepEqual(imports, ["../../security/canonical-digest", "./installation-action-preparation", "./installation-plan",
    "./installation-plan-journal", "./private-protected-root-owner-runner", "./protected-data-recovery-owner-action"]);
  assert.doesNotMatch(source, /from "node:(?:fs|net|child_process)"|persistent-local-storage|private-artifact-storage|private-postgres|backup-database|restore-database/i);
});
