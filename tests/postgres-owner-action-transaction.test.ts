import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { preparePostgresOwnerActionV1 } from "../src/installer/v1/postgres-owner-action";
import { confirmPostgresOwnerActionTerminalV1, POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1,
  startPostgresOwnerActionV1 } from "../src/installer/v1/postgres-owner-action-transaction";
import { postgresSetupStageInputDigestV1 } from "../src/installer/v1/postgres-setup-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const source = (state: "fresh" | "provisioned" | "existing_verified" = "fresh", suffix = "one") => ({
  ledgerDigest: digest(`ledger:${suffix}`), targetIdentityDigest: digest(`target:${suffix}`), observedTargetState: state,
  observationDigest: digest(`observation:${state}:${suffix}`),
});

function runningDatabasePlan(postgres = source()) {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local", adapterRevision: "0000001" }] });
  let plan: InstallationPlanV1 = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "database_authority"
      ? postgresSetupStageInputDigestV1({ releaseDigest: digest("release"), ledgerDigest: postgres.ledgerDigest,
        targetIdentityDigest: postgres.targetIdentityDigest }) : digest(`input:${stage}`)])) });
  for (const stage of ["release_preflight", "private_placement"] as const) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "start" });
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage, action: "pass", outcomeDigest: digest(`proof:${stage}`) });
  }
  return { topology, plan: advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "database_authority", action: "start" }), postgres };
}

async function fixture(start = true, postgres = source()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-postgres-owner-transaction-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-one", journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root,
    installationId, ownerUid: process.getuid!() });
  const setup = runningDatabasePlan(postgres);
  let persisted = createInstallationPlanV1({ topologyPlan: setup.topology, releaseDigest: digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "database_authority"
      ? postgresSetupStageInputDigestV1({ releaseDigest: digest("release"), ledgerDigest: setup.postgres.ledgerDigest,
        targetIdentityDigest: setup.postgres.targetIdentityDigest }) : digest(`input:${stage}`)])) });
  await journal.append(persisted);
  for (const stage of ["release_preflight", "private_placement"] as const) {
    persisted = advanceInstallationPlanV1(persisted, { expectedRevision: persisted.revision, stage, action: "start" });
    await journal.append(persisted);
    persisted = advanceInstallationPlanV1(persisted, { expectedRevision: persisted.revision, stage, action: "pass",
      outcomeDigest: digest(`proof:${stage}`) });
    await journal.append(persisted);
  }
  if (start) {
    persisted = advanceInstallationPlanV1(persisted, { expectedRevision: persisted.revision, stage: "database_authority", action: "start" });
    await journal.append(persisted);
    assert.equal(persisted.planDigest, setup.plan.planDigest);
  }
  const actionInput = { installationPlan: setup.plan, topologyPlan: setup.topology, expectedPlanRevision: setup.plan.revision,
    action: "postgres", source: setup.postgres };
  const actionPreparation = prepareInstallationActionV1(actionInput);
  const terminalConfirmation = (evidence = digest("terminal-evidence"), preparation = actionPreparation, input = actionInput) => ({ schema: POSTGRES_OWNER_ACTION_TERMINAL_CONFIRMATION_V1,
    requestDigest: sha256Digest({ purpose: "postgres-owner-action-request/v1", request: preparePostgresOwnerActionV1({ actionPreparation: preparation, actionInput: input }) }),
    terminalEvidenceDigest: evidence, terminalState: "confirmed" as const });
  return { root, installationId, journal, setup, actionInput, actionPreparation, terminalConfirmation,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("the transaction binds and journals the exact database inputs before preparation, and a running replay cannot start a tool", async () => {
  const f = await fixture(false);
  try {
    const startInput = { installationId: f.installationId, topologyPlan: f.setup.topology, releaseDigest: digest("release"),
      ledgerDigest: f.setup.postgres.ledgerDigest, targetIdentityDigest: f.setup.postgres.targetIdentityDigest };
    const first = await startPostgresOwnerActionV1(startInput, { journal: f.journal });
    const replay = await startPostgresOwnerActionV1(startInput, { journal: f.journal });
    assert.equal(first.installationPlan.stages[2]!.state, "running"); assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true); assert.equal(replay.performsEffect, false); assert.equal(replay.startsProcess, false);
    const actionInput = { ...f.actionInput, installationPlan: first.installationPlan,
      expectedPlanRevision: first.installationPlan.revision };
    assert.equal(prepareInstallationActionV1(actionInput).stage, "database_authority");
    await assert.rejects(() => startPostgresOwnerActionV1({ ...startInput, targetIdentityDigest: digest("changed-target") },
      { journal: f.journal }), /postgres_owner_action_transaction_refused/);
  } finally { await f.cleanup(); }
});

test("a confirmed owner terminal outcome appends one plan-bound receipt and exact restart replays it", async () => {
  const f = await fixture(true, source("existing_verified"));
  try {
    const input = { installationId: f.installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    const first = await confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal });
    const restartedJournal = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
      ownerUid: process.getuid!() });
    const recovered = await confirmPostgresOwnerActionTerminalV1(input, { journal: restartedJournal });
    assert.equal(first.replayed, false); assert.equal(recovered.replayed, true); assert.deepEqual(recovered.receipt, first.receipt);
    const history = await restartedJournal.readHistory();
    assert.equal(history.at(-1)!.stages[2]!.state, "passed");
    assert.equal(history.at(-1)!.stages[2]!.outcomeDigest, first.receipt.receiptDigest);
    assert.equal(first.createsReceiptStore, false); assert.equal(first.performsEffect, false);
    assert.doesNotMatch(JSON.stringify(first), /password|connectionString|postgresql:\/\/|--bootstrap-target|--migrate-target/i);
  } finally { await f.cleanup(); }
});

test("simultaneous exact confirmations settle through the existing journal as one receipt", async () => {
  const f = await fixture(true, source("existing_verified"));
  try {
    const input = { installationId: f.installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    const [left, right] = await Promise.all([confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal }),
      confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal })]);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]); assert.deepEqual(left.receipt, right.receipt);
    assert.equal((await f.journal.readHistory()).length, f.setup.plan.revision + 2);
  } finally { await f.cleanup(); }
});

test("changed confirmation, changed operation, and uncertain terminal plan state refuse rather than retry", async () => {
  const f = await fixture(true, source("existing_verified"));
  try {
    const input = { installationId: f.installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    await confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal });
    await assert.rejects(() => confirmPostgresOwnerActionTerminalV1({ ...input,
      terminalConfirmation: f.terminalConfirmation(digest("changed-terminal-evidence")) }, { journal: f.journal }),
    /postgres_owner_action_transaction_refused/);

    const changedSource = { ...f.setup.postgres, observedTargetState: "provisioned" as const, observationDigest: digest("changed-observation") };
    const changedInput = { ...f.actionInput, source: changedSource };
    const changedPreparation = prepareInstallationActionV1(changedInput);
    await assert.rejects(() => confirmPostgresOwnerActionTerminalV1({ installationId: f.installationId,
      actionPreparation: changedPreparation, actionInput: changedInput,
      terminalConfirmation: f.terminalConfirmation(digest("terminal-evidence"), changedPreparation, changedInput) },
    { journal: f.journal }), /postgres_owner_action_transaction_refused/);
  } finally { await f.cleanup(); }

  const uncertain = await fixture(true, source("existing_verified"));
  try {
    const uncertainPlan = advanceInstallationPlanV1(uncertain.setup.plan, { expectedRevision: uncertain.setup.plan.revision,
      stage: "database_authority", action: "uncertain", outcomeDigest: digest("terminal-lost") });
    await uncertain.journal.append(uncertainPlan);
    await assert.rejects(() => confirmPostgresOwnerActionTerminalV1({ installationId: uncertain.installationId,
      actionPreparation: uncertain.actionPreparation, actionInput: uncertain.actionInput,
      terminalConfirmation: uncertain.terminalConfirmation() }, { journal: uncertain.journal }), /postgres_owner_action_transaction_refused/);
  } finally { await uncertain.cleanup(); }
});

test("provisioning and migration confirmations cannot settle database authority", async () => {
  for (const state of ["fresh", "provisioned"] as const) {
    const f = await fixture(true, source(state));
    try {
      await assert.rejects(() => confirmPostgresOwnerActionTerminalV1({ installationId: f.installationId,
        actionPreparation: f.actionPreparation, actionInput: f.actionInput, terminalConfirmation: f.terminalConfirmation() },
      { journal: f.journal }), /postgres_owner_action_transaction_refused/);
      assert.equal((await f.journal.readHistory()).at(-1)!.stages[2]!.state, "running");
    } finally { await f.cleanup(); }
  }
});

test("journal identity and current plan state are mandatory for every replay path", async () => {
  const f = await fixture(true, source("existing_verified"));
  try {
    const input = { installationId: f.installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    const beforeWrongTerminal = await f.journal.readHistory();
    await assert.rejects(() => confirmPostgresOwnerActionTerminalV1({ ...input, installationId: "other-installation" },
      { journal: f.journal }), /postgres_owner_action_transaction_refused/);
    const afterWrongTerminal = await f.journal.readHistory();
    assert.equal(afterWrongTerminal.length, beforeWrongTerminal.length);
    assert.equal(afterWrongTerminal.at(-1)!.stages[2]!.state, "running");
    const first = await confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal });

    const settled = (await f.journal.readHistory()).at(-1)!;
    const changedTarget = digest("later-target");
    const refreshed = refreshInstallationPlanV1(settled, { topologyPlan: f.setup.topology, releaseDigest: digest("release"),
      stageInputDigests: Object.fromEntries(settled.stages.map(item => [item.stage, item.stage === "database_authority"
        ? postgresSetupStageInputDigestV1({ releaseDigest: digest("release"), ledgerDigest: f.setup.postgres.ledgerDigest,
          targetIdentityDigest: changedTarget }) : item.inputDigest])) });
    await f.journal.append(refreshed);
    assert.equal(refreshed.stages[2]!.state, "not_started");
    await assert.rejects(() => confirmPostgresOwnerActionTerminalV1(input, { journal: f.journal }),
      /postgres_owner_action_transaction_refused/);
    assert.equal(first.receipt.operation, "collect_existing_database_evidence");
  } finally { await f.cleanup(); }

  const unstarted = await fixture(false);
  try {
    const beforeWrongStart = await unstarted.journal.readHistory();
    await assert.rejects(() => startPostgresOwnerActionV1({ installationId: "other-installation", topologyPlan: unstarted.setup.topology,
      releaseDigest: digest("release"), ledgerDigest: unstarted.setup.postgres.ledgerDigest,
      targetIdentityDigest: unstarted.setup.postgres.targetIdentityDigest }, { journal: unstarted.journal }),
    /postgres_owner_action_transaction_refused/);
    const afterWrongStart = await unstarted.journal.readHistory();
    assert.equal(afterWrongStart.length, beforeWrongStart.length);
    assert.equal(afterWrongStart.at(-1)!.stages[2]!.state, "not_started");
  } finally { await unstarted.cleanup(); }
});
