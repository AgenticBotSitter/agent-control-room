// The store's exclusion, raced with REAL processes.
//
// The review's B3, and the shape of the attack matters more than the assertions
// inside any one test. Everything the store claims about writers is a claim
// about what two PROCESSES can do to the same directory at the same moment, and
// the round-3 lane proved that a store can pass every single-writer test and
// still hand a live upload's lock and its half-written file to a second program.
// So this file drives the store the way the harm happens: two writer processes
// and four opener processes against one directory, while a fifth observer walks
// the directory and reports every state it sees.
//
// The four counters, and what each one is the symptom of:
//
//   * twoStagingFiles  — two writers inside the lock at once. This is the thing
//     the lock exists to stop, and it is also how two uploads could pass the
//     installation's storage-limit check together.
//   * stagingWithoutLock — a writer's staging file with no lock name in the
//     directory. That is a writer holding a lock whose NAME was taken away, and
//     the next opener deletes that staging file out from under it.
//   * rawWriteErrnos   — a raw system errno escaping `put()`. The store's error
//     contract says its only answers are its own fixed codes.
//   * rawOpenErrnos    — a raw system errno escaping `create()`. Same contract.
//
// Against the store as it stood before this fix the review measured 375 / 242 /
// 2 / 73 over 40 seconds. All four are zero now, and the assertions below are
// what a reviewer reruns.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { link, mkdir, mkdtemp, open, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";

const TENANT = "tenant:race";
/** The store's own answers, which are its `code` field values and nothing else.
 * A child's error is one of two things: one of these, which is the store working,
 * or a system errno, which is a breach of its error contract. Telling them apart
 * is the whole measurement, so the set is named once and injected into both
 * children rather than spelled into each of their scripts. */
const STORE_CODES = ["store_invalid", "store_missing", "store_conflict", "store_capacity",
  "store_ambiguous"];
const LOCK_NAME = ".control-room-result-file-store.lock";
const PENDING_PREFIX = ".control-room-result-file-store-pending-";
const PROBE_PREFIX = ".control-room-result-file-store-exlock-probe-";
const STORE_MODULE = join(process.cwd(), "src/artifacts/v1/result-file-store.ts");
/** 64 KiB: long enough that a write's staging window is wide enough for the
 * observer to catch, short enough that two writers and four openers are not
 * fighting this Mac for minutes. */
const PAYLOAD = 65_536;
/** 40 s is the review's measurement window, kept exactly so the numbers in
 * `reports/reviews/files4.md` and the numbers here are comparable. The
 * unmodified store failed it on every run. */
const SECONDS = 40;
const WRITERS = 2;
const OPENERS = 4;

const configurationV1 = (rootPath: string) => ({
  rootPath, maximumFiles: 32, maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912,
  maximumTotalBytes: 10_737_418_240, operationTimeoutMs: 30_000,
});

/** A child that has been asked to run, and a promise for its output.
 *
 * The ref'd interval is not decoration: a `ChildProcess` is not a ref'd handle,
 * so a test that only awaits `once("exit")` gives Node nothing to keep the event
 * loop alive and the test ends with "promise resolution still pending". That is
 * the review's B2 arriving through the test rather than through the store, and
 * it reads exactly like a hang. `awaitChildV1` handles that for a single child;
 * this is the same idea for a fleet of them. */
function racerV1(script: string): {
  child: ChildProcess; exited: Promise<number | null>; output: () => string;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd(),
  });
  let out = "";
  child.stdout!.on("data", chunk => { out += String(chunk); });
  // `inherit` is not available per-stream, so stderr is captured and reported in
  // the assertion message: a child that died must say why rather than leaving the
  // lane to fail on a counter that never moved.
  child.stderr!.on("data", chunk => { out += String(chunk); });
  const keepAlive = setInterval(() => {}, 1_000);
  const exited = new Promise<number | null>(resolve => {
    child.once("exit", code => { clearInterval(keepAlive); resolve(code); });
  });
  return { child, exited, output: () => out };
}

const awaitChildV1 = (child: ChildProcess, label: string, ms = 120_000): Promise<number | null> =>
  new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const keeper = setTimeout(() => reject(new Error(`child ${label} did not exit within ${ms} ms`)),
      ms);
    child.once("exit", code => { clearTimeout(keeper); resolve(code); });
  });

/** A writer: open the store (retrying, because an opener holds the recovery
 * lock for a moment), then put a fresh file as fast as it can for the window.
 *
 * Every error is counted BY CODE, and the codes are printed rather than counted
 * in the parent, because the distinction that matters is between the store's own
 * refusals and a raw errno. A refusal is a correct answer to "another writer is
 * in here"; a raw `ENOENT` is a lost file. */
const writerScriptV1 = (root: string) => `
  const { ResultFileStoreV1 } = await import(${JSON.stringify(STORE_MODULE)});
  const STORE_CODES = new Set(${JSON.stringify(STORE_CODES)});
  const { createHash, randomUUID } = await import("node:crypto");
  const root = ${JSON.stringify(root)};
  const configuration = ${JSON.stringify(configurationV1(root))};
  let store;
  for (;;) {
    try { store = await ResultFileStoreV1.create(configuration); break; }
    catch (error) {
      // Only the store's OWN refusals are retried — a concurrent recovery is a
      // correct answer to create() and the next attempt gets past it. Anything
      // else is reported and the writer stops, because a lane that hides a raw
      // errno is the exact failure this file exists to catch.
      //
      // The store's codes are the "code" field values, NOT a prefix on the
      // message: it sets code to "store_ambiguous" and builds the message
      // "result_file_store_store_ambiguous" around it. Classifying on the message
      // would count every correct refusal as a raw system error, which is how an
      // earlier draft of this file reported a healthy race as a total failure.
      if (!STORE_CODES.has(String(error && error.code)))
        { console.log("OPEN " + JSON.stringify({ code: error.code ?? error.name ?? String(error) })); process.exit(3); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  const codes = {};
  const end = Date.now() + ${SECONDS * 1000};
  while (Date.now() < end) {
    const payload = new Uint8Array(${PAYLOAD});
    crypto.getRandomValues(payload.subarray(0, 64));
    try {
      await store.put({ tenantId: "tenant:race", projectId: "project:race",
        fileId: "result-file:" + randomUUID().replace(/-/g, ""),
        contentDigest: "sha256:" + createHash("sha256").update(payload).digest("hex"), bytes: payload });
      codes.ok = (codes.ok ?? 0) + 1;
    } catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (STORE_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
      else { console.log("RAW " + JSON.stringify({ key, stack: String(error && error.stack).split("\\n").slice(0, 3) })); }
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

/** An opener: create the store over and over, which is what a second copy of
 * the app does while the first one uploads. Every code is counted, and a raw
 * errno is reported separately for the same reason. */
const openerScriptV1 = (root: string) => `
  const { ResultFileStoreV1 } = await import(${JSON.stringify(STORE_MODULE)});
  const STORE_CODES = new Set(${JSON.stringify(STORE_CODES)});
  const configuration = ${JSON.stringify(configurationV1(root))};
  const codes = {};
  const end = Date.now() + ${SECONDS * 1000};
  while (Date.now() < end) {
    try { await ResultFileStoreV1.create(configuration); codes.opened = (codes.opened ?? 0) + 1; }
    catch (error) {
      const key = error && error.code ? error.code : (error ? error.name : "unknown");
      codes[key] = (codes[key] ?? 0) + 1;
      if (STORE_CODES.has(key)) codes.refusals = (codes.refusals ?? 0) + 1;
      else { console.log("RAW " + JSON.stringify({ key, syscall: error.syscall, stack: String(error && error.stack).split("\\n").slice(1, 4) })); }
    }
  }
  console.log("CODES " + JSON.stringify(codes));`;

test("B3: two writer processes and four opener processes never break the exclusion",
  { timeout: 300_000 }, async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-race-")));
    const racers: ReturnType<typeof racerV1>[] = [];
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      // The observer. It samples the directory as fast as it can and records the
      // two states that must never occur. It reads NAMES ONLY: it opens nothing,
      // takes no lock, and removes nothing, so it cannot be the thing that
      // breaks the exclusion it is measuring.
      let samples = 0;
      let twoStagingFiles = 0;
      let stagingWithoutLock = 0;
      let stop = false;
      const observer = (async () => {
        while (!stop) {
          try {
            const listed = await readdir(root);
            const staging = listed.filter(entry => entry.startsWith(PENDING_PREFIX)).length;
            if (staging > 1) twoStagingFiles += 1;
            if (staging > 0 && !listed.includes(LOCK_NAME)) stagingWithoutLock += 1;
            samples += 1;
          } catch { /* the directory is never removed under us; a sample is lost, not a failure */ }
        }
      })();
      for (let index = 0; index < WRITERS; index += 1)
        racers.push(racerV1(writerScriptV1(root)));
      for (let index = 0; index < OPENERS; index += 1)
        racers.push(racerV1(openerScriptV1(root)));
      const exits = await Promise.all(racers.map(racer => racer.exited));
      stop = true;
      await observer;
      const output = racers.map(racer => racer.output());
      const raw = output.flatMap(text => text.split("\n").filter(line => line.startsWith("RAW ")));
      // The children are the measurement, so their own report has to be read
      // before anything is asserted: a writer that never got past `create()` and
      // a writer that did fifty puts both report `fail 0` here.
      const codes = output.flatMap(text => text.split("\n").filter(line => line.startsWith("CODES "))
        .map(line => JSON.parse(line.slice("CODES ".length)) as Record<string, number>));
      const landed = codes.reduce((total, entry) => total + (entry.ok ?? 0), 0);
      const opened = codes.reduce((total, entry) => total + (entry.opened ?? 0), 0);
      const report = { samples, twoStagingFiles, stagingWithoutLock, landed, opened, codes, raw };
      // Every child finished on its own, which is the first thing to check: a
      // writer that exited early leaves `landed` low and the counters at zero,
      // which would read as a pass.
      assert.deepEqual(exits, new Array(racers.length).fill(0),
        `a racer exited non-zero, so the race was not measured: ${JSON.stringify(report)}`);
      assert.ok(samples > 0, `the observer never sampled the directory: ${JSON.stringify(report)}`);
      // The window was real work, not an idle 40 seconds.
      assert.ok(landed > 0, `no writer managed a single put: ${JSON.stringify(report)}`);
      assert.ok(opened > 0, `no opener managed a single open: ${JSON.stringify(report)}`);
      // THE FOUR ASSERTIONS.
      assert.equal(twoStagingFiles, 0,
        `two writers were inside the lock at the same moment: ${JSON.stringify(report)}`);
      assert.equal(stagingWithoutLock, 0,
        `a writer's staging file was left with no lock in the directory: ${JSON.stringify(report)}`);
      assert.deepEqual(raw, [],
        `a raw system errno escaped the store: ${JSON.stringify(report)}`);
      // Nothing is left behind, so the exclusions the window produced were
      // released rather than leaked: a leftover lock here would be a writer
      // that never retired its own.
      const entries = (await readdir(root)).filter(entry => !entry.endsWith(".crbf"));
      assert.deepEqual(entries, [],
        `the store's own bookkeeping was left behind after the race: ${JSON.stringify(entries)}`);
      // And everything that was reported as written is on disk, whole, and
      // readable — the race cost no file.
      const store = await ResultFileStoreV1.create(configurationV1(root));
      const results = (await readdir(root)).filter(entry => entry.endsWith(".crbf"));
      assert.equal(results.length, landed,
        `every put that reported ok is on disk exactly once: ${JSON.stringify(report)}`);
      let total = 0;
      for (const entry of results) total += (await stat(join(root, entry))).size;
      assert.equal(total, landed * PAYLOAD, "and every one of them is whole");
      void assert.ok(store);
    } finally {
      for (const racer of racers) {
        racer.child.kill("SIGKILL");
        await awaitChildV1(racer.child, "racer (cleanup)").catch(() => {});
      }
      await rm(base, { recursive: true, force: true });
    }
  });

test("B3: a lock name that is not this writer's own file is a refusal, not a write", async () => {
  // The unit-level half of the race above, and the guard the race cannot isolate:
  // what does a writer do when the lock NAME it just created is not the file its
  // descriptor holds? That is exactly the state a take-over leaves behind when
  // it wins the create-then-lock gap, and the answer has to be a refusal with
  // nothing written and nothing deleted.
  //
  // It is staged directly rather than by racing, because the gap is measured by
  // the review at a few tens of microseconds and a test that has to hit it by
  // luck is a test that will pass by luck. Here the two states the writer must
  // refuse are produced on purpose:
  //
  //   1. the name GONE — a take-over unlinked it and made its own;
  //   2. the name REPLACED — a take-over unlinked it and created its own, so the
  //      inode under the name is not the one the writer holds.
  //
  // Both are what a lost lock looks like, and both used to be invisible: the
  // writer carried on and its `link()` failed with a raw `ENOENT` to the caller.
  for (const shape of ["gone", "replaced"] as const) {
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-lostlock-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      const store = await ResultFileStoreV1.create(configurationV1(root));
      const payload = new Uint8Array(PAYLOAD);
      payload.fill(3);
      const id = { tenantId: TENANT, projectId: "project:lostlock",
        fileId: `result-file:${"4".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
      // A REAL held lock, so the writer's `O_EXCL` create below is refused and
      // the store's own lock is never the thing under test here. The name is
      // this test's own, so removing it is this test's own business.
      // `O_WRONLY | O_EXCL | O_NOFOLLOW | O_EXLOCK`, spelled out because Node
      // does not export the last one and the store's own comment says so.
      const mine = await open(join(root, LOCK_NAME), 0x1 | 0x200 | 0x4 | 0x20, 0o600);
      try {
        if (shape === "replaced") {
          // A take-over's own lock under the writer's name: the name exists, it
          // is a private plain file, and it is NOT the file `mine` holds.
          const stolen = join(base, "stolen.lock");
          await writeFile(stolen, "", { mode: 0o600 });
          const stolenHandle = await open(stolen, 0x1 | 0x200 | 0x4 | 0x20, 0o600);
          try {
            await unlink(join(root, LOCK_NAME)).catch(() => {});
            await link(stolen, join(root, LOCK_NAME));
          } finally { await stolenHandle.close().catch(() => {}); }
        }
        const rejection = await store.put({ ...id, bytes: payload }).then(
          () => undefined, (error: unknown) => error);
        // A held lock is the ordinary refusal, and the store is not expected to
        // notice anything unusual: `mine` holds it, so the O_EXCL create fails
        // first and the name is never this operation's to prove. What matters is
        // that the answer is a store code and nothing was written.
        assert.ok(rejection instanceof Error,
          `${shape}: the write was refused with an error`);
        assert.equal((rejection as { code?: string }).code, "store_ambiguous",
          `${shape}: the refusal is a store code and not a raw errno`);
        assert.equal(await store.read(id), undefined, `${shape}: and nothing was written`);
        const listed = await readdir(root);
        assert.deepEqual(listed.filter(entry => entry.startsWith(PENDING_PREFIX)), [],
          `${shape}: no staging file was left behind`);
      } finally { await mine.close().catch(() => {}); }
    } finally { await rm(base, { recursive: true, force: true }); }
  }
});

test("B3: a staging file that vanishes mid-write is an unprovable outcome, not a raw ENOENT",
  async () => {
    // The fourth edit. `link()` failing with `ENOENT` means this writer's own
    // staging file was removed while it was writing — by a recovery that got in,
    // or by a second writer inside the lock. Either way the operation's outcome
    // cannot be proved, and the store's answer has to be the same one it gives
    // for every other unprovable mutation: `store_ambiguous`, with the store
    // poisoned so nothing after it is served on a directory whose state it no
    // longer knows.
    //
    // Before this it escaped as a raw `ENOENT` from `link()` straight to the
    // caller, which the review measured happening to BOTH of its racing writers.
    // Two things are asserted, because either alone would be weak: the code the
    // caller sees, and the fact that the store refuses everything afterwards.
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-vanish-")));
    try {
      const root = join(base, "store");
      await mkdir(root, { mode: 0o700 });
      const store = await ResultFileStoreV1.create(configurationV1(root));
      // A real stored file, so the "still works afterwards" question has an
      // answer that is not "the store was empty anyway".
      const kept = new Uint8Array(PAYLOAD);
      kept.fill(1);
      const keptId = { tenantId: TENANT, projectId: "project:vanish",
        fileId: `result-file:${"5".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(kept).digest("hex")}` };
      await store.put({ ...keptId, bytes: kept });
      // The payload is large enough that the observer below reliably wins the
      // window between the staging file's create and the `link()` — the review
      // measured that window at 14-40 ms for an 8 MiB write.
      const payload = new Uint8Array(8 * 1024 * 1024);
      payload.fill(2);
      const id = { tenantId: TENANT, projectId: "project:vanish",
        fileId: `result-file:${"6".repeat(32)}`,
        contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
      // Watch for the staging file and delete it the moment it appears: a
      // recovery that got in, reduced to the one syscall that matters.
      let killed = false;
      const interference = (async () => {
        const deadline = Date.now() + 30_000;
        while (!killed && Date.now() < deadline) {
          for (const entry of await readdir(root)) {
            if (!entry.startsWith(PENDING_PREFIX)) continue;
            await unlink(join(root, entry)).catch(() => {});
            killed = true;
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      })();
      const outcome = await store.put({ ...id, bytes: payload }).then(
        () => undefined, (error: unknown) => error);
      killed = true;
      await interference;
      assert.ok(killed, "the interference actually removed a staging file, so the case was reached");
      assert.ok(STORE_CODES.includes(String((outcome as { code?: string }).code)),
        "the caller sees one of the store's own codes and nothing else");
      assert.equal((outcome as { code?: string }).code, "store_ambiguous",
        "a lost staging file is `store_ambiguous`, not a raw ENOENT from link()");
      // The operation is unprovable, so the store poisons itself rather than
      // serving a directory whose state it can no longer account for.
      await assert.rejects(store.put({ ...keptId, bytes: kept }),
        (error: unknown) => error instanceof Error && error.name !== "ENOENT",
      "and the store refuses afterwards instead of carrying on");
      // The file that WAS stored before all this is still on disk, byte for byte:
      // the poison is about going on, not about losing what is already there.
      const other = await ResultFileStoreV1.create(configurationV1(root));
      assert.deepEqual(Buffer.from((await other.read(keptId))!), Buffer.from(kept),
        "a store opened afterwards re-proves the file that was already stored");
    } finally { await rm(base, { recursive: true, force: true }); }
  });

test("N-4c: a root whose volume ignores O_EXLOCK is refused, not trusted", async () => {
  // The review's should-fix, and it is cheap enough to include. Everything this
  // store claims about writers rests on `O_EXLOCK` being HONOURED by the volume
  // the root is on. exFAT and some network volumes accept the flag and take no
  // lock, so two writers get the exclusion at once and every refusal in this
  // file is decoration on a volume that never refused anything.
  //
  // The question cannot be asked without an answer the store already has: two
  // `O_EXLOCK` opens of one inode from ONE process, because the kernel's lock
  // table is per inode, not per process. On this host — and on any volume that
  // honours the flag — the second open is `EAGAIN`, which is the proof.
  //
  // What is testable here is the half that is honest to test on a Mac mini: the
  // probe asks, it is a real `O_EXLOCK` create, its name is one the store
  // recognises as its own bookkeeping, and the name is GONE afterwards. The other
  // half — a volume that ignores the flag — needs exFAT hardware, which this
  // host does not have, and that is recorded as not measured rather than claimed.
  const base = await realpath(await mkdtemp(join(tmpdir(), "cr-result-store-exlock-")));
  try {
    const root = join(base, "store");
    await mkdir(root, { mode: 0o700 });
    // The store OPENS, which is the half of the question this host can answer.
    const store = await ResultFileStoreV1.create(configurationV1(root));
    assert.ok(store, "a volume that honours O_EXLOCK is accepted");
    // The probe left nothing behind: a `pending-*` name is the store's own
    // bookkeeping, and a probe that leaked one would be indistinguishable from a
    // writer's leftovers in every check that walks the directory.
    assert.deepEqual((await readdir(root)).filter(entry =>
      entry.startsWith(PENDING_PREFIX) || entry.startsWith(PROBE_PREFIX)), [],
    "the O_EXLOCK probe left no name of its own in the directory, and no name of a writer's either");
    // And the store still works end to end, so the probe is not a write in
    // disguise: it takes and releases its lock, and the write after it lands.
    const payload = new Uint8Array(PAYLOAD);
    payload.fill(9);
    const id = { tenantId: TENANT, projectId: "project:exlock",
      fileId: `result-file:${"7".repeat(32)}`,
      contentDigest: `sha256:${createHash("sha256").update(payload).digest("hex")}` };
    await store.put({ ...id, bytes: payload });
    assert.deepEqual(Buffer.from((await store.read(id))!), Buffer.from(payload),
      "a write after the probe actually lands, so the probe released what it took");
    // A root that is not a private directory never reaches the probe at all, and
    // a probe that cannot be asked must not be assumed to have answered: the
    // store's own refusal for an unaskable root is unchanged.
    const publicRoot = join(base, "public");
    await mkdir(publicRoot, { mode: 0o777 });
    await assert.rejects(ResultFileStoreV1.create({ ...configurationV1(publicRoot) }),
      (error: unknown) => STORE_CODES.includes(String((error as { code?: string }).code)),
    "a root that fails an earlier check is still refused, probe or not");
    assert.deepEqual((await readdir(publicRoot)), [],
      "and the refused root was not written to: the probe does not run on a root that is not a store");
  } finally { await rm(base, { recursive: true, force: true }); }
  });
