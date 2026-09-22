import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { createControllerOnlyInstallationTopologyV1, initializeLocalInstallationPlanV1, localInstallationStageInputDigestsV1,
  localInstallationStageLabelsV1 } from "../src/installer/v1/local-installation-plan-bootstrap";
import { installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const topology = (suffix = "one") => planInstallationTopologyV1({
  databaseAuthorityDigest: digest(`database:${suffix}`), schedulerAuthorityDigest: digest(`scheduler:${suffix}`),
  currentRoutes: [], requestedRoutes: [],
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-local-plan-bootstrap-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-one", ownerUid = process.getuid!();
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
  return { root, installationId, ownerUid, journal,
    input: { ownerAttended: true as const, journalRoot: root, installationId,
      releaseDigest: digest("release:one"), topologyPlan: topology() },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("reviewed versioned labels produce deterministic inputs without claiming completion", () => {
  const first = localInstallationStageInputDigestsV1(), exact = localInstallationStageInputDigestsV1();
  assert.deepEqual(first, exact);
  assert.deepEqual(Object.keys(first), [...installationSetupStagesV1]);
  assert.equal(new Set(Object.values(first)).size, installationSetupStagesV1.length);
  assert.ok(Object.values(first).every(value => /^sha256:[a-f0-9]{64}$/u.test(value)));
  assert.ok(Object.values(localInstallationStageLabelsV1).every(label => !/passed|completed|successful/u.test(label)));
});

test("controller-only topology records honest unselected authorities without inventing an agent", () => {
  const first = createControllerOnlyInstallationTopologyV1(), exact = createControllerOnlyInstallationTopologyV1();
  assert.deepEqual(first, exact);
  assert.deepEqual(first.retainedWorkerIds, []); assert.deepEqual(first.addedLocalWorkerIds, []);
  assert.deepEqual(first.addedRemoteWorkerIds, []); assert.deepEqual(first.requiredProofs, ["backup_restore"]);
  assert.equal(first.enablesWorkers, false);
  assert.notEqual(first.databaseAuthorityDigest, first.schedulerAuthorityDigest);
  assert.doesNotMatch(JSON.stringify(first), /worker:|agent:|localhost|postgresql:\/\//u);
});

test("initializes canonical revision zero and accepts only an exact replay", async () => {
  const f = await fixture();
  try {
    const first = await initializeLocalInstallationPlanV1(f.input, { ownerUid: () => f.ownerUid });
    assert.deepEqual(first, { schema: "control-room.local-installation-plan-bootstrap/v1",
      installationId: f.installationId, revision: 0, planDigest: first.planDigest, replayed: false,
      createsDatabase: false, writesCredentials: false, startsService: false, startsWorker: false,
      enablesAuthority: false, enablesWorkers: false, grantsExecutionAuthority: false });
    assert.doesNotMatch(JSON.stringify(first), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(JSON.stringify(first), /database:one|release:one|reviewedLabel/u);
    const [stored] = await f.journal.inspectSettledHistory();
    assert.equal(stored?.revision, 0);
    assert.equal(stored?.releaseDigest, f.input.releaseDigest);
    assert.equal(stored?.topologyPlanDigest, f.input.topologyPlan.planDigest);
    assert.ok(stored?.stages.every(stage => stage.state === "not_started"
      && stage.outcomeDigest === undefined && stage.recordedRevision === undefined));
    assert.deepEqual(Object.fromEntries(stored!.stages.map(stage => [stage.stage, stage.inputDigest])),
      localInstallationStageInputDigestsV1());
    const replay = await initializeLocalInstallationPlanV1(f.input, { ownerUid: () => f.ownerUid });
    assert.equal(replay.replayed, true); assert.equal(replay.planDigest, first.planDigest);
    await assert.rejects(initializeLocalInstallationPlanV1({ ...f.input, releaseDigest: digest("release:changed") },
      { ownerUid: () => f.ownerUid }), /local_installation_plan_bootstrap_conflict/u);
    await assert.rejects(initializeLocalInstallationPlanV1({ ...f.input, topologyPlan: topology("changed") },
      { ownerUid: () => f.ownerUid }), /local_installation_plan_bootstrap_conflict/u);
  } finally { await f.cleanup(); }
});

test("uses the runtime owner identity and refuses malformed or unowned input", async () => {
  const f = await fixture();
  try {
    let configuration: unknown, appendCalls = 0;
    const result = await initializeLocalInstallationPlanV1(f.input, { ownerUid: () => 777,
      createJournal(value) { configuration = value; return { async append(plan) { appendCalls += 1; return {
        schema: "control-room.installation-plan-journal/v1", installationId: f.installationId,
        revision: 0, planDigest: plan.planDigest, replayed: false, enablesAuthority: false,
        startsService: false, startsWorker: false } as const; } }; } });
    assert.deepEqual(configuration, { rootDirectory: f.root, installationId: f.installationId, ownerUid: 777 });
    assert.equal(appendCalls, 1); assert.equal(result.revision, 0);
    for (const invalid of [{ ...f.input, ownerAttended: false }, { ...f.input, journalRoot: "relative" },
      { ...f.input, installationId: "Unsafe_ID" }, { ...f.input, extra: true }])
      await assert.rejects(initializeLocalInstallationPlanV1(invalid, { ownerUid: () => f.ownerUid }), /bootstrap_refused/u);
    await assert.rejects(initializeLocalInstallationPlanV1(f.input, { ownerUid: () => undefined }), /bootstrap_refused/u);
  } finally { await f.cleanup(); }
});

test("the canonical plan journal remains separate from the clean-install rehearsal journal", async () => {
  const f = await fixture();
  try {
    const rehearsal = join(f.root, `${f.installationId}.clean-install-rehearsal.json`);
    await writeFile(rehearsal, "{\"schema\":\"control-room.local-clean-install-rehearsal-journal/v1\"}\n", { mode: 0o600 });
    await initializeLocalInstallationPlanV1(f.input, { ownerUid: () => f.ownerUid });
    assert.match(await readFile(rehearsal, "utf8"), /local-clean-install-rehearsal-journal/u);
    assert.equal((await f.journal.inspectSettledHistory()).length, 1);
  } finally { await f.cleanup(); }
});
