import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1,
  refreshInstallationPlanV1 } from "../src/installer/v1/installation-plan";
import { canonicalJson, sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const topology = (suffix = "one") => planInstallationTopologyV1({ databaseAuthorityDigest: digest(`database:${suffix}`),
  schedulerAuthorityDigest: digest(`scheduler:${suffix}`),
  currentRoutes: [{ kind: "local", workerId: `worker:old:${suffix}`, adapterId: "connector:old", adapterRevision: "0000001" }],
  requestedRoutes: [{ kind: "local", workerId: `worker:new:${suffix}`, adapterId: "connector:new", adapterRevision: "0000001" }] });
const inputs = (suffix = "one") => Object.fromEntries(installationSetupStagesV1.map(stage => [stage, digest(`${suffix}:${stage}`)]));
const create = (suffix = "one") => createInstallationPlanV1({ topologyPlan: topology(suffix), releaseDigest: digest(`release:${suffix}`),
  stageInputDigests: inputs(suffix) });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-journal-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-one";
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid: process.getuid!() });
  return { root, installationId, journal, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const name = (installationId: string, revision: number) =>
  `${installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.json`;

test("append-only history persists exact revisions without exposing its private root", async () => {
  const f = await fixture();
  try {
    let plan = create();
    const initial = await f.journal.append(plan);
    assert.deepEqual(initial, { schema: "control-room.installation-plan-journal/v1", installationId: f.installationId,
      revision: 0, planDigest: plan.planDigest, replayed: false, enablesAuthority: false, startsService: false, startsWorker: false });
    assert.doesNotMatch(JSON.stringify(initial), new RegExp(f.root));
    plan = advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" });
    await f.journal.append(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("release-proof") });
    await f.journal.append(plan);
    const history = await f.journal.readHistory();
    assert.equal(history.length, 3); assert.equal(history[2]!.planDigest, plan.planDigest);
    for (const revision of [0, 1, 2]) {
      const entry = await lstat(join(f.root, name(f.installationId, revision)));
      assert.equal(entry.mode & 0o077, 0); assert.equal(entry.nlink, 1);
    }
  } finally { await f.cleanup(); }
});

test("exact sequential and concurrent replay succeeds while changed same-revision content conflicts", async () => {
  const f = await fixture();
  try {
    const plan = create();
    const [left, right] = await Promise.all([f.journal.append(plan), f.journal.append(plan)]);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    assert.equal((await f.journal.append(plan)).replayed, true);
    await assert.rejects(() => f.journal.append(create("changed")), /installation_plan_journal_conflict/);
    assert.equal((await f.journal.readHistory()).length, 1);
  } finally { await f.cleanup(); }
});

test("four exact writers repeatedly settle as one publication and clean replays", async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const f = await fixture();
    try {
      const plan = create();
      const results = await Promise.all(Array.from({ length: 4 }, () => f.journal.append(plan)));
      assert.equal(results.filter(result => !result.replayed).length, 1);
      assert.equal(results.filter(result => result.replayed).length, 3);
      assert.ok(results.every(result => result.planDigest === plan.planDigest));
      assert.deepEqual((await readdir(f.root)).sort(), [name(f.installationId, 0)]);
      assert.equal((await lstat(join(f.root, name(f.installationId, 0)))).nlink, 1);
    } finally { await f.cleanup(); }
  }
});

test("a crash temp is never read as proof and foreign files are left alone", async () => {
  const f = await fixture();
  try {
    const plan = create(), crash = `${f.installationId}.installation-plan.revision-0000000000.00000000-0000-4000-8000-000000000000.tmp`;
    await writeFile(join(f.root, crash), `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(f.root, "operator-note.txt"), "keep\n", { mode: 0o600, flag: "wx" });
    assert.deepEqual(await f.journal.readHistory(), []);
    await f.journal.append(plan);
    assert.ok((await readdir(f.root)).includes(crash), "the journal does not delete a foreign or prior-process temp");
    assert.ok((await readdir(f.root)).includes("operator-note.txt"));
  } finally { await f.cleanup(); }
});

test("a crash after no-replace publication retires only the matching published temp", async () => {
  const f = await fixture();
  try {
    const plan = create();
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.11111111-1111-4111-8111-111111111111.tmp`;
    const temp = join(f.root, tempName), target = join(f.root, name(f.installationId, 0));
    await writeFile(temp, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await link(temp, target);
    const witness = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
    await writeFile(join(f.root, witness), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(f.root, "operator-note.txt"), "keep\n", { mode: 0o600, flag: "wx" });
    const history = await f.journal.readHistory();
    assert.equal(history.length, 1); assert.equal(history[0]!.planDigest, plan.planDigest);
    assert.equal((await lstat(target)).nlink, 1);
    assert.equal((await readdir(f.root)).includes(tempName), false);
    assert.equal((await readdir(f.root)).includes(witness), false);
    assert.equal((await readdir(f.root)).includes("operator-note.txt"), true);
  } finally { await f.cleanup(); }
});

test("an unrelated UUID-shaped temp hardlink is preserved and never accepted", async () => {
  const f = await fixture();
  try {
    const plan = create(), target = join(f.root, name(f.installationId, 0));
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.22222222-2222-4222-8222-222222222222.tmp`;
    const temp = join(f.root, tempName);
    await writeFile(target, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await link(target, temp);
    await assert.rejects(() => f.journal.readHistory(), /installation_plan_journal_unavailable/);
    assert.equal((await readdir(f.root)).includes(tempName), true);
    assert.equal((await lstat(target)).nlink, 2);
  } finally { await f.cleanup(); }
});

test("a pre-publication witness cannot turn its temp into proof", async () => {
  const f = await fixture();
  try {
    const plan = create();
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.33333333-3333-4333-8333-333333333333.tmp`;
    await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(f.root, `${f.installationId}.installation-plan.revision-0000000000.publish.json`),
      `${canonicalJson({ schema: "control-room.installation-plan-publication/v1", revision: 0,
        tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });
    await assert.rejects(() => f.journal.readHistory(), /installation_plan_journal_unavailable/);
    assert.equal((await readdir(f.root)).includes(tempName), true);
    assert.equal((await readdir(f.root)).includes(`${f.installationId}.installation-plan.revision-0000000000.publish.json`), true);
  } finally { await f.cleanup(); }
});

test("contiguous legal refresh history is accepted", async () => {
  const f = await fixture();
  try {
    let plan = create(); await f.journal.append(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" }); await f.journal.append(plan);
    plan = advanceInstallationPlanV1(plan, { expectedRevision: 1, stage: "release_preflight", action: "pass", outcomeDigest: digest("proof") });
    await f.journal.append(plan);
    const refreshed = refreshInstallationPlanV1(plan, { topologyPlan: topology(), releaseDigest: digest("release:one"),
      stageInputDigests: { ...inputs(), private_placement: digest("changed-placement") } });
    await f.journal.append(refreshed);
    assert.equal((await f.journal.readHistory()).at(-1)!.planDigest, refreshed.planDigest);
  } finally { await f.cleanup(); }
});

test("gaps, illegal transitions, aliases and public roots fail closed", async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const first = create(), unrelated = advanceInstallationPlanV1(create("changed"), {
      expectedRevision: 0, stage: "release_preflight", action: "start" });
    await writeFile(join(f.root, name(f.installationId, 0)), `${canonicalJson(first)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(f.root, name(f.installationId, 1)), `${canonicalJson(unrelated)}\n`, { mode: 0o600, flag: "wx" });
    await assert.rejects(() => f.journal.readHistory(), /installation_plan_journal_conflict/);

    const missing = new InstallationPlanFilesystemJournalV1({ rootDirectory: join(other.root, "missing"),
      installationId: "local-installation-two", ownerUid: process.getuid!() });
    await assert.rejects(() => missing.readHistory(), /installation_plan_journal_unavailable/);
    const alias = join(other.root, "alias"); await symlink(f.root, alias);
    const linked = new InstallationPlanFilesystemJournalV1({ rootDirectory: alias,
      installationId: "local-installation-two", ownerUid: process.getuid!() });
    await assert.rejects(() => linked.readHistory(), /installation_plan_journal_unavailable/);
    await chmod(other.root, 0o755);
    await assert.rejects(() => other.journal.readHistory(), /installation_plan_journal_unavailable/);
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("a hard-linked or malformed owned revision cannot become accepted history", async () => {
  const f = await fixture();
  try {
    const plan = create(), target = join(f.root, name(f.installationId, 0));
    await writeFile(target, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await link(target, join(f.root, "foreign-hardlink"));
    await assert.rejects(() => f.journal.readHistory(), /installation_plan_journal_unavailable/);
  } finally { await f.cleanup(); }
});

test("read-only inspection accepts settled history without changing directory entries or inodes", async () => {
  const f = await fixture();
  try {
    const plan = create(); await f.journal.append(plan);
    const beforeNames = (await readdir(f.root)).sort();
    const before = await Promise.all(beforeNames.map(async entry => {
      const stat = await lstat(join(f.root, entry), { bigint: true });
      return [entry, stat.dev, stat.ino, stat.nlink, stat.size] as const;
    }));
    assert.equal((await f.journal.inspectSettledHistory()).length, 1);
    const afterNames = (await readdir(f.root)).sort();
    const after = await Promise.all(afterNames.map(async entry => {
      const stat = await lstat(join(f.root, entry), { bigint: true });
      return [entry, stat.dev, stat.ino, stat.nlink, stat.size] as const;
    }));
    assert.deepEqual(afterNames, beforeNames); assert.deepEqual(after, before);
  } finally { await f.cleanup(); }
});

test("read-only inspection refuses unsettled temp, witness, and hard-link states without repairing them", async () => {
  for (const kind of ["temp", "witness", "hardlink"] as const) {
    const f = await fixture();
    try {
      const plan = create(), target = join(f.root, name(f.installationId, 0));
      await writeFile(target, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
      if (kind === "temp") await writeFile(join(f.root,
        `${f.installationId}.installation-plan.revision-0000000000.44444444-4444-4444-8444-444444444444.tmp`),
        `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
      if (kind === "witness") await writeFile(join(f.root,
        `${f.installationId}.installation-plan.revision-0000000000.publish.json`), "{}\n", { mode: 0o600, flag: "wx" });
      if (kind === "hardlink") await link(target, join(f.root,
        `${f.installationId}.installation-plan.revision-0000000000.55555555-5555-4555-8555-555555555555.tmp`));
      const before = (await readdir(f.root)).sort();
      await assert.rejects(() => f.journal.inspectSettledHistory(), /installation_plan_journal_unavailable/);
      assert.deepEqual((await readdir(f.root)).sort(), before, `${kind} inspection must not repair or delete`);
    } finally { await f.cleanup(); }
  }
});
