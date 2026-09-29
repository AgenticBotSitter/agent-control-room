import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { openInstallationPlanFilesystemStorageSessionV1 } from
  "../src/installer/v1/installation-plan-journal-storage-session";
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

test("append retains one operation-scoped storage session through read, publication, verification, and close", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-session-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-session", events: string[] = [];
  let opens = 0;
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId,
    ownerUid: process.getuid!() }, async request => {
    opens += 1; events.push(`open:${request.operation}`);
    const base = await openInstallationPlanFilesystemStorageSessionV1(request);
    return Object.fromEntries(Object.entries(base).map(([property, value]) => [property,
      typeof value === "function" ? (...args: unknown[]) => {
        events.push(property); return Reflect.apply(value, base, args);
      } : value])) as typeof base;
  });
  try {
    await journal.append(create());
    assert.equal(opens, 1, "append must not recursively open a read-history session");
    assert.equal(events[0], "open:append"); assert.equal(events.at(-1), "close");
    assert.ok(events.indexOf("listEntryNames") < events.indexOf("createExclusiveEntry"));
    assert.ok(events.indexOf("writeExactBounded") < events.indexOf("syncFile"));
    assert.ok(events.indexOf("linkNoReplace") < events.lastIndexOf("readEntry"));
    assert.ok(events.lastIndexOf("readEntry") < events.lastIndexOf("verifyRoot"));
    assert.ok(events.lastIndexOf("verifyRoot") < events.indexOf("close"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("a late exact writer accepts recovery that already retired its own witness", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-late-witness-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-late-witness", ownerUid = process.getuid!();
  let releaseWitness!: () => void;
  const witnessReleased = new Promise<void>(resolve => { releaseWitness = resolve; });
  let witnessReached!: () => void;
  const atWitness = new Promise<void>(resolve => { witnessReached = resolve; });
  const late = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base,
        async createExclusiveEntry(entryName: string) {
          if (entryName.endsWith(".publish.json")) { witnessReached(); await witnessReleased; }
          return base.createExclusiveEntry(entryName);
        },
      });
    });
  const winner = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
  try {
    const plan = create();
    const lateResult = late.append(plan);
    await atWitness;
    const winnerResult = await winner.append(plan);
    releaseWitness();
    const recovered = await lateResult;
    assert.equal(winnerResult.replayed, false);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.planDigest, plan.planDigest);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)]);
    assert.equal((await lstat(join(root, name(installationId, 0)))).nlink, 1);
  } finally { releaseWitness(); await rm(root, { recursive: true, force: true }); }
});

test("a publisher whose witness name is taken by a concurrent writer still settles its publication", async () => {
  // This is the interleaving that made CI red, forced rather than waited for.
  //
  // The publication witness name is one slot per revision with no writer nonce.
  // So a publisher can be overtaken at the very end of its own append:
  //
  //   P wins the no-replace hard link for revision 0, syncs, removes its own
  //     temp, reads its plan back, and is descheduled just before retiring its
  //     witness. Its publication is already complete and proven.
  //   C, which started earlier and was itself descheduled after its history
  //     read, wakes and finds P's witness gone -- retired by Q's recovery -- so
  //     it creates a witness of its own for a revision that is ALREADY
  //     published, and is descheduled again holding it.
  //   P resumes and calls unlinkExact(witnessIdentity = P). The entry under that
  //     name is now C's, not P's.
  //
  // P's own artifact is already retired, the publication is already durable, and
  // C's witness is another writer's evidence. P used to fail closed here with
  // `installation_plan_journal_unavailable`, turning a successful publication
  // into a hard error. It must instead leave the foreign entry untouched and
  // return its result, so the revision converges.
  //
  // Each gate is placed on the real storage session, and each asserts the state
  // it depends on, so this cannot pass by accident: C is only released once the
  // witness is provably absent, and P is only released once C's witness is
  // provably present.
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-overtaken-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-overtaken", ownerUid = process.getuid!();

  /** A one-shot gate: `reached` fires when the code passes it, `release` opens it. */
  function gate(label: string) {
    let reached!: () => void, release!: () => void;
    const reachedRaw = new Promise<void>(r => { reached = r; });
    const openedRaw = new Promise<void>(r => { release = r; });
    // A stalled gate is a test bug, and a hang reports nothing about it. Fail
    // with the gate's name instead. The timer is deliberately NOT unref'd: it
    // has to keep the event loop alive long enough to fire, otherwise node
    // reports an unnamed "promise still pending" and says nothing about where.
    // `Promise.race` on the SAME promise every time, so awaiting the raced
    // wrapper twice still waits on the single underlying resolution.
    const withDeadline = (promise: Promise<void>) => Promise.race([promise,
      new Promise<void>((_, reject) => { setTimeout(() => reject(new Error(`gate ${label} never completed`)), 5_000); })]);
    return { reached: withDeadline(reachedRaw), opened: withDeadline(openedRaw), reachedNow: reached, release };
  }
  const pAtRetire = gate("P-retire"), cAtClaim = gate("C-claim"), cHoldsWitness = gate("C-live");
  let pLinked = false, pGated = false, cPastClaim = false;
  // P's own witness identity, captured when P creates it, so the retirement
  // gate can distinguish P's own final retirement from any recovery unlink.
  let pWitness: { device: bigint; inode: bigint } | undefined;
  // C's own witness identity, for the same reason from the other side: the
  // "left strictly alone" claim below is about THIS file, and the only way to
  // say which file that is, by the only other writer in this test.
  let cWitness: { device: bigint; inode: bigint } | undefined;

  /** P is the publisher. Gated on its own final witness retirement. */
  const publisher = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base,
        async createExclusiveEntry(name: string) {
          const identity = await base.createExclusiveEntry(name);
          if (name.endsWith(".publish.json")) pWitness = identity;
          return identity;
        },
        async linkNoReplace(...args: unknown[]) {
          const result = await base.linkNoReplace(...(args as [string, never, string]));
          pLinked = true;
          return result;
        },
        async unlinkExact(name: string, identity: { device: bigint; inode: bigint }, allowMissing?: boolean) {
          // Only the retirement that follows this writer's own successful
          // publication. Gated on the captured witness identity as well as
          // `pLinked`, because the same journal instance performs recovery
          // unlinks for revisions it did not publish, and freezing inside one
          // of those would deadlock every other writer.
          if (name.endsWith(".publish.json") && pLinked && !pGated && pWitness
            && identity.device === pWitness.device && identity.inode === pWitness.inode) {
            pGated = true;
            assert.ok(await base.statEntry(name),
              "P must still own its witness at this point, or this test is not the intended interleaving");
            pAtRetire.reachedNow();
            await pAtRetire.opened;
          }
          return base.unlinkExact(name, identity, allowMissing);
        },
      });
    });

  /** C is overtaken, then claims the freed slot for an already published revision. */
  const claimer = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base,
        async createExclusiveEntry(name: string) {
          const isWitness = name.endsWith(".publish.json");
          if (isWitness && !cPastClaim) {
            assert.equal(await base.statEntry(name), undefined,
              "C must find the witness slot already freed, or it cannot demonstrate a second generation");
            cPastClaim = true;
            cAtClaim.reachedNow();
            await cAtClaim.opened;
          }
          const identity = await base.createExclusiveEntry(name);
          // Once past the gate, hold the newly created witness live so it is
          // still present when P resumes and looks for its own.
          if (isWitness && cPastClaim) {
            cWitness = identity;
            cHoldsWitness.reachedNow();
            await cHoldsWitness.opened;
          }
          return identity;
        },
      });
    });

  // Q publishes nothing new; it simply loses the link race and its recovery
  // retires P's witness, which is what frees the slot for C.
  const other = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });

  try {
    const plan = create();
    // C starts first and pauses at its witness claim, so it is provably past
    // its own history read before anything exists. It holds no witness yet, so
    // it blocks nothing that follows.
    const claimerAppend = claimer.append(plan);
    await cAtClaim.reached;
    // P publishes revision 0 and is frozen at its final witness retirement. It
    // is frozen INSIDE the storage session it owns, holding only its own open
    // descriptors, so Q can still open an independent session and recover.
    const published = publisher.append(plan);
    await pAtRetire.reached;
    // Q loses the link race; its recovery retires P's witness, freeing the slot.
    // P is still frozen, so the witness P owned is definitely the one retired.
    const recovered = await other.append(plan);
    assert.equal(recovered.replayed, true);
    assert.equal(await entryExists(root, `${installationId}.installation-plan.revision-0000000000.publish.json`),
      false, "Q's recovery must retire P's witness for the slot to become free");
    // Release C: it claims the freed slot. C then holds a live witness for an
    // already published revision and STAYS frozen there, so the foreign witness
    // is provably present at the moment P looks for its own. C is released at
    // the very end, after P has resumed.
    cAtClaim.release();
    await cHoldsWitness.reached;
    assert.ok(await entryExists(root, `${installationId}.installation-plan.revision-0000000000.json`),
      "the published target must still be present before P resumes");
    assert.ok(await entryExists(root, `${installationId}.installation-plan.revision-0000000000.publish.json`),
      "C must now hold a live witness under the name P is about to retire");
    // Release P. P's own witness is gone and a foreign one is under its name.
    pAtRetire.release();

    const settled = await published;
    assert.equal(settled.replayed, false,
      "a publisher whose witness slot was reused must still report its own publication, not fail");
    assert.equal(settled.planDigest, plan.planDigest);
    assert.equal(settled.revision, 0);

    // THE ASSERTION THIS TEST WAS MISSING. The comment on
    // `unlinkExact(name, identity, allowMissing = true)` in
    // src/installer/v1/installation-plan-journal-storage-session.ts claims the
    // foreign entry "is left strictly alone … removing it would destroy evidence
    // belonging to another writer". Nothing proved that: replacing the early
    // return with an unlink of the foreign entry left this file green, because
    // the only later check is the final `readdir`, which happens *after* C is
    // released and after recovery has legitimately retired the witness anyway
    // — so the two outcomes are indistinguishable from there.
    //
    // This is the earliest point where the difference is observable, and the
    // only one that names a writer: C is still frozen holding its witness, so
    // the file on disk can only be C's. Reading it back by device and inode is
    // what makes the claim falsifiable — a file another writer recreated under
    // the same name has a different inode, and `unlinkExact` only treats an
    // entry as its own when the identity matches.
    const foreignWitness = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    assert.ok(cWitness, "C must have created a witness, or this test is not the intended interleaving");
    assert.deepEqual(await entryIdentity(root, foreignWitness), cWitness,
      "P must leave C's live witness strictly alone: it is another writer's evidence, and only a later recovery read may retire it");

    // Now let C finish, and let recovery converge the journal.
    cHoldsWitness.release();
    await claimerAppend;
    // The published revision is intact and the journal reads back as one clean
    // revision. C's witness is retired by recovery on this read rather than by
    // P removing another writer's entry.
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
    const history = await journal.readHistory();
    assert.equal(history.length, 1, "the journal converges to exactly the one published revision");
    assert.equal(history[0]!.planDigest, plan.planDigest);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)],
      "no witness and no temp may survive the convergence");
  } finally {
    pAtRetire.release(); cAtClaim.release(); cHoldsWitness.release();
    await rm(root, { recursive: true, force: true });
  }
});

/** Whether `entryName` currently exists in `root`, read straight off disk. */
async function entryExists(root: string, entryName: string): Promise<boolean> {
  try { await lstat(join(root, entryName)); return true; }
  catch { return false; }
}

/**
 * The device and inode of `entryName` in `root`, read straight off disk, or
 * `undefined` when it is absent. Compared by identity rather than by name
 * because a name is not an identity: the whole point of the assertion using
 * this is that a *differently owned* file can sit under a name a writer is
 * about to retire, so a name comparison would pass for exactly the wrong
 * reason.
 */
async function entryIdentity(root: string, entryName: string): Promise<{ device: bigint; inode: bigint } | undefined> {
  try {
    const entry = await lstat(join(root, entryName), { bigint: true });
    return { device: entry.dev, inode: entry.ino };
  } catch { return undefined; }
}

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
