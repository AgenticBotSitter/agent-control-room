import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1, confirmFirstOwnerActionTerminalV1,
  prepareFirstOwnerActionTransactionRequestV1 } from "../src/installer/v1/first-owner-action-transaction";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1, type InstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const installationId = "local-installation-one";
const releaseDigest = d("release");
const ownerBindings = Object.freeze({ releaseDigest, databaseAuthorityOutcomeDigest: d("database-outcome"),
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:hermes",
    adapterRevision: "0000001" }] });

function stageInputs(bindings = ownerBindings) {
  return Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "first_owner"
    ? firstOwnerStageInputDigestV1(bindings) : d(`input:${stage}`)]));
}

function runningPlan(bindings = ownerBindings) {
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs(bindings) });
  for (const selected of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    if (selected === "first_owner") return plan;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? bindings.databaseAuthorityOutcomeDigest : d(`outcome:${selected}`) });
  }
  throw new Error("first_owner_missing");
}

function actionFor(plan = runningPlan(), bindings = ownerBindings) {
  const actionInput = { installationPlan: plan, topologyPlan: topology, expectedPlanRevision: plan.revision,
    action: "first_owner" as const, source: { databaseAuthorityOutcomeDigest: bindings.databaseAuthorityOutcomeDigest,
      bootstrapConfigurationDigest: bindings.bootstrapConfigurationDigest,
      trustConfigurationDigest: bindings.trustConfigurationDigest,
      expectedOwnerSubjectDigest: bindings.expectedOwnerSubjectDigest, observedOwnerState: "empty" as const,
      observationDigest: d("empty-owner-proof") } };
  return { actionInput, actionPreparation: prepareInstallationActionV1(actionInput) };
}

async function fixture(selectedInstallationId = installationId) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-first-owner-transaction-")));
  await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root,
    installationId: selectedInstallationId, ownerUid: process.getuid!() });
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs() });
  await journal.append(plan);
  for (const selected of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    await journal.append(plan);
    if (selected === "first_owner") break;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? ownerBindings.databaseAuthorityOutcomeDigest : d(`outcome:${selected}`) });
    await journal.append(plan);
  }
  const action = actionFor(plan);
  const request = prepareFirstOwnerActionTransactionRequestV1(action);
  const terminalConfirmation = (ownerProofDigest = d("verified-owner-proof"), ceremonyOutcomeDigest = d("ceremony-complete")) => ({
    schema: FIRST_OWNER_ACTION_TERMINAL_CONFIRMATION_V1,
    installationId: selectedInstallationId,
    requestDigest: sha256Digest({ purpose: "first-owner-action-request/v1", request }),
    expectedOwnerSubjectDigest: ownerBindings.expectedOwnerSubjectDigest,
    ownerConfirmed: true as const, ownerState: "existing" as const, ownerProofDigest, ceremonyOutcomeDigest,
    terminalState: "confirmed" as const,
  });
  return { root, journal, plan, ...action, request, terminalConfirmation,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("an exact final owner proof appends one plan receipt and restart replays it", async () => {
  const f = await fixture();
  try {
    const input = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    const first = await confirmFirstOwnerActionTerminalV1(input, { journal: f.journal });
    const restarted = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId,
      ownerUid: process.getuid!() });
    const replay = await confirmFirstOwnerActionTerminalV1(input, { journal: restarted });
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
    assert.equal((await restarted.readHistory()).at(-1)!.stages[4]!.state, "passed");
    assert.equal(first.receipt.databaseAuthorityOutcomeDigest, ownerBindings.databaseAuthorityOutcomeDigest);
    assert.equal(first.receipt.expectedOwnerSubjectDigest, ownerBindings.expectedOwnerSubjectDigest);
    assert.equal(first.performsEffect, false); assert.equal(first.createsOwner, false);
    assert.doesNotMatch(JSON.stringify(first), /assertion|one.?time.?code|password|postgresql:\/\/|\/private\//i);
  } finally { await f.cleanup(); }
});

test("simultaneous exact final confirmations publish one receipt", async () => {
  const f = await fixture();
  try {
    const input = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput,
      terminalConfirmation: f.terminalConfirmation() };
    const [left, right] = await Promise.all([confirmFirstOwnerActionTerminalV1(input, { journal: f.journal }),
      confirmFirstOwnerActionTerminalV1(input, { journal: f.journal })]);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    assert.deepEqual(left.receipt, right.receipt);
    assert.equal((await f.journal.readHistory()).length, f.plan.revision + 2);
  } finally { await f.cleanup(); }
});

test("simultaneous changed confirmations cannot both settle", async () => {
  const f = await fixture();
  try {
    const base = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput };
    const outcomes = await Promise.allSettled([
      confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: f.terminalConfirmation(d("owner-proof-left")) },
        { journal: f.journal }),
      confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: f.terminalConfirmation(d("owner-proof-right")) },
        { journal: f.journal }),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    const rejected = outcomes.find(item => item.status === "rejected") as PromiseRejectedResult;
    assert.match(String(rejected.reason), /first_owner_action_transaction_refused/);
    const accepted = outcomes.find(item => item.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof confirmFirstOwnerActionTerminalV1>>>;
    assert.equal((await f.journal.readHistory()).at(-1)!.stages[4]!.outcomeDigest,
      accepted.value.receipt.receiptDigest);
  } finally { await f.cleanup(); }
});

test("a terminal confirmation is bound to one installation even when another journal has identical plan bytes", async () => {
  const first = await fixture("local-installation-one"), second = await fixture("local-installation-two");
  try {
    assert.deepEqual(first.request, second.request);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ installationId: "local-installation-two",
      actionPreparation: second.actionPreparation, actionInput: second.actionInput,
      terminalConfirmation: first.terminalConfirmation() }, { journal: second.journal }),
    /first_owner_action_transaction_refused/);
    assert.equal((await second.journal.readHistory()).at(-1)!.stages[4]!.state, "running");
  } finally { await first.cleanup(); await second.cleanup(); }
});

test("preparation, arming, changed proof, changed subject, and uncertain owner state cannot pass", async () => {
  const f = await fixture();
  try {
    const base = { installationId, actionPreparation: f.actionPreparation, actionInput: f.actionInput };
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base,
      terminalConfirmation: f.actionPreparation }, { journal: f.journal }), /first_owner_action_transaction_refused/);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: {
      schema: "control-room.owner-bootstrap-arm/v1", armed: true, expiresAt: "2099-01-01T00:00:00.000Z",
      listenerStarted: false, physicalPeerQualificationComplete: false,
    } }, { journal: f.journal }), /first_owner_action_transaction_refused/);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: {
      ...f.terminalConfirmation(), ownerConfirmed: false } }, { journal: f.journal }), /first_owner_action_transaction_refused/);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: {
      ...f.terminalConfirmation(), ownerState: "uncertain" } }, { journal: f.journal }), /first_owner_action_transaction_refused/);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base, terminalConfirmation: {
      ...f.terminalConfirmation(), expectedOwnerSubjectDigest: d("changed-subject") } }, { journal: f.journal }),
    /first_owner_action_transaction_refused/);

    const valid = { ...base, terminalConfirmation: f.terminalConfirmation() };
    await confirmFirstOwnerActionTerminalV1(valid, { journal: f.journal });
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ ...base,
      terminalConfirmation: f.terminalConfirmation(d("changed-proof")) }, { journal: f.journal }),
    /first_owner_action_transaction_refused/);
  } finally { await f.cleanup(); }
});

test("stale, changed, and uncertain journal state refuses rather than guessing or retrying", async () => {
  const uncertain = await fixture();
  try {
    const plan = advanceInstallationPlanV1(uncertain.plan, { expectedRevision: uncertain.plan.revision,
      stage: "first_owner", action: "uncertain", outcomeDigest: d("lost-terminal-outcome") });
    await uncertain.journal.append(plan);
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1({ installationId,
      actionPreparation: uncertain.actionPreparation, actionInput: uncertain.actionInput,
      terminalConfirmation: uncertain.terminalConfirmation() }, { journal: uncertain.journal }),
    /first_owner_action_transaction_refused/);
  } finally { await uncertain.cleanup(); }

  const stale = await fixture();
  try {
    const input = { installationId, actionPreparation: stale.actionPreparation, actionInput: stale.actionInput,
      terminalConfirmation: stale.terminalConfirmation() };
    await confirmFirstOwnerActionTerminalV1(input, { journal: stale.journal });
    const settled = (await stale.journal.readHistory()).at(-1)!;
    const changed = { ...ownerBindings, expectedOwnerSubjectDigest: d("replacement-owner-subject") };
    const refreshed = refreshInstallationPlanV1(settled, { topologyPlan: topology, releaseDigest,
      stageInputDigests: stageInputs(changed) });
    await stale.journal.append(refreshed);
    assert.equal(refreshed.stages[4]!.state, "not_started");
    await assert.rejects(() => confirmFirstOwnerActionTerminalV1(input, { journal: stale.journal }),
      /first_owner_action_transaction_refused/);
  } finally { await stale.cleanup(); }
});

test("the transaction source imports no owner, database, listener, credential, or filesystem effect implementation", async () => {
  const source = await readFile("src/installer/v1/first-owner-action-transaction.ts", "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gmu)].map(match => match[1]);
  assert.deepEqual(imports, ["../../security/canonical-digest", "./installation-action-preparation",
    "./installation-plan", "./installation-plan-journal"]);
  assert.doesNotMatch(source, /from "node:(?:fs|net|child_process)"|private-owner-bootstrap|owner-bootstrap-ceremony|private-postgres/i);
});
