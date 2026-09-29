import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

test("a concurrent writer's in-flight publication never refuses another exact writer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-inflight-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-inflight", ownerUid = process.getuid!();
  const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
  // The winner is held in linkNoReplace, which is the last step before its target
  // exists: its witness is already created, written, file-synced and
  // directory-synced, so the journal on disk is exactly "witness present, target
  // absent" - the live mid-publication state a concurrent writer really leaves
  // behind. Holding any earlier (create or write) would let the late writer read an
  // empty directory and would prove nothing.
  let atLink!: () => void;
  const winnerIsLinking = new Promise<void>(resolve => { atLink = resolve; });
  let releaseWinner!: () => void;
  const winnerMayFinish = new Promise<void>(resolve => { releaseWinner = resolve; });
  const winner = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base,
        async linkNoReplace(sourceName, sourceIdentity, targetName) {
          atLink(); await winnerMayFinish;
          return base.linkNoReplace(sourceName, sourceIdentity, targetName);
        },
      });
    });
  // The late writer is instrumented for observation only: listEntryNames returns
  // the real names and behaves identically, it just tells the test when its own
  // first directory listing has returned and what it saw. A refusal is reported
  // through the same latch, because a late writer that cannot even open a session
  // or list the directory never reaches the listing and would otherwise hang.
  type FirstListing = { kind: "names"; names: readonly string[] } | { kind: "refusal"; error: Error };
  let observedFirstListing!: (listing: FirstListing) => void;
  const firstListing = new Promise<FirstListing>(resolve => { observedFirstListing = resolve; });
  const reportRefusal = (error: unknown) => observedFirstListing({ kind: "refusal", error: error as Error });
  const late = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      try {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base,
          async listEntryNames() {
            try {
              const names = await base.listEntryNames();
              observedFirstListing({ kind: "names", names });
              return names;
            }
            catch (error) { reportRefusal(error); throw error; }
          },
        });
      } catch (error) { reportRefusal(error); throw error; }
    });
  const plan = create();
  // Held in outer scope so the finally block can settle both writers, but only
  // started at the points below: the late writer must not begin before the winner
  // is actually parked in linkNoReplace.
  let winnerResult!: ReturnType<typeof winner.append>;
  let lateResult!: Promise<{ result: Awaited<ReturnType<typeof late.append>> } | { error: Error }>;
  try {
    winnerResult = winner.append(plan);
    await winnerIsLinking;
    lateResult = late.append(plan).then(result => ({ result }), (error: Error) => ({ error }));
    // The whole point of the test: the late writer has to reach its own first
    // listing while the winner is still held, so it observes the in-flight witness
    // with no target. Releasing the winner first (as an earlier version of this
    // test did) means the late writer never sees that state and the fix is untested.
    // The runner has no per-test timeout, so this is bounded: a late writer that
    // never lists anything fails here instead of hanging the whole suite.
    const listingGuard = new AbortController();
    const listing = await Promise.race([firstListing,
      delay(10_000, undefined, { signal: listingGuard.signal })
        .then(() => ({ kind: "no-listing" } as const), () => ({ kind: "no-listing" } as const))]);
    listingGuard.abort();
    if (listing.kind !== "names") throw listing.kind === "refusal"
      ? listing.error : new Error("the late writer never reached its first directory listing");
    assert.ok(listing.names.includes(witnessName), "the late writer's first listing saw the live witness");
    assert.equal(listing.names.includes(name(installationId, 0)), false,
      "the late writer's first listing saw no target, so the publication was still in flight");
    releaseWinner();
    const [first, second] = [await winnerResult, await lateResult];
    const refusal = "error" in second ? second.error.message : "none";
    assert.ok(!("error" in second), `the late exact writer was refused instead of replayed: ${refusal}`);
    assert.equal(first.replayed, false, "the writer that linked the target is the publisher");
    assert.equal(second.result.replayed, true, "the late exact writer replays the winner's publication");
    assert.equal(first.planDigest, plan.planDigest);
    assert.equal(second.result.planDigest, plan.planDigest);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)],
      "the witness and both temps are retired, leaving only the published target");
    assert.equal((await lstat(join(root, name(installationId, 0)))).nlink, 1);
    assert.equal((await late.readHistory()).length, 1);
  } finally {
    // Both writers must be settled before the directory is removed, or a writer
    // still inside its publication can recreate entries underneath the rm and
    // leave the temp directory behind, replacing the real failure with ENOTEMPTY.
    releaseWinner();
    await Promise.all([winnerResult, lateResult].map(result => result.then(() => undefined, () => undefined)));
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only read still refuses a witness with no target and never repairs it", async () => {
  const f = await fixture();
  try {
    const plan = create();
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.66666666-6666-4666-8666-666666666666.tmp`;
    const witness = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
    await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(f.root, witness), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });
    const before = (await readdir(f.root)).sort();
    // A genuine crash in that window is indistinguishable from a live writer, so
    // the repairing read must still fail closed rather than wait it out forever.
    await assert.rejects(() => f.journal.readHistory(), /installation_plan_journal_unavailable/);
    await assert.rejects(() => f.journal.inspectSettledHistory(), /installation_plan_journal_unavailable/);
    assert.deepEqual((await readdir(f.root)).sort(), before, "a refused read must not repair or delete");
  } finally { await f.cleanup(); }
});

test("a recovery reader waits out a live publication instead of refusing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-waitout-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-waitout", ownerUid = process.getuid!();
  let atWitness!: () => void;
  const witnessCreated = new Promise<void>(resolve => { atWitness = resolve; });
  let releaseWinner!: () => void;
  const winnerMayFinish = new Promise<void>(resolve => { releaseWinner = resolve; });
  const winner = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base,
        async createExclusiveEntry(entryName: string) {
          const identity = await base.createExclusiveEntry(entryName);
          if (entryName.endsWith(".publish.json")) { atWitness(); await winnerMayFinish; }
          return identity;
        },
      });
    });
  // The reader must observe the witness *before* the winner links its target, so
  // it is held until the witness is actually on disk. Pausing at create time is
  // too early: the witness entry exists but the directory is still empty, and a
  // reader that arrives then correctly reads an empty journal.
  const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
  try {
    const plan = create();
    const winnerResult = winner.append(plan);
    await atWitness;
    const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    while (!(await readdir(root)).includes(witnessName)) await new Promise(resolve => { setTimeout(resolve, 1); });
    const reading = reader.readHistory();
    assert.ok((await readdir(root)).includes(witnessName), "the reader starts while the witness is live");
    releaseWinner();
    await winnerResult;
    const history = await reading;
    assert.equal(history.length, 1, "a live publication must be waited out, not refused");
    assert.equal(history[0]!.planDigest, plan.planDigest);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)]);
  } finally { releaseWinner(); await rm(root, { recursive: true, force: true }); }
});

test("two readers retiring one settled witness both succeed and retire it once", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-double-retire-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-double-retire", ownerUid = process.getuid!();
  try {
    const plan = create();
    // A settled revision that still carries its witness: exactly the state two
    // concurrent recoverers both observe and both try to retire.
    const target = join(root, name(installationId, 0));
    const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    await writeFile(target, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName: `${installationId}.installation-plan.revision-0000000000.77777777-7777-4777-8777-777777777777.tmp`,
      planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });

    // Hold the first reader just before it retires the witness, so the second
    // reader completes the retirement underneath it. Retiring a witness is
    // idempotent, so the loser of the unlink race must not be told it cannot.
    let observedSettled!: () => void;
    const sawSettledTarget = new Promise<void>(resolve => { observedSettled = resolve; });
    let resume!: () => void;
    const mayResume = new Promise<void>(resolve => { resume = resolve; });
    let held = false;
    const slow = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base,
          async statEntry(nameValue: string) {
            const entry = await base.statEntry(nameValue);
            // Hold on the temp lookup, which this reader performs only after
            // readWitness has returned the witness and before it retires it. That
            // is the exact window in which a peer can retire the witness first.
            if (!held && nameValue.endsWith(".tmp")) { held = true; observedSettled(); await mayResume; }
            return entry;
          },
        });
      });
    const peer = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
    const reading = slow.readHistory();
    await sawSettledTarget;
    assert.equal((await peer.readHistory()).length, 1, "the peer retires the witness first");
    assert.equal((await readdir(root)).includes(witnessName), false, "the peer retired the witness");
    resume();
    assert.equal((await reading).length, 1, "the loser of the witness unlink race must not be refused");
    assert.equal((await lstat(target)).nlink, 1);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)],
      "the temp and the witness are retired exactly once");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live writer's empty in-flight witness does not refuse a reader", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-empty-witness-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-empty-witness", ownerUid = process.getuid!();
  const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
  try {
    const plan = create();
    // A settled revision-0 target plus an EMPTY publication witness is the exact
    // shape readWitness must absorb: the storage session refuses an empty entry,
    // so without settling handling this read is a terminal refusal.
    await writeFile(join(root, name(installationId, 0)), `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(root, witnessName), "", { mode: 0o600, flag: "wx" });
    assert.equal((await lstat(join(root, witnessName))).size, 0, "the witness is empty");
    const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });

    // Fill the witness in, but only after the reader has already refused to read
    // the empty one, so the reader must have re-observed rather than failed.
    const started = performance.now();
    const reading = reader.readHistory();
    await delay(50);
    await writeFile(join(root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName: `${installationId}.installation-plan.revision-0000000000.99999999-9999-4999-8999-999999999999.tmp`,
      planDigest: plan.planDigest })}\n`, { mode: 0o600 });
    const history = await reading;
    assert.equal(history.length, 1, "an empty in-flight witness must be waited out, not refused");
    assert.equal(history[0]!.planDigest, plan.planDigest);
    assert.ok(performance.now() - started < 4_000, "the reader must not burn the whole settle window");
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stale two-linked observation of a journal another reader settled is accepted once", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-stale-observation-")));
  await chmod(root, 0o700);
  const installationId = "local-installation-stale", ownerUid = process.getuid!();
  const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
  try {
    const plan = create();
    const target = join(root, name(installationId, 0));
    const tempName = `${installationId}.installation-plan.revision-0000000000.88888888-8888-4888-8888-888888888888.tmp`;
    // Start in the two-linked, witness-present shape, then hold this reader at its
    // very first observation so a peer can complete the recovery underneath it.
    await writeFile(join(root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await link(join(root, tempName), target);
    await writeFile(join(root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });

    let observedTwoLinked!: () => void;
    const sawTwoLinks = new Promise<void>(resolve => { observedTwoLinked = resolve; });
    let resume!: () => void;
    const mayResume = new Promise<void>(resolve => { resume = resolve; });
    let held = false;
    const slowReader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base,
          async statEntry(nameValue: string) {
            const entry = await base.statEntry(nameValue);
            // Hold only the first two-linked observation of the target.
            if (!held && nameValue.endsWith(".json") && entry && entry.linkCount === 2) {
              held = true; observedTwoLinked(); await mayResume;
            }
            return entry;
          },
        });
      });
    const peer = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid });
    const reading = slowReader.readHistory();
    await sawTwoLinks;
    assert.equal((await peer.readHistory()).length, 1, "the peer completes the recovery");
    assert.equal((await lstat(target)).nlink, 1);
    assert.equal((await readdir(root)).includes(witnessName), false, "the peer retired the witness");
    resume();
    // The slow reader now holds a stale two-linked observation whose witness is
    // gone. The journal on disk is exactly what a clean settled journal looks
    // like, so this must not be refused.
    assert.equal((await reading).length, 1, "a stale observation of a settled journal must not refuse");
    assert.equal((await lstat(target)).nlink, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a terminal refusal is not waited out", async () => {
  const f = await fixture();
  try {
    // Every one of these is genuinely unusable and must refuse on the first
    // observation, never after the settle window. If a terminal refusal were
    // retried, these would each take seconds instead of milliseconds.
    const foreignRoot = new InstallationPlanFilesystemJournalV1({ rootDirectory: join(f.root, "missing"),
      installationId: "local-installation-two", ownerUid: process.getuid!() });
    const alias = join(f.root, "alias"); await symlink(f.root, alias);
    const aliased = new InstallationPlanFilesystemJournalV1({ rootDirectory: alias,
      installationId: "local-installation-two", ownerUid: process.getuid!() });

    for (const [label, read] of [
      ["a missing root", () => foreignRoot.readHistory()],
      ["a symlinked root", () => aliased.readHistory()],
      ["a digest mismatch", async () => {
        const plan = create(), target = join(f.root, name(f.installationId, 0));
        const wrong = advanceInstallationPlanV1(plan, { expectedRevision: 0, stage: "release_preflight", action: "start" });
        await writeFile(target, `${canonicalJson(wrong)}\n`, { mode: 0o600, flag: "wx" });
        return f.journal.readHistory();
      }],
    ] as const) {
      const started = performance.now();
      await assert.rejects(read, /installation_plan_journal_(unavailable|conflict)/, label);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1_000, `${label} must refuse immediately, not after a settle window (took ${elapsed.toFixed(0)}ms)`);
    }
  } finally { await rm(join(f.root, "alias"), { force: true }).catch(() => {}); await f.cleanup(); }
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
