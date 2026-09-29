import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { completeLocalInstallationPrerequisitesV1,
  LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1 } from "../src/installer/v1/local-installation-prerequisite-transaction";
import { prepareLocalInstallationReleaseV1 } from "../src/installer/v1/local-installation-release.mjs";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: unknown) => sha256Digest(value);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestDigest = async (path: string) => `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;

function topology(suffix = "one") {
  return planInstallationTopologyV1({ databaseAuthorityDigest: digest(`database:${suffix}`),
    schedulerAuthorityDigest: digest(`scheduler:${suffix}`), currentRoutes: [], requestedRoutes: [] });
}

function reports(releaseDigest: string, suffix = "one") {
  return {
    releasePreflight: {
      schema: "control-room.local-installation-package-preparation/v1", mode: "dry-run", bundle: {
        state: "fingerprinted", version: "1.2.3", fileCount: 12, byteCount: 4567, digest: digest(`bundle:${suffix}`),
        authenticityVerified: false,
      }, service: { state: "awaiting_owner_setup" }, readyForOwnerSetup: true, startsService: false,
      releaseManifestDigest: releaseDigest, createsDatabase: false, writesCredentials: false,
      nextSteps: ["Owner review remains required."],
    },
    privatePlacement: {
      schema: "control-room.local-release-staging/v1", state: "verified_release_staged", version: "1.2.3",
      releaseManifestDigest: releaseDigest, alreadyStaged: false, fileCount: 7, byteCount: 8000,
      remainingCategory: "production_dependencies_not_prepared",
      preparesDependencies: false, switchesCurrentRelease: false, installsOrStartsService: false, createsDatabase: false,
      writesCredentials: false, usesNetwork: false, publishes: false,
    },
  } as const;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-local-prerequisites-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-one", ownerUid = process.getuid!(), releaseDigest = digest("release-manifest:one");
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
  const plan = createInstallationPlanV1({ topologyPlan: topology(), releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(`bootstrap:${stage}`)])) });
  await journal.append(plan);
  return { root, installationId, journal, releaseDigest, input: { installationId, topologyPlan: topology(), releaseDigest, ...reports(releaseDigest) },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("records the four prerequisite transitions in order and exposes only a reachable database stage", async () => {
  const f = await fixture();
  try {
    const result = await completeLocalInstallationPrerequisitesV1(f.input, { journal: f.journal });
    assert.equal(result.schema, LOCAL_INSTALLATION_PREREQUISITE_TRANSACTION_V1);
    assert.equal(result.replayed, false); assert.equal(result.createsReceiptStore, false);
    assert.equal(result.performsEffect, false); assert.equal(result.startsService, false); assert.equal(result.createsDatabase, false);
    assert.equal(result.installationPlan.stages.find(item => item.stage === "release_preflight")?.state, "passed");
    assert.equal(result.installationPlan.stages.find(item => item.stage === "private_placement")?.state, "passed");
    assert.equal(result.installationPlan.stages.find(item => item.stage === "database_authority")?.state, "not_started");
    assert.equal(result.installationPlan.revision, 5);
    assert.equal(result.releasePreflight.evidenceDigest, sha256Digest({ purpose: "local-installation-release-preflight-report-evidence/v1",
      releaseDigest: f.releaseDigest, report: f.input.releasePreflight }));
    assert.equal(result.privatePlacement.evidenceDigest, sha256Digest({ purpose: "local-installation-private-placement-report-evidence/v1",
      installationId: f.installationId, releaseDigest: f.releaseDigest, report: f.input.privatePlacement }));

    const history = await f.journal.readHistory();
    assert.deepEqual(history.map(plan => plan.revision), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(history.slice(2).map(plan => {
      const active = plan.stages.find(item => item.recordedRevision === plan.revision);
      return [active?.stage, active?.state];
    }), [["release_preflight", "running"], ["release_preflight", "passed"],
      ["private_placement", "running"], ["private_placement", "passed"]]);
    assert.equal(history.at(-1)?.stages.find(item => item.stage === "release_preflight")?.outcomeDigest,
      result.releasePreflight.receiptDigest);
    assert.equal(history.at(-1)?.stages.find(item => item.stage === "private_placement")?.outcomeDigest,
      result.privatePlacement.receiptDigest);
  } finally { await f.cleanup(); }
});

test("same-input concurrency settles once, then an exact replay reads the settled plan", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => completeLocalInstallationPrerequisitesV1(f.input, { journal: f.journal })));
    assert.ok(results.some(result => result.status === "fulfilled"));
    assert.ok(results.filter(result => result.status === "rejected").every(result =>
      result.reason instanceof Error && result.reason.message === "local_installation_prerequisite_transaction_refused"));
    assert.equal((await f.journal.readHistory()).length, 6);
    const replay = await completeLocalInstallationPrerequisitesV1(f.input, { journal: f.journal });
    assert.equal(replay.replayed, true);
  } finally { await f.cleanup(); }
});

test("changed evidence, uncertain progress, and a stale database start are refused", async () => {
  const changed = await fixture();
  try {
    await completeLocalInstallationPrerequisitesV1(changed.input, { journal: changed.journal });
    await assert.rejects(completeLocalInstallationPrerequisitesV1({ ...changed.input,
      releasePreflight: reports(changed.releaseDigest, "changed").releasePreflight }, { journal: changed.journal }),
    /local_installation_prerequisite_transaction_refused/u);
    const settled = (await changed.journal.readHistory()).at(-1)!;
    await changed.journal.append(advanceInstallationPlanV1(settled, { expectedRevision: settled.revision,
      stage: "database_authority", action: "start" }));
    await assert.rejects(completeLocalInstallationPrerequisitesV1(changed.input, { journal: changed.journal }),
      /local_installation_prerequisite_transaction_refused/u);
  } finally { await changed.cleanup(); }

  const uncertain = await fixture();
  try {
    const initial = (await uncertain.journal.readHistory()).at(-1)!;
    const running = advanceInstallationPlanV1(initial, { expectedRevision: initial.revision, stage: "release_preflight", action: "start" });
    await uncertain.journal.append(running);
    await uncertain.journal.append(advanceInstallationPlanV1(running, { expectedRevision: running.revision,
      stage: "release_preflight", action: "uncertain", outcomeDigest: digest("lost-terminal-evidence") }));
    await assert.rejects(completeLocalInstallationPrerequisitesV1(uncertain.input, { journal: uncertain.journal }),
      /local_installation_prerequisite_transaction_refused/u);
  } finally { await uncertain.cleanup(); }
});

test("report mismatches or a changed concurrent plan are never normalized", async () => {
  const f = await fixture();
  try {
    await assert.rejects(completeLocalInstallationPrerequisitesV1({ ...f.input, privatePlacement: {
      ...f.input.privatePlacement, releaseManifestDigest: digest("wrong-manifest"),
    } }, { journal: f.journal }), /local_installation_prerequisite_transaction_refused/u);
    const initial = (await f.journal.readHistory()).at(-1)!;
    const changedTopology = createInstallationPlanV1({ topologyPlan: topology("other"), releaseDigest: f.releaseDigest,
      stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(`other:${stage}`)])) });
    assert.notEqual(changedTopology.planDigest, initial.planDigest);
    await assert.rejects(completeLocalInstallationPrerequisitesV1({ ...f.input, topologyPlan: topology("other") }, { journal: f.journal }),
      /local_installation_prerequisite_transaction_refused/u);
  } finally { await f.cleanup(); }
});

test("accepts the real fingerprinted preflight and distinct staged-release inventory through version linkage", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-prerequisite-producers-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const releaseDirectory = join(root, "release"), installRoot = join(root, "install"), journalRoot = join(root, "journal");
  await Promise.all([mkdir(installRoot, { mode: 0o700 }), mkdir(journalRoot, { mode: 0o700 })]);
  await assembleLocalReleaseV1({ releaseRoot: repository, outputDirectory: releaseDirectory });
  const placement = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot });
  const versionRoot = join(installRoot, "versions", placement.version);
  const preflight = await prepareLocalInstallationReleaseV1({ releaseRoot: versionRoot });
  const releaseDigest = await manifestDigest(join(versionRoot, "RELEASE_MANIFEST.json"));
  assert.equal(preflight.bundle.state, "fingerprinted");
  assert.equal(preflight.bundle.version, placement.version);
  assert.equal(preflight.releaseManifestDigest, releaseDigest);
  assert.equal(placement.releaseManifestDigest, releaseDigest);
  assert.notDeepEqual([preflight.bundle.fileCount, preflight.bundle.byteCount], [placement.fileCount, placement.byteCount]);

  const installationId = "local-installation-producers", journal = new InstallationPlanFilesystemJournalV1({
    rootDirectory: journalRoot, installationId, ownerUid: process.getuid!(),
  });
  const plan = createInstallationPlanV1({ topologyPlan: topology("producers"), releaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(`bootstrap:producers:${stage}`)])) });
  await journal.append(plan);
  await assert.rejects(completeLocalInstallationPrerequisitesV1({ installationId, topologyPlan: topology("producers"),
    releaseDigest: digest("unrelated-release-manifest"), releasePreflight: preflight, privatePlacement: placement }, { journal }),
  /local_installation_prerequisite_transaction_refused/u);
  const unrelatedInstallationId = "local-installation-unrelated", unrelatedReleaseDigest = digest("unrelated-release-manifest");
  const unrelatedJournal = new InstallationPlanFilesystemJournalV1({
    rootDirectory: journalRoot, installationId: unrelatedInstallationId, ownerUid: process.getuid!(),
  });
  await unrelatedJournal.append(createInstallationPlanV1({ topologyPlan: topology("producers"),
    releaseDigest: unrelatedReleaseDigest,
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage,
      digest(`bootstrap:unrelated:${stage}`)])) }));
  await assert.rejects(completeLocalInstallationPrerequisitesV1({ installationId: unrelatedInstallationId,
    topologyPlan: topology("producers"), releaseDigest: unrelatedReleaseDigest,
    releasePreflight: preflight, privatePlacement: placement }, { journal: unrelatedJournal }),
  /local_installation_prerequisite_transaction_refused/u);
  assert.equal((await unrelatedJournal.readHistory()).length, 1);
  const result = await completeLocalInstallationPrerequisitesV1({ installationId, topologyPlan: topology("producers"), releaseDigest,
    releasePreflight: preflight, privatePlacement: placement }, { journal });
  assert.equal(result.installationPlan.releaseDigest, releaseDigest);
  assert.equal(result.installationPlan.stages.find(item => item.stage === "database_authority")?.state, "not_started");
});

test("rereads the journal tip after append and refuses an interleaved later-plan refresh", async () => {
  const f = await fixture();
  try {
    let injected = false;
    const interleavedJournal = {
      async append(value: unknown) {
        const result = await f.journal.append(value);
        const plan = value as ReturnType<typeof createInstallationPlanV1>;
        if (!injected && plan.stages.find(item => item.stage === "private_placement")?.state === "passed") {
          injected = true;
          await f.journal.append(refreshInstallationPlanV1(plan, { topologyPlan: f.input.topologyPlan,
            releaseDigest: f.releaseDigest, stageInputDigests: Object.fromEntries(plan.stages.map(stage => [stage.stage,
              stage.stage === "protected_data" ? digest("interleaved-protected-data-input") : stage.inputDigest])) }));
        }
        return result;
      },
      readHistory: () => f.journal.readHistory(),
    };
    await assert.rejects(completeLocalInstallationPrerequisitesV1(f.input, { journal: interleavedJournal }),
      /local_installation_prerequisite_transaction_refused/u);
    assert.equal((await f.journal.readHistory()).at(-1)?.revision, 6);
  } finally { await f.cleanup(); }
});

test("refuses a changed prerequisite binding interleaved immediately after revision one", async () => {
  const f = await fixture();
  try {
    let injected = false;
    const interleavedJournal = {
      async append(value: unknown) {
        const result = await f.journal.append(value);
        const plan = value as ReturnType<typeof createInstallationPlanV1>;
        if (!injected && plan.revision === 1) {
          injected = true;
          await f.journal.append(refreshInstallationPlanV1(plan, { topologyPlan: f.input.topologyPlan,
            releaseDigest: f.releaseDigest, stageInputDigests: Object.fromEntries(plan.stages.map(stage => [stage.stage,
              stage.stage === "release_preflight" ? digest("interleaved-release-preflight-input") : stage.inputDigest])) }));
        }
        return result;
      },
      readHistory: () => f.journal.readHistory(),
    };
    await assert.rejects(completeLocalInstallationPrerequisitesV1(f.input, { journal: interleavedJournal }),
      /local_installation_prerequisite_transaction_refused/u);
    assert.equal((await f.journal.readHistory()).at(-1)?.revision, 2);
  } finally { await f.cleanup(); }
});
