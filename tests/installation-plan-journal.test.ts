import assert from "node:assert/strict";
import { chmod, link, lstat, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { openInstallationPlanFilesystemStorageSessionV1, type InstallationPlanJournalEntryV1 } from
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

test("an exact writer retries witness metadata whose canonical lookup lost a retirement race",
  { timeout: 15_000 }, async t => {
    for (const variant of ["retired", "present", "unsafe-retired"] as const) await t.test(variant, async () => {
      const f = await fixture();
      try {
        const plan = create(), tempName = `${f.installationId}.installation-plan.revision-0000000000.88888888-8888-4888-8888-888888888888.tmp`;
        const witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
        await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600 });
        await link(join(f.root, tempName), join(f.root, name(f.installationId, 0)));
        await writeFile(join(f.root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
          revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600 });
        let observed = false;
        const late = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
          ownerUid: process.getuid!() }, async request => {
          const base = await openInstallationPlanFilesystemStorageSessionV1(request);
          return Object.freeze({ ...base, async statEntry(entryName: string) {
            const entry = await base.statEntry(entryName);
            if (!observed && entryName === witnessName && entry) {
              observed = true;
              if (variant !== "present") await f.journal.readHistory();
              // lstat succeeded before retirement; realpath completed after it.
              return Object.freeze({ ...entry, canonical: false,
                ...(variant === "unsafe-retired" ? { mode: 0o644 } : {}) });
            }
            return entry;
          } });
        });
        if (variant === "retired") {
          assert.equal((await late.append(plan)).replayed, true);
          assert.deepEqual(await readdir(f.root), [name(f.installationId, 0)]);
        } else {
          const before = performance.now();
          await assert.rejects(late.append(plan), /installation_plan_journal_unavailable/);
          assert.ok(performance.now() - before < 1_000, "unsafe or still-present witnesses refuse immediately");
        }
        assert.equal(observed, true, "the witness metadata race was exercised");
      } finally { await f.cleanup(); }
    });
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
        async linkNoReplace(...args: Parameters<typeof base.linkNoReplace>) {
          atWitness(); await winnerMayFinish;
          return base.linkNoReplace(...args);
        },
      });
    });
  let observed!: () => void;
  const readerListed = new Promise<void>(resolve => { observed = resolve; });
  const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
    async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base, async listEntryNames() {
        const names = await base.listEntryNames(); observed(); return names;
      } });
    });
  let winnerResult: ReturnType<typeof winner.append> | undefined;
  let reading: ReturnType<typeof reader.readHistory> | undefined;
  try {
    const plan = create();
    winnerResult = winner.append(plan);
    await witnessCreated;
    const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    while (!(await readdir(root)).includes(witnessName)) await new Promise(resolve => { setTimeout(resolve, 1); });
    reading = reader.readHistory(); reading.catch(() => {});
    await readerListed;
    assert.ok((await readdir(root)).includes(witnessName), "the reader starts while the witness is live");
    releaseWinner();
    await winnerResult;
    const history = await reading;
    assert.equal(history.length, 1, "a live publication must be waited out, not refused");
    assert.equal(history[0]!.planDigest, plan.planDigest);
    assert.deepEqual((await readdir(root)).sort(), [name(installationId, 0)]);
  } finally {
    releaseWinner(); await Promise.allSettled([winnerResult, reading]);
    await rm(root, { recursive: true, force: true });
  }
});

test("recovery retries a temp metadata read completed after the writer unlinks its alias", { timeout: 30_000 }, async t => {
  const variants = ["good", "removed-alias", "temp-link-count", "temp-mode", "temp-device", "temp-inode",
    "current-mode", "current-device", "current-inode", "current-missing", "temp-present"];
  for (const variant of variants) await t.test(variant, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-metadata-race-")));
    await chmod(root, 0o700);
    const installationId = "local-installation-metadata-race", ownerUid = process.getuid!();
    let atWitness!: () => void, releaseWriter!: () => void;
    const ready = new Promise<void>(resolve => { atWitness = resolve; });
    const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
    const writer = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base, async linkNoReplace(...args: Parameters<typeof base.linkNoReplace>) {
          const result = await base.linkNoReplace(...args); atWitness(); await gate; return result;
        } });
      });
    let publishing: ReturnType<typeof writer.append> | undefined;
    let observed = false;
    let savedEntry: InstallationPlanJournalEntryV1 | undefined;
    const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base, async statEntry(entryName: string) {
          const entry = await base.statEntry(entryName);
          if (!observed && entryName.endsWith(".tmp") && entry?.linkCount === 2) {
            observed = true;
            // Complete the metadata observation of the opened inode after unlink.
            // Preserve its identity, permissions and size from the real session.
            releaseWriter(); await publishing;
            savedEntry = Object.freeze({ ...entry, linkCount: (await lstat(join(root, name(installationId, 0)))).nlink });
            return Object.freeze({ ...savedEntry,
              ...(variant === "temp-mode" ? { mode: 0o644 } : {}),
              ...(variant === "removed-alias" ? { canonical: false, linkCount: 2 } : {}),
              ...(variant === "temp-link-count" ? { linkCount: 3 } : {}),
              identity: { ...entry.identity,
                ...(variant === "temp-device" ? { device: entry.identity.device + BigInt(1) } : {}),
                ...(variant === "temp-inode" ? { inode: entry.identity.inode + BigInt(1) } : {}) } });
          }
          if (observed && entryName.endsWith(".tmp") && variant === "temp-present") return savedEntry;
          if (observed && entryName === name(installationId, 0) && variant === "current-missing") return undefined;
          if (observed && entryName === name(installationId, 0) && entry) return Object.freeze({ ...entry,
            ...(variant === "current-mode" ? { mode: 0o644 } : {}),
            identity: { ...entry.identity,
              ...(variant === "current-device" ? { device: entry.identity.device + BigInt(1) } : {}),
              ...(variant === "current-inode" ? { inode: entry.identity.inode + BigInt(1) } : {}) } });
          return entry;
        } });
      });
    try {
      const plan = create(); publishing = writer.append(plan); await ready;
      // The hard link is present and the writer is held until the reader observes its temp.
      if (variant === "good" || variant === "removed-alias") {
        const histories = await Promise.all(Array.from({ length: 50 }, () => reader.readHistory()));
        for (const history of histories) {
          assert.equal(history.length, 1);
          assert.equal(history[0]!.planDigest, plan.planDigest);
        }
      } else await assert.rejects(reader.readHistory(), /installation_plan_journal_unavailable/);
      await publishing;
      assert.equal(observed, true);
    } finally {
      releaseWriter(); await Promise.allSettled([publishing]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("recovery refuses a substituted temp or target inside the unlink-alias retry window", { timeout: 30_000 }, async t => {
  // The committed retry test proves the guard reads the right METADATA, but it
  // returns the reader's entries directly. These cases pin the REASON the guard is
  // safe, against a real filesystem: the retry admits a temp only when its inode
  // equals the inode the reader had already captured from the target, and it
  // re-reads both names afterwards. So a substituted file cannot win.
  //
  // Every variant reaches the real window. That requires the target to have
  // nlink === 2 (the writer's hard link still present), otherwise the reader takes
  // the settled-target branch at line 185 and never sees the retry at all -- an
  // earlier draft of this test made exactly that mistake and "passed" without ever
  // executing the guard.
  const variants = [
    // The alias is unlinked and a foreign private file takes its place: identical
    // in owner, mode and size, differing only in identity.
    "foreign-temp-file",
    // The alias is replaced by a hard link to a second private file, so
    // linkCount and mode are genuine too and only the inode still differs.
    "foreign-temp-hardlink",
    // The target itself is swapped. The temp still matches the ORIGINAL target
    // snapshot, so only the fresh-target identity re-read can catch this.
    "foreign-target-file",
    // The target is truncated in place: same inode, so no identity check can see
    // it and only the size read catches it.
    "truncated-target",
  ] as const;
  for (const variant of variants) await t.test(variant, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-substitution-")));
    await chmod(root, 0o700);
    const installationId = "local-installation-substitution", ownerUid = process.getuid!();
    const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    const targetPath = join(root, name(installationId, 0));
    const tempName = `${installationId}.installation-plan.revision-0000000000.77777777-7777-4777-8777-777777777777.tmp`;
    const tempPath = join(root, tempName);
    const plan = create();
    await writeFile(targetPath, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    // The writer's hard link: target and temp are one inode, so the reader is in
    // the publishing window rather than the settled one.
    await link(targetPath, tempPath);
    await writeFile(join(root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });
    assert.equal((await lstat(targetPath)).nlink, 2, "the reader must start inside the publication window");

    const targetBefore = await lstat(targetPath, { bigint: true });
    let interposed = false;
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base, async statEntry(entryName: string) {
          if (!interposed && entryName === tempName) {
            interposed = true;
            // Reproduce the production race with real syscalls: lstat the alias,
            // then let the writer unlink it, then fail the canonical lookup
            // because the name is gone. This is exactly the interleaving the guard
            // was written for, and the entry handed back is the pre-unlink one.
            const opened = await lstat(tempPath, { bigint: true });
            await rm(tempPath);
            const canonical = await realpath(tempPath).then(value => value === tempPath).catch(() => false);
            if (variant === "foreign-temp-file") await writeFile(tempPath, `${canonicalJson(plan)}\n`, { mode: 0o600 });
            if (variant === "foreign-temp-hardlink") {
              const attacker = join(root, "attacker-private-plan.json");
              await writeFile(attacker, `${canonicalJson(create("attacker"))}\n`, { mode: 0o600 });
              await link(attacker, tempPath);
            }
            if (variant === "foreign-target-file") {
              // Allocate while the original still exists: ext4 must not reuse it.
              const replacement = join(root, "substituted-plan.json");
              await writeFile(replacement, `${canonicalJson(create("attacker"))}\n`, { mode: 0o600, flag: "wx" });
              await rm(targetPath);
              await rename(replacement, targetPath);
            }
            if (variant === "truncated-target") await writeFile(targetPath, "", { mode: 0o600 });
            return Object.freeze({ identity: { device: opened.dev, inode: opened.ino },
              kind: "file" as const, ownerUid: Number(opened.uid), mode: Number(opened.mode & BigInt(0o7777)),
              linkCount: Number(opened.nlink), size: Number(opened.size), canonical });
          }
          return base.statEntry(entryName);
        } });
      });
    try {
      // The refusal is the load-bearing claim: the substituted file must never be
      // read as the published plan, so readHistory rejects rather than resolving.
      await assert.rejects(journal.readHistory(), /installation_plan_journal_unavailable/,
        "a substituted file inside the retry window must be refused, not read");
      assert.equal(interposed, true, "the interposition fired");
      // Prove each variant really changed what it claims to change, so a passing
      // rejection cannot be an accident of a substitution that never happened.
      const targetAfter = await lstat(targetPath, { bigint: true });
      if (variant === "foreign-target-file") {
        assert.notEqual(targetAfter.ino, targetBefore.ino, "the target inode really changed");
      } else {
        assert.equal(targetAfter.ino, targetBefore.ino, "these variants substitute the temp, not the target");
      }
      if (variant === "truncated-target") assert.equal(targetAfter.size, BigInt(0), "the target really was truncated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// The m-mutpg review (report §5) asked for one more test: a variant where the
// temp alias is substituted by a FOREIGN file AND the reader then re-stats the
// target as the same inode -- the case the inode-equality predicate is actually
// written for. m-mutpg's four variants hand back the PRE-unlink lstat, so the
// temp always carries the target's real inode and the guard's identity comparison
// never decides anything; their refusals all come from the later `unlinkExact`.
// That is real coverage of the window, but it does not isolate the predicate, and
// this test does.
//
// It isolates it by the only honest means available: the substituted temp is
// given EVERY property the guard checks EXCEPT the one it is testing. Owner,
// mode, size and link count are the genuine values read from the real filesystem
// after substitution; the witness's planDigest, the target inode and the target
// bytes are untouched, so the ONLY reason to refuse is the inode comparison at
// installation-plan-journal.ts:223-224. A guard that dropped that comparison
// would accept this, and the surrounding `unlinkExact` then refuses on a real
// filesystem -- which is the point: the predicate fires first, and dropping it is
// visible as a different failure rather than as a pass.
test("the unlink-alias retry refuses a substituted temp whose only wrong property is its inode",
  { timeout: 30_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-plan-temp-inode-")));
    await chmod(root, 0o700);
    const installationId = "local-installation-temp-inode", ownerUid = process.getuid!();
    const witnessName = `${installationId}.installation-plan.revision-0000000000.publish.json`;
    const targetName = name(installationId, 0);
    const targetPath = join(root, targetName);
    const tempName = `${installationId}.installation-plan.revision-0000000000.99999999-9999-4999-8999-999999999999.tmp`;
    const tempPath = join(root, tempName);
    const plan = create();
    await writeFile(targetPath, `${canonicalJson(plan)}\n`, { mode: 0o600, flag: "wx" });
    await link(targetPath, tempPath);
    await writeFile(join(root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
      revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600, flag: "wx" });
    // The publication window: target nlink 2, or the reader settles early and
    // never reaches the retry (an earlier draft made exactly this mistake).
    assert.equal((await lstat(targetPath)).nlink, 2, "the reader must start inside the publication window");

    const targetBefore = await lstat(targetPath, { bigint: true });
    const foreign = join(root, "foreign-private-plan.json");
    await writeFile(foreign, `${canonicalJson(create("foreign"))}\n`, { mode: 0o600, flag: "wx" });
    let interposed = false, unlinked: string | undefined;
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base, async statEntry(entryName: string) {
          if (!interposed && entryName === tempName) {
            interposed = true;
            const live = await base.statEntry(tempName);
            if (!live) throw new Error("the live temp must exist to be substituted");
            // Substitute the alias with a hard link to a genuinely foreign private
            // file, then report metadata read from that substituted name AFTER the
            // substitution: owner, mode, size and link count are all REAL values
            // for the file now at tempPath. Only the inode is not the target's.
            await rm(tempPath);
            await link(foreign, tempPath);
            const substituted = await base.statEntry(tempName);
            if (!substituted) throw new Error("the substituted temp must be statable");
            assert.notEqual(substituted.identity.inode, live.identity.inode,
              "the substitution must really have produced a different inode");
            // Report the substituted file's REAL identity, so nothing about the
            // returned entry is a lie except its relationship to the target.
            return substituted;
          }
          // The target is re-stat'd by the guard and must come back unchanged: the
          // same inode, the genuine private file. So the target cannot be blamed
          // for the refusal.
          return base.statEntry(entryName);
        }, async unlinkExact(entryName: string, identityArgument, allowMissing?: boolean) {
          unlinked = entryName;
          return base.unlinkExact(entryName, identityArgument, allowMissing);
        } });
      });
    try {
      // Every predicate except inode-equality holds, so the refusal can only be
      // the identity comparison at lines 223-224.
      await assert.rejects(journal.readHistory(), /installation_plan_journal_unavailable/,
        "a substituted temp must be refused even when only its inode is wrong");
      assert.equal(interposed, true, "the interposition fired");
      assert.equal(unlinked, undefined,
        "the guard must refuse at the identity comparison, before it unlinks the alias");
      // And the reason is pinned: the target is byte-identical and same-inode, so
      // the only thing that changed anywhere is the temp's identity.
      const targetAfter = await lstat(targetPath, { bigint: true });
      assert.equal(targetAfter.ino, targetBefore.ino, "the target inode is unchanged");
      assert.equal(targetAfter.size, targetBefore.size, "the target size is unchanged");
      assert.equal((await lstat(tempPath, { bigint: true })).ino, (await lstat(foreign, { bigint: true })).ino,
        "the temp really is the foreign file now");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    let observedRetry!: () => void, sawEmpty = false, listings = 0;
    const sawRetry = new Promise<void>(resolve => { observedRetry = resolve; });
    const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: root, installationId, ownerUid },
      async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base,
          async listEntryNames() {
            const names = await base.listEntryNames();
            if (++listings > 1 && sawEmpty) observedRetry();
            return names;
          },
          async statEntry(entryName: string) {
            const entry = await base.statEntry(entryName);
            if (entryName === witnessName && entry?.size === 0) sawEmpty = true;
            return entry;
          },
        });
      });

    // Fill the witness in, but only after the reader has already refused to read
    // the empty one, so the reader must have re-observed rather than failed.
    const started = performance.now();
    const reading = reader.readHistory(); reading.catch(() => {});
    await Promise.race([sawRetry, reading.then(() => assert.fail("the empty witness was accepted before publication"))]);
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

test("fifty concurrent exact writers publish once and replay without leaving artifacts", async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = await fixture();
    try {
      const plan = create();
      const results = await Promise.all(Array.from({ length: 50 }, () => f.journal.append(plan)));
      assert.equal(results.filter(result => !result.replayed).length, 1);
      assert.equal(results.filter(result => result.replayed).length, 49);
      assert.ok(results.every(result => result.planDigest === plan.planDigest));
      assert.deepEqual((await readdir(f.root)).sort(), [name(f.installationId, 0)]);
      assert.equal((await lstat(join(f.root, name(f.installationId, 0)))).nlink, 1);
    } finally { await f.cleanup(); }
  }
});

for (const phase of ["witness-read", "temp-lookup"] as const) {
  test(`a recovery peer can retire the publication during ${phase}`, async () => {
    const f = await fixture();
    try {
      const plan = create(), tempName = `${f.installationId}.installation-plan.revision-0000000000.88888888-8888-4888-8888-888888888888.tmp`;
      const witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
      await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600 });
      await link(join(f.root, tempName), join(f.root, name(f.installationId, 0)));
      await writeFile(join(f.root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
        revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600 });
      let recovered = false;
      const slow = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
        ownerUid: process.getuid!() }, async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        const recover = async () => {
          recovered = true;
          assert.equal((await f.journal.readHistory()).length, 1);
          assert.equal((await lstat(join(f.root, name(f.installationId, 0)))).nlink, 1);
        };
        return Object.freeze({ ...base,
          async readEntry(entryName: string, maximumBytes: number) {
            if (phase === "witness-read" && entryName === witnessName && !recovered) await recover();
            return base.readEntry(entryName, maximumBytes);
          },
          async statEntry(entryName: string) {
            if (phase === "temp-lookup" && entryName === tempName && !recovered) await recover();
            return base.statEntry(entryName);
          },
        });
      });
      assert.equal((await slow.readHistory())[0]!.planDigest, plan.planDigest);
      assert.equal(recovered, true);
      assert.deepEqual((await readdir(f.root)).sort(), [name(f.installationId, 0)]);
    } finally { await f.cleanup(); }
  });
}

test("an interrupted settle preserves crash evidence and a clean retry can publish", async () => {
  const f = await fixture();
  try {
    const plan = create(), witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
    await writeFile(join(f.root, witnessName), "", { mode: 0o600 });
    const controller = new AbortController();
    let observed!: () => void;
    const sawWitness = new Promise<void>(resolve => { observed = resolve; });
    const reader = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
      ownerUid: process.getuid!() }, async request => {
      const base = await openInstallationPlanFilesystemStorageSessionV1(request);
      return Object.freeze({ ...base, async statEntry(entryName: string) {
        const entry = await base.statEntry(entryName);
        if (entryName === witnessName && entry?.size === 0) observed();
        return entry;
      } });
    });
    const reading = reader.readHistory(controller.signal);
    const refused = assert.rejects(reading, error => error === controller.signal.reason
      || error instanceof Error && error.name === "AbortError" && error.cause === controller.signal.reason);
    await sawWitness;
    controller.abort(new Error("triage_stop"));
    await refused;
    assert.equal((await lstat(join(f.root, witnessName))).size, 0);
    await rm(join(f.root, witnessName));
    assert.equal((await f.journal.append(plan)).replayed, false);
    assert.equal((await f.journal.readHistory())[0]!.planDigest, plan.planDigest);
  } finally { await f.cleanup(); }
});

test("a crashed empty witness refuses within the settle deadline without deleting evidence", { timeout: 8_000 }, async t => {
  const f = await fixture();
  try {
    const witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
    await writeFile(join(f.root, witnessName), "", { mode: 0o600 });
    const started = performance.now();
    await assert.rejects(f.journal.readHistory(t.signal), /installation_plan_journal_unavailable/);
    assert.ok(performance.now() - started < 7_000);
    assert.deepEqual(await readdir(f.root), [witnessName]);
    assert.equal((await lstat(join(f.root, witnessName))).size, 0);
  } finally { await f.cleanup(); }
});

test("an empty witness with unsafe permissions refuses immediately", async () => {
  const f = await fixture();
  try {
    const witness = join(f.root, `${f.installationId}.installation-plan.revision-0000000000.publish.json`);
    await writeFile(witness, "", { mode: 0o600 }); await chmod(witness, 0o644);
    const started = performance.now();
    await assert.rejects(f.journal.readHistory(), /installation_plan_journal_unavailable/);
    assert.ok(performance.now() - started < 1_000);
    assert.equal((await lstat(witness)).size, 0);
  } finally { await f.cleanup(); }
});

for (const phase of ["missing-witness", "missing-temp", "unlink-alias", "witness-metadata", "witness-read"] as const) {
  for (const replacement of ["inode", "device", "reused-inode"] as const) {
    test(`a ${phase} recovery refuses a changed target ${replacement}`, async () => {
      const f = await fixture();
      try {
        const plan = create(), targetName = name(f.installationId, 0);
        const tempName = `${f.installationId}.installation-plan.revision-0000000000.88888888-8888-4888-8888-888888888888.tmp`;
        const witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
        await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600 });
        await link(join(f.root, tempName), join(f.root, targetName));
        await writeFile(join(f.root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
          revision: 0, tempName, planDigest: plan.planDigest })}\n`, { mode: 0o600 });
        const originalIdentity = await entryIdentity(f.root, targetName);
        assert.ok(originalIdentity);
        let recovered = false;
        const recoverAndReplace = async () => {
          recovered = true;
          await f.journal.readHistory();
          if (replacement !== "device") {
            const substitute = join(f.root, "substituted-plan.json");
            await writeFile(substitute, `${canonicalJson(create("substituted"))}\n`, { mode: 0o600, flag: "wx" });
            await rm(join(f.root, targetName));
            await rename(substitute, join(f.root, targetName));
            assert.notEqual((await lstat(join(f.root, targetName), { bigint: true })).ino, originalIdentity.inode,
              "the replacement was allocated before freeing the original inode");
          }
        };
        const slow = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
          ownerUid: process.getuid!() }, async request => {
          const base = await openInstallationPlanFilesystemStorageSessionV1(request);
          return Object.freeze({ ...base, async statEntry(entryName: string) {
            const entry = await base.statEntry(entryName);
            // Keep the original changed-inode/device race at the first target
            // snapshot. Reuse probes retire the witness after content is read.
            const missingWitnessEntry = replacement === "reused-inode" ? witnessName : targetName;
            if (!recovered && (phase === "missing-witness" && entryName === missingWitnessEntry
              || phase === "witness-metadata" && entryName === witnessName
              || (phase === "missing-temp" || phase === "unlink-alias") && entryName === tempName)) {
              await recoverAndReplace();
              if (phase === "witness-metadata" && entry) return Object.freeze({ ...entry, canonical: false });
              return phase === "unlink-alias" || phase === "missing-witness" && replacement !== "reused-inode" ? entry : undefined;
            }
            if (entry && entryName === targetName && recovered && replacement === "device") {
              return Object.freeze({ ...entry, identity: Object.freeze({ ...entry.identity, device: entry.identity.device + BigInt(1) }) });
            }
            if (entry && entryName === targetName && recovered && replacement === "reused-inode") {
              return Object.freeze({ ...entry, identity: originalIdentity });
            }
            return entry;
          }, async readEntry(entryName: string, maximumBytes: number) {
            if (!recovered && phase === "witness-read" && entryName === witnessName) await recoverAndReplace();
            const read = await base.readEntry(entryName, maximumBytes);
            // Simulate ext4 reusing dev+ino while preserving real replacement bytes.
            if (recovered && replacement === "reused-inode" && entryName === targetName) {
              return Object.freeze({ ...read, entry: Object.freeze({ ...read.entry, identity: originalIdentity }) });
            }
            if (recovered && replacement === "device" && entryName === targetName) {
              return Object.freeze({ ...read, entry: Object.freeze({ ...read.entry,
                identity: Object.freeze({ ...read.entry.identity, device: originalIdentity.device + BigInt(1) }) }) });
            }
            return read;
          } });
        });
        const started = performance.now();
        await assert.rejects(slow.readHistory(), /installation_plan_journal_unavailable/);
        assert.equal(recovered, true);
        assert.ok(performance.now() - started < 1_000, "a changed target must refuse without settling");
      } finally { await f.cleanup(); }
    });
  }
}

test("recovery verifies the observed plan before removing publication evidence", async t => {
  for (const variant of ["read-device", "read-inode", "read-link-count", "witness-digest"] as const) await t.test(variant, async () => {
    const f = await fixture();
    try {
      const plan = create(), targetName = name(f.installationId, 0);
      const tempName = `${f.installationId}.installation-plan.revision-0000000000.88888888-8888-4888-8888-888888888888.tmp`;
      const witnessName = `${f.installationId}.installation-plan.revision-0000000000.publish.json`;
      await writeFile(join(f.root, tempName), `${canonicalJson(plan)}\n`, { mode: 0o600 });
      await link(join(f.root, tempName), join(f.root, targetName));
      await writeFile(join(f.root, witnessName), `${canonicalJson({ schema: "control-room.installation-plan-publication/v1",
        revision: 0, tempName, planDigest: variant === "witness-digest" ? create("changed").planDigest : plan.planDigest })}\n`,
      { mode: 0o600 });
      const before = (await readdir(f.root)).sort();
      let observed = false;
      const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root, installationId: f.installationId,
        ownerUid: process.getuid!() }, async request => {
        const base = await openInstallationPlanFilesystemStorageSessionV1(request);
        return Object.freeze({ ...base, async readEntry(entryName: string, maximumBytes: number) {
          const read = await base.readEntry(entryName, maximumBytes);
          if (!observed && entryName === targetName) {
            observed = true;
            return Object.freeze({ ...read, entry: Object.freeze({ ...read.entry,
              ...(variant === "read-link-count" ? { linkCount: 3 } : {}),
              identity: Object.freeze({ ...read.entry.identity,
                ...(variant === "read-device" ? { device: read.entry.identity.device + BigInt(1) } : {}),
                ...(variant === "read-inode" ? { inode: read.entry.identity.inode + BigInt(1) } : {}) }) }) });
          }
          return read;
        } });
      });
      await assert.rejects(journal.readHistory(), /installation_plan_journal_unavailable/);
      assert.equal(observed, true);
      assert.deepEqual((await readdir(f.root)).sort(), before, "refusal must preserve the temp and witness");
      assert.equal((await lstat(join(f.root, targetName))).nlink, 2);
    } finally { await f.cleanup(); }
  });
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
